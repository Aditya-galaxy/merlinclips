/**
 * View counts for X posts, bought per call from the Circle Agent Marketplace.
 *
 * X's own API cannot answer this. `non_public_metrics` is restricted by
 * definition to tweets owned by the authenticating account, and a clipper's
 * tweet is somebody else's — so no tier of the official API returns the number
 * this engine needs. Scraping was the obvious fallback and is worse than
 * useless here: payment is gated on `min()` across the dwell window, so a
 * blocked scraper returns a low reading and silently suppresses a payout that
 * was owed. A creator would see the same outcome as fraud detection working.
 *
 * The marketplace sells it instead. AIsa's `/apis/v2/twitter/tweets` takes a
 * batch of ids and returns `viewCount` among the engagement counts, at
 * $0.0022 a call, settled from the agent wallet's Gateway balance. One batched
 * call per tick covers every live X submission, so the cost scales with
 * campaigns rather than clips — about five cents a day.
 *
 * That also makes this the buying half of the agentic economy: an agent paying,
 * per call, for the data it needs to decide a payout it will then make.
 *
 * ## The one invariant that matters
 *
 * A failed lookup returns `undefined`, never `0`. Zero enters the dwell
 * minimum and permanently caps what a creator can be paid; `undefined` means
 * "not observed" and leaves the window alone. Every failure path below returns
 * undefined for that reason, and the tests exist mostly to hold that line.
 */

import type { CountOracle } from './verify';

/** Buys one paid call. Injected so this is testable without spending USDC. */
export interface MarketplacePayer {
  /**
   * @returns the response body, or undefined if the call could not be paid for
   *          or did not come back.
   */
  get(url: string): Promise<string | undefined>;
}

export const AISA_TWEETS_ENDPOINT = 'https://api.aisa.one/apis/v2/twitter/tweets';

/** What one call costs, for surfacing the verification cost against a pool. */
export const PRICE_PER_CALL_USDC = '0.0022';

interface AisaTweet {
  id?: string;
  viewCount?: number | string;
}

export interface XOracleOptions {
  readonly payer: MarketplacePayer;
  readonly endpoint?: string;
  readonly log?: (line: string) => void;
  /** Cap per tick, so a runaway loop cannot drain the Gateway balance. */
  readonly maxIdsPerCall?: number;
}

export class XMarketplaceOracle implements CountOracle {
  private readonly endpoint: string;
  private readonly log: (line: string) => void;
  private readonly maxIds: number;
  /** Counted so a deployment can see what verification is costing it. */
  public calls = 0;

  constructor(private readonly options: XOracleOptions) {
    this.endpoint = options.endpoint ?? AISA_TWEETS_ENDPOINT;
    this.log = options.log ?? (() => {});
    this.maxIds = options.maxIdsPerCall ?? 100;
  }

  async count(ref: { platform: string; postId: string }): Promise<bigint | undefined> {
    if (ref.platform !== 'x') return undefined;
    const batch = await this.batchCount([ref.postId]);
    return batch[ref.postId];
  }

  /**
   * One paid call for many posts.
   *
   * Ids are deduplicated first: the same post submitted twice must not be paid
   * for twice, and the batch is what the price is charged against.
   */
  async batchCount(postIds: string[]): Promise<Record<string, bigint | undefined>> {
    const out: Record<string, bigint | undefined> = {};
    const unique = [...new Set(postIds.filter((id) => /^\d+$/.test(id)))];
    if (unique.length === 0) return out;

    for (let i = 0; i < unique.length; i += this.maxIds) {
      const chunk = unique.slice(i, i + this.maxIds);
      // Every id starts as "not observed". Anything the response does not
      // account for stays that way rather than defaulting to zero.
      for (const id of chunk) out[id] = undefined;

      const url = `${this.endpoint}?tweet_ids=${encodeURIComponent(chunk.join(','))}`;
      let raw: string | undefined;
      try {
        this.calls += 1;
        raw = await this.options.payer.get(url);
      } catch (error) {
        this.log(`x oracle: paid call failed — ${(error as Error).message}`);
        continue;
      }
      if (!raw) {
        this.log('x oracle: no response body; leaving this window unobserved');
        continue;
      }

      let tweets: AisaTweet[] = [];
      try {
        const body = JSON.parse(raw) as { tweets?: AisaTweet[] };
        tweets = Array.isArray(body.tweets) ? body.tweets : [];
      } catch {
        this.log('x oracle: response was not JSON; leaving this window unobserved');
        continue;
      }

      for (const tweet of tweets) {
        const id = typeof tweet.id === 'string' ? tweet.id : undefined;
        if (!id || !(id in out)) continue;
        const views = tweet.viewCount;
        // A missing or unparseable count is not zero views. A post can also
        // genuinely have zero, which is why the check is on the shape of the
        // value rather than on its truthiness.
        if (views === undefined || views === null) continue;
        const n = typeof views === 'number' ? views : Number(views);
        if (!Number.isFinite(n) || n < 0) continue;
        out[id] = BigInt(Math.floor(n));
      }
    }
    return out;
  }
}

/**
 * Pays with the Circle CLI.
 *
 * Shells out to `circle services pay`, which carries the same constraint as
 * settlement: the CLI authenticates with an emailed OTP and keeps a session
 * that expires in about twenty days, so it cannot run inside the container.
 * On Cloud Run this reports the real reason rather than pretending the post
 * has no views.
 */
export class CircleCliPayer implements MarketplacePayer {
  constructor(
    private readonly fromAddress: string,
    private readonly log: (line: string) => void = () => {},
  ) {}

  async get(url: string): Promise<string | undefined> {
    const proc = Bun.spawn(
      ['circle', 'services', 'pay', url, '--address', this.fromAddress, '--output', 'json'],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    if (proc.exitCode !== 0) {
      this.log(`circle services pay failed (${proc.exitCode}): ${err.trim().slice(0, 200)}`);
      return undefined;
    }
    try {
      // The CLI wraps the service response; the body is what we asked for.
      const parsed = JSON.parse(out) as { data?: { body?: unknown }; body?: unknown };
      const body = parsed.data?.body ?? parsed.body ?? parsed;
      return typeof body === 'string' ? body : JSON.stringify(body);
    } catch {
      return out.trim() || undefined;
    }
  }
}
