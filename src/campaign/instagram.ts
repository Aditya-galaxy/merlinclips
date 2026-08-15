/**
 * Instagram view counts, via the account that owns the media.
 *
 * Instagram has no equivalent of YouTube's public statistics endpoint: there is
 * no call that answers "how many views does this reel have" for a reel you do
 * not own. Insights are first-party only — the owning account authorises an
 * app, and the app reads that account's own media. So unlike the YouTube
 * oracle, which needs one API key for the whole world, this needs one token
 * per creator.
 *
 * **Why that constraint is a feature.** A submitted URL is a shortcode a
 * stranger typed. To read its insights we must find that shortcode among the
 * media of an account we hold a token for, which means a creator cannot claim
 * someone else's reel: ownership is proven by the API rather than asserted by
 * the claimant. A shortcode belonging to nobody we hold a token for resolves to
 * `undefined` — "could not tell" — and the clip simply never accrues.
 *
 * **Tester mode.** A Meta app in development can call the API against accounts
 * holding a role on it, so a pilot works with real tokens and real numbers
 * before App Review. That is what this is for; the shape does not change when
 * the tokens later come from a reviewed OAuth flow rather than from config.
 *
 * Tokens are read from the environment and never written to the event log. The
 * log is hash-chained and derived on read by anything that can reach it, so a
 * token placed there would be published rather than stored.
 */

import type { CountOracle } from './verify';

const GRAPH = 'https://graph.instagram.com';

/**
 * Metric names, newest first.
 *
 * Meta consolidated reel metrics — `plays` and `video_views` folded into
 * `views` — and an unknown metric is a request error rather than an omitted
 * field. Asking for a retired name would therefore fail every call on an
 * account, silently, and look exactly like a clip nobody watched. Trying in
 * order costs one extra request on the first call of a deployment and removes
 * a class of failure that is invisible from the outside.
 */
const VIEW_METRICS = ['views', 'plays', 'video_views'] as const;

interface Media {
  readonly id: string;
  readonly shortcode: string;
}

export interface InstagramOracleOptions {
  /** One per authorising account. Tester tokens in a pilot, OAuth later. */
  readonly tokens: readonly string[];
  readonly fetchImpl?: typeof fetch;
  /** Surfaced so an expired token is visible rather than silent. */
  readonly log?: (line: string) => void;
  /**
   * How long a media listing stays good. The tick runs hourly and a creator
   * posts far less often than that, so re-listing per submission would spend
   * the rate limit re-learning the same thing.
   */
  readonly listingTtlMs?: number;
}

export class InstagramOracle implements CountOracle {
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly ttl: number;
  /** shortcode → { mediaId, token }, rebuilt when stale. */
  private index = new Map<string, { mediaId: string; token: string }>();
  private indexedAt = 0;
  private indexing?: Promise<void>;
  /** Learned once per process, then reused. */
  private metric?: string;

  constructor(private readonly options: InstagramOracleOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? (() => {});
    this.ttl = options.listingTtlMs ?? 15 * 60_000;
  }

  async count(ref: { platform: string; postId: string }): Promise<bigint | undefined> {
    if (ref.platform !== 'instagram') return undefined;

    await this.refreshIndex();
    const found = this.index.get(ref.postId);
    if (!found) {
      // Either not ours, or posted since the last listing. Both are "could not
      // tell": returning 0 here would read as a clip nobody watched and could
      // drag a confirmed count down through the dwell minimum.
      return undefined;
    }
    return this.insights(found.mediaId, found.token);
  }

  /**
   * Rebuild shortcode → media across every authorising account.
   *
   * Shared between concurrent callers: the tick fetches submissions in a loop,
   * and without this every one of them would rebuild the same index against
   * the same rate limit.
   */
  private async refreshIndex(): Promise<void> {
    if (Date.now() - this.indexedAt < this.ttl && this.index.size > 0) return;
    if (this.indexing) return this.indexing;

    this.indexing = (async () => {
      const next = new Map<string, { mediaId: string; token: string }>();
      for (const token of this.options.tokens) {
        for (const media of await this.mediaFor(token)) {
          // First token wins. Two accounts cannot hold the same shortcode, so
          // a collision means a token was configured twice — harmless, and not
          // worth failing a payout pass over.
          if (!next.has(media.shortcode)) {
            next.set(media.shortcode, { mediaId: media.id, token });
          }
        }
      }
      // Only replace a non-empty result. Every token failing at once is far
      // more likely to be a network blip than every creator deleting every
      // reel, and an emptied index turns "could not tell" into the answer for
      // clips we could read ten minutes ago.
      if (next.size > 0) {
        this.index = next;
        this.indexedAt = Date.now();
      }
    })().finally(() => {
      this.indexing = undefined;
    });

    return this.indexing;
  }

