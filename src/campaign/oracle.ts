/**
 * Where view counts come from.
 *
 * **The platform's API, never the creator.** That is the whole rule. A count
 * supplied by the person being paid is not evidence, and accepting one would
 * make the dwell mechanic decorative — an attacker would simply report a big
 * number twice.
 *
 * Every failure resolves to `undefined`, meaning *"could not tell"*, which the
 * rest of the system treats as different from zero. A zero would look like a
 * clip nobody watched and could silently reduce a payout; "could not tell"
 * leaves the last good snapshot standing and lets the gate decide on that.
 */

import type { PostRef } from './postref';
import type { CountOracle } from './verify';
import { CircleCliPayer, XMarketplaceOracle } from './xoracle';
import type { ViewOracle } from './tick';
import type { Submission } from './types';

const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3/videos';

export interface OracleOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Surfaced so a quota exhaustion is visible rather than silent. */
  log?: (line: string) => void;
}

/**
 * YouTube Data API v3.
 *
 * One unit per call against a 10,000/day quota, and that quota cannot be
 * raised by enabling billing — only by passing a compliance audit. So the
 * number of clips a campaign can track per day has a hard ceiling, and it is
 * recorded in ARCHITECTURE §4 rather than discovered in production.
 */
export class YouTubeOracle implements CountOracle {
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;

  constructor(private readonly options: OracleOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? (() => {});
  }

  async count(ref: { platform: string; postId: string }): Promise<bigint | undefined> {
    if (ref.platform !== 'youtube') return undefined;
    const batch = await this.batchCount([ref.postId]);
    return batch[ref.postId];
  }

  /**
   * Batch view fetching for up to 50 YouTube videos in a single HTTP request.
   * Reduces API quota consumption by up to 98%.
   */
  async batchCount(videoIds: string[]): Promise<Record<string, bigint | undefined>> {
    const results: Record<string, bigint | undefined> = {};
    if (!videoIds.length) return results;

    // Deduplicate and chunk into max 50 IDs per request
    const uniqueIds = Array.from(new Set(videoIds));
    const chunks: string[][] = [];
    for (let i = 0; i < uniqueIds.length; i += 50) {
      chunks.push(uniqueIds.slice(i, i + 50));
    }

    for (const chunk of chunks) {
      const params = new URLSearchParams({
        part: 'statistics',
        id: chunk.join(','),
        key: this.options.apiKey,
      });

      let response: Response;
      try {
        response = await this.fetchImpl(`${YOUTUBE_API}?${params}`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        this.log(`youtube batch: unreachable — ${(error as Error).message}`);
        chunk.forEach(id => { results[id] = undefined; });
        continue;
      }

      if (!response.ok) {
        if (response.status === 403) {
          this.log(`youtube: 403 for ${chunk.join(',')} — quota exhausted or key restricted`);
        } else {
          this.log(`youtube batch: HTTP ${response.status}`);
        }
        chunk.forEach(id => { results[id] = undefined; });
        continue;
      }

      const body = (await response.json().catch(() => ({}))) as {
        items?: { id?: string; statistics?: { viewCount?: string } }[];
      };

      const found = new Set<string>();
      for (const item of body.items ?? []) {
        const itemId = item.id || (chunk.length === 1 ? chunk[0] : undefined);
        if (!itemId) continue;
        found.add(itemId);
        const raw = item.statistics?.viewCount;
        if (raw !== undefined) {
          try {
            const v = BigInt(raw);
            results[itemId] = v >= 0n ? v : undefined;
          } catch {
            results[itemId] = undefined;
          }
        } else {
          results[itemId] = undefined;
        }
      }

      // Mark IDs not returned by YouTube as undefined
      for (const id of chunk) {
        if (!found.has(id)) results[id] = undefined;
      }
    }

    return results;
  }
}

/**
 * X, deliberately unimplemented.
 *
 * The API went pay-per-use in February 2026 — roughly $0.005 per post read,
 * with no free tier for new developers — so it needs a funded account that
 * does not exist yet. Returning `undefined` is the honest state: X submissions
 * are accepted and simply never accrue a confirmed count, which the gate
 * reports as `dwell_unmet` rather than as a rejection.
 */
export class XOracleUnavailable implements CountOracle {
  async count(): Promise<undefined> {
    return undefined;
  }
}

/** Routes to whichever platform a submission is on. */
export class PlatformOracle implements CountOracle, ViewOracle {
  constructor(private readonly byPlatform: Record<string, CountOracle>) {}

  async count(ref: { platform: string; postId: string }): Promise<bigint | undefined> {
    return this.byPlatform[ref.platform]?.count(ref);
  }

  /** Batch view fetching across submissions on the same platform. */
  async batchFetch(submissions: Submission[]): Promise<Map<string, bigint | undefined>> {
    const results = new Map<string, bigint | undefined>();
    const ytOracle = this.byPlatform['youtube'] as YouTubeOracle | undefined;

    if (ytOracle && typeof ytOracle.batchCount === 'function') {
      const ytSubs = submissions.filter(s => s.platform === 'youtube');
      if (ytSubs.length) {
        const ids = ytSubs.map(s => s.postId);
        const counts = await ytOracle.batchCount(ids);
        for (const s of ytSubs) {
          results.set(s.submissionId, counts[s.postId]);
        }
      }
    }

    // Fallback for non-batched platforms or missing batch oracle
    for (const s of submissions) {
      if (!results.has(s.submissionId)) {
        const val = await this.count({ platform: s.platform, postId: s.postId });
        results.set(s.submissionId, val);
      }
    }

    return results;
  }

  /** The `ViewOracle` shape the tick loop uses. */
  async fetch(submission: Submission): Promise<bigint | undefined> {
    return this.count({ platform: submission.platform, postId: submission.postId });
  }
}

/**
 * Build from the environment.
 *
 * Returns `undefined` when no key is configured, so the caller reports "no
 * oracle" rather than quietly substituting one that always says zero.
 */
export function oracleFromEnv(
  env: Record<string, string | undefined> = Bun.env,
  fetchImpl?: typeof fetch,
): PlatformOracle | undefined {
  const key = env.YOUTUBE_API_KEY?.trim();
  if (!key) return undefined;

  // X view counts are bought per call from the Circle Agent Marketplace,
  // because X's own API cannot answer for someone else's tweet at any tier.
  // Off unless a wallet is configured to pay from: an oracle that cannot pay
  // reports "not observed" for every post, which is correct but expensive to
  // discover at settlement time.
  const payFrom = env.CAMPAIGN_WALLET?.trim();
  const x = payFrom && env.X_ORACLE !== 'off'
    ? new XMarketplaceOracle({ payer: new CircleCliPayer(payFrom) })
    : new XOracleUnavailable();

  return new PlatformOracle({
    youtube: new YouTubeOracle({ apiKey: key, fetchImpl }),
    x,
  });
}

export type { PostRef };