  /** Every media on the authorising account, following pagination. */
  private async mediaFor(token: string): Promise<Media[]> {
    const media: Media[] = [];
    let url: string | undefined =
      `${GRAPH}/me/media?fields=id,permalink&limit=100&access_token=${encodeURIComponent(token)}`;

    // Bounded rather than `while (url)`. A paging cursor that loops would
    // otherwise spin a payout pass until the request timeout.
    for (let page = 0; url && page < 10; page++) {
      const body = await this.get(url);
      if (!body) return media;

      for (const item of (body.data as Array<Record<string, unknown>>) ?? []) {
        const id = typeof item.id === 'string' ? item.id : undefined;
        const permalink = typeof item.permalink === 'string' ? item.permalink : undefined;
        const shortcode = permalink ? shortcodeOf(permalink) : undefined;
        if (id && shortcode) media.push({ id, shortcode });
      }

      const paging = body.paging as Record<string, unknown> | undefined;
      url = typeof paging?.next === 'string' ? paging.next : undefined;
    }
    return media;
  }

  /** The view count for one media, or undefined if it cannot be read. */
  private async insights(mediaId: string, token: string): Promise<bigint | undefined> {
    for (const metric of this.metric ? [this.metric] : VIEW_METRICS) {
      const body = await this.get(
        `${GRAPH}/${mediaId}/insights?metric=${metric}&access_token=${encodeURIComponent(token)}`,
      );
      const value = firstValue(body);
      if (value !== undefined) {
        this.metric = metric;
        return value;
      }
    }
    return undefined;
  }

  /** A GET that resolves to undefined on every failure, never throws. */
  private async get(url: string): Promise<Record<string, unknown> | undefined> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      this.log(`instagram: request failed — ${(error as Error).message}`);
      return undefined;
    }

    if (!response.ok) {
      // 190 is an expired or revoked token, which a pilot hits when a tester
      // removes the app. Worth naming: it looks identical to a quiet clip from
      // the outside, and the fix is a person re-authorising.
      const detail = await response.text().catch(() => '');
      this.log(
        `instagram: ${response.status} — ${detail.slice(0, 200)}`
        + (detail.includes('"code":190') ? ' (token expired or revoked; re-authorise)' : ''),
      );
      return undefined;
    }

    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
}

/**
 * Instagram, when no account has authorised us.
 *
 * The same contract as the X oracle: submissions are accepted and never accrue
 * a confirmed count, which the gate reports as `dwell_unmet` rather than as a
 * rejection. This is the default, and it is what ships until tokens exist.
 */
export class InstagramOracleUnavailable implements CountOracle {
  async count(): Promise<undefined> {
    return undefined;
  }
}

/** The shortcode out of a permalink like https://www.instagram.com/reel/ABC/ */
export function shortcodeOf(permalink: string): string | undefined {
  const segments = permalink.split('?')[0]!.split('/').filter(Boolean);
  const at = segments.findIndex((s) => s === 'reel' || s === 'reels' || s === 'p' || s === 'tv');
  return at >= 0 ? segments[at + 1] : undefined;
}

/**
 * The number out of an insights response.
 *
 * Shaped `{data:[{values:[{value: N}]}]}`. Read defensively because a metric
 * that exists but is not populated for a media returns the envelope with no
 * values, and `undefined` has to survive that rather than becoming zero.
 */
function firstValue(body: Record<string, unknown> | undefined): bigint | undefined {
  const data = body?.data as Array<Record<string, unknown>> | undefined;
  const values = data?.[0]?.values as Array<Record<string, unknown>> | undefined;
  const value = values?.[0]?.value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return BigInt(Math.floor(value));
}

/**
 * Built only when tokens are configured — the flag is the presence of tokens.
 *
 * A separate on/off switch would allow the state where the oracle is enabled
 * and has nothing to read, which reports "could not tell" for every Instagram
 * clip and is indistinguishable from the platform being down.
 */
export function instagramFromEnv(
  env: Record<string, string | undefined> = Bun.env,
  fetchImpl?: typeof fetch,
): CountOracle {
  const tokens = (env.INSTAGRAM_TESTER_TOKENS ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return new InstagramOracleUnavailable();
  return new InstagramOracle({
    tokens,
    fetchImpl,
    log: (line) => console.warn(line),
  });
}
