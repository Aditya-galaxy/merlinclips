/**
 * How campaigns get opened and clips get submitted.
 *
 * Until this existed the repo was an engine, not a platform: every invariant
 * held, and the only way to exercise them was to write TypeScript. These are
 * the two doors — one for the brand funding a campaign, one for the creator
 * submitting work.
 *
 * The asymmetry between them is deliberate.
 *
 * **Opening a campaign is operator-gated.** It declares a pool, and a pool is
 * a promise to pay. Anyone who can create one can commit the operator's money.
 *
 * **Submitting a clip is public.** A creator has no account here and shouldn't
 * need one — the payout address *is* the identity, because it is the thing
 * that receives money. Requiring a signup before someone can be paid is the
 * friction this whole product exists to remove.
 *
 * Validation happens here rather than at the gate, because a refusal is only
 * kind if it arrives *before* the creator does the work. The gate's refusals
 * are for things we could not know in advance.
 */

import { Decimal } from '../decimal';
import { parsePostUrl } from './postref';
import { eligible } from './eligibility';
import { acceptSubmission, DEFAULT_SETTLEMENT_WINDOW_MS } from './terms';
import { MIN_DWELL_HOURS } from './views';

import type { Campaign, Creator, Platform, Submission } from './types';

export { MIN_DWELL_HOURS };

/** An EVM address, which is all a creator needs to be paid. */
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export interface OpenCampaignInput {
  campaignId?: string;
  brief?: unknown;
  poolUsdc?: unknown;
  cpmUsdc?: unknown;
  perCreatorCapUsdc?: unknown;
  minCpmUsdc?: unknown;
  maxCpmUsdc?: unknown;
  dwellHours?: unknown;
  settlementDays?: unknown;
  platforms?: unknown;
  chain?: unknown;
  fundingWallet?: unknown;
  endsAt?: unknown;
  /** The brand this campaign belongs to. */
  readonly ownerId?: string;
  /** Lowest standing accepted. Absent means open to anyone. */
  readonly minStanding?: string;
  /** Places held for creators with no record yet. Absent means computed. */
  readonly reservedForUnproven?: number;
}

export type Refusal = { ok: false; error: string; field?: string };
export type Accepted<T> = { ok: true; value: T };
export type Result<T> = Accepted<T> | Refusal;

const bad = (error: string, field?: string): Refusal => ({ ok: false, error, field });

/** Parse a USDC amount, refusing anything `Decimal` cannot represent exactly. */
function amount(raw: unknown, field: string): Result<Decimal> {
  if (raw === undefined || raw === null || raw === '') return bad(`${field} is required`, field);
  try {
    const value = new Decimal(String(raw));
    if (value.micro < 0n) return bad(`${field} cannot be negative`, field);
    return { ok: true, value };
  } catch (error) {
    // Decimal refuses >6dp rather than rounding someone's money. Say why.
    return bad(`${field}: ${(error as Error).message}`, field);
  }
}

const CHAINS = new Set(['base', 'base-sepolia', 'ethereum', 'eth-sepolia', 'polygon', 'polygon-amoy']);
const PLATFORMS = new Set<Platform>(['youtube', 'x']);

export function openCampaign(
  input: OpenCampaignInput,
  now: Date = new Date(),
): Result<Campaign> {
  const brief = typeof input.brief === 'string' ? input.brief.trim() : '';
  if (brief.length < 10) {
    return bad('brief must be at least 10 characters — it is what the agent judges against', 'brief');
  }

  /** Merlin Clips Minimum Rules: Pool >= $100.00 USDC, Creator Cap >= $10.00 USDC */
  const MIN_CAMPAIGN_POOL_USDC = new Decimal('100.00');
  const MIN_PER_CREATOR_CAP_USDC = new Decimal('10.00');

  const pool = amount(input.poolUsdc, 'poolUsdc');
  if (!pool.ok) return pool;
  if (!pool.value.isPositive()) return bad('poolUsdc must be greater than zero', 'poolUsdc');
  if (MIN_CAMPAIGN_POOL_USDC.gt(pool.value)) {
    return bad('poolUsdc must be at least 100.00 USDC (Merlin Clips minimum rule)', 'poolUsdc');
  }

  const cpm = amount(input.cpmUsdc, 'cpmUsdc');
  if (!cpm.ok) return cpm;
  const STANDINGS = new Set(['unproven', 'building', 'reliable', 'exceptional']);
  const minStanding = typeof input.minStanding === 'string' ? input.minStanding : undefined;
  if (minStanding && !STANDINGS.has(minStanding)) {
    return bad(
      'minStanding must be unproven, building, reliable or exceptional',
      'minStanding',
    );
  }
  const reserved = input.reservedForUnproven;
  if (reserved !== undefined
      && (typeof reserved !== 'number' || !Number.isFinite(reserved) || reserved < 0)) {
    return bad('reservedForUnproven must be zero or a positive whole number',
      'reservedForUnproven');
  }

  const perCreator = amount(input.perCreatorCapUsdc ?? pool.value.toString(), 'perCreatorCapUsdc');
  if (!perCreator.ok) return perCreator;
  if (MIN_PER_CREATOR_CAP_USDC.gt(perCreator.value)) {
    return bad('perCreatorCapUsdc must be at least 10.00 USDC (Merlin Clips minimum rule)', 'perCreatorCapUsdc');
  }
  const minCpm = amount(input.minCpmUsdc ?? cpm.value.toString(), 'minCpmUsdc');
  if (!minCpm.ok) return minCpm;
  const maxCpm = amount(input.maxCpmUsdc ?? cpm.value.toString(), 'maxCpmUsdc');
  if (!maxCpm.ok) return maxCpm;

  if (minCpm.value.gt(maxCpm.value)) {
    return bad('minCpmUsdc cannot exceed maxCpmUsdc', 'minCpmUsdc');
  }
  if (minCpm.value.gt(cpm.value) || cpm.value.gt(maxCpm.value)) {
    return bad('cpmUsdc must sit inside the rate band', 'cpmUsdc');
  }
  if (perCreator.value.gt(pool.value)) {
    // Not fatal in the engine, but it means the cap can never bind, which is
    // almost always a typo rather than an intention.
    return bad('perCreatorCapUsdc cannot exceed the pool', 'perCreatorCapUsdc');
  }

  const chain = typeof input.chain === 'string' ? input.chain : 'base';
  if (!CHAINS.has(chain)) {
    return bad(`chain must be one of ${[...CHAINS].join(', ')}`, 'chain');
  }

  const platforms = Array.isArray(input.platforms) && input.platforms.length > 0
    ? (input.platforms as Platform[])
    : (['youtube'] as Platform[]);
  for (const p of platforms) {
    if (!PLATFORMS.has(p)) {
      return bad(
        `platform "${p}" is not verifiable — YouTube and X only. Instagram, ` +
          'Facebook and TikTok need platform app review we do not hold.',
        'platforms',
      );
    }
  }

  // The floor is not a validation nicety — it is the product.
  //
  // A dwell of zero confirms views the instant they are reported, which is
  // precisely the behaviour every incumbent has and the reason a brand paid
  // $1,500 for 845,000 bot views. It would let a campaign disable the one
  // mechanic this platform exists for, while the platform continued telling
  // creators and brands that only cleared views get paid. That claim has to be
  // true of every campaign or it is not true at all.
  //
  // The ceiling matters less but is real: a dwell longer than a week is
  // indistinguishable from not paying, and the creator has already done the
  // work.
  const dwellHours = Number(input.dwellHours ?? 24);
  if (!Number.isFinite(dwellHours) || dwellHours < MIN_DWELL_HOURS || dwellHours > 168) {
    return bad(
      `dwellHours must be between ${MIN_DWELL_HOURS} and 168. Below ${MIN_DWELL_HOURS} the ` +
        'platform has not had time to remove inauthentic views, so a confirmed ' +
        'count means nothing',
      'dwellHours',
    );
  }

  const settlementDays = Number(input.settlementDays ?? 14);
  if (!Number.isFinite(settlementDays) || settlementDays <= 0) {
    return bad('settlementDays must be positive', 'settlementDays');
  }
  const settlementWindowMs = settlementDays * 86_400_000;
  if (settlementWindowMs <= dwellHours * 3_600_000) {
    // Otherwise the obligation expires before the views can even confirm, and
    // the guarantee to the creator is theatre.
    return bad(
      'settlementDays must outlast dwellHours, or a clip can expire before its ' +
        'views have had time to confirm',
      'settlementDays',
    );
  }

  // The wallet holding the budget. Checked for shape here; whether it holds
  // anything is a question for funding.ts, which reads the chain.
  const fundingWallet =
    typeof input.fundingWallet === 'string' ? input.fundingWallet.trim() : undefined;
  if (fundingWallet && !ADDRESS.test(fundingWallet)) {
    return bad('fundingWallet must be a 0x-prefixed 40-character address', 'fundingWallet');
  }

  const endsAt = typeof input.endsAt === 'string' ? input.endsAt : undefined;
  const endsAtMs = endsAt ? Date.parse(endsAt) : now.getTime() + 30 * 86_400_000;
  if (Number.isNaN(endsAtMs)) return bad('endsAt is not a valid date', 'endsAt');
  if (endsAtMs <= now.getTime()) return bad('endsAt must be in the future', 'endsAt');

  return {
    ok: true,
    value: {
      campaignId: (input.campaignId ?? `camp-${crypto.randomUUID().slice(0, 8)}`).trim(),
      brief,
      poolUsdc: pool.value,
      cpmUsdc: cpm.value,
      rateBand: { minUsdc: minCpm.value, maxUsdc: maxCpm.value },
      perCreatorCapUsdc: perCreator.value,
      dwellMs: dwellHours * 3_600_000,
      settlementWindowMs: settlementWindowMs || DEFAULT_SETTLEMENT_WINDOW_MS,
      platforms,
      chain: chain as Campaign['chain'],
      fundingWallet,
      ownerId: typeof input.ownerId === 'string' ? input.ownerId.trim() : undefined,
      minStanding: minStanding as Campaign['minStanding'],
      reservedForUnproven: reserved,
      status: 'active',
      startsAt: now.toISOString(),
      endsAt: new Date(endsAtMs).toISOString(),
    },
  };
}

export interface SubmitInput {
  campaignId?: unknown;
  url?: unknown;
  payoutAddress?: unknown;
  handle?: unknown;
}

/**
 * Take a clip in.
 *
 * Everything that can be refused is refused *here*, before the creator has
 * done anything on the strength of it. The one thing this cannot check is
 * whether the clip meets the brief — that needs the video, and it happens
 * after acceptance under terms already frozen.
 */
/**
 * Who already claimed a post in this campaign, if anyone.
 *
 * Returns the creator id of the first submitter, or undefined. Injected rather
 * than looked up here so intake stays a pure function of its inputs.
 */
/**
 * What a creator has earned so far, and how many places on this campaign have
 * already gone to creators without a record. Passed in rather than looked up
 * here, so intake stays a pure function of its inputs — the same reason
 * `ClaimLookup` is shaped this way.
 */
export type StandingLookup = (creatorId: string) => {
  readonly standing: import('./standing').Standing;
  readonly acceptedBelowFloor: number;
};

export type ClaimLookup = (
  campaignId: string,
  platform: Platform,
  postId: string,
) => string | undefined;

export function submitClip(
  campaign: Campaign | undefined,
  input: SubmitInput,
  now: Date = new Date(),
  claimedBy?: ClaimLookup,
  standingOf?: StandingLookup,
): Result<{ submission: Submission; creator: Creator }> {
  if (!campaign) return bad('unknown campaignId', 'campaignId');

  const address = typeof input.payoutAddress === 'string' ? input.payoutAddress.trim() : '';
  if (!ADDRESS.test(address)) {
    return bad('payoutAddress must be a 0x-prefixed 40-character address', 'payoutAddress');
  }

  const ref = parsePostUrl(typeof input.url === 'string' ? input.url : '');
  if (!ref) {
    return bad(
      'url must be a YouTube or X post. Instagram, Facebook and TikTok cannot ' +
        'be verified, and accepting the link would promise a check we cannot perform.',
      'url',
    );
  }
  if (!campaign.platforms.includes(ref.platform)) {
    return bad(`this campaign pays on ${campaign.platforms.join(', ')} only`, 'url');
  }

  // The wallet is the identity. A creator who has never been here before is
  // simply a wallet we have not paid yet.
  const creatorId = `cre-${address.toLowerCase()}`;

  // One post, one claimant, per campaign.
  //
  // Without this, nothing tied a submission to the person who made the video.
  // Three wallets could claim the same clip and all three would be paid for
  // the same views — and unlike bought views, these are real, so the dwell
  // window does nothing about it. The attack is not botting; it is submitting
  // someone else's viral clip from fifty wallets and draining the pool at
  // fifty times the rate one video should ever cost.
  //
  // This does not prove authorship, and it is not meant to. It removes the
  // multiplication, which is the part that scales. Proving a creator owns a
  // channel needs a code in the description or an OAuth handshake, and that
  // buys much less than this does.
  const already = claimedBy?.(campaign.campaignId, ref.platform, ref.postId);
  if (already && already !== creatorId) {
    return bad(
      'this post was already submitted to this campaign by someone else. Each ' +
        'clip pays one creator — if it is yours, submit from the wallet that ' +
        'claimed it first.',
      'url',
    );
  }
  // A brand may ask for a standing floor. Checked after the claim rule, so a
  // creator who is turned away for standing is told that, rather than being
  // told nothing because an earlier check happened to fire first.
  //
  // The reservation is the whole reason this is safe to ship: standing is
  // `unproven` until three clips have been judged, so a floor with no places
  // held open would turn away everyone who has not been here before, and they
  // would never get the three clips that let them in.
  if (campaign.minStanding && standingOf) {
    const record = standingOf(creatorId);
    const verdict = eligible({
      minStanding: campaign.minStanding,
      reservedForUnproven: campaign.reservedForUnproven,
      expectedSubmissions: undefined,
      standing: record.standing,
      acceptedBelowFloor: record.acceptedBelowFloor,
    });
    if (!verdict.admitted) return bad(verdict.reason, 'standing');
  }

  const handle = typeof input.handle === 'string' ? input.handle.trim().slice(0, 64) : undefined;
  const verificationCode = `MC-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;

  const accepted = acceptSubmission(
    campaign,
    {
      submissionId: `sub-${ref.platform}-${ref.postId}-${creatorId.slice(4, 14)}`,
      creatorId,
      platform: ref.platform,
      postId: ref.postId,
      url: typeof input.url === 'string' ? input.url : '',
    },
    now,
  );
  if (!accepted.accepted) return bad(accepted.detail, 'campaignId');

  const submissionWithCode: Submission = {
    ...accepted.submission,
    verificationCode,
  };

  return {
    ok: true,
    value: {
      submission: submissionWithCode,
      creator: {
        creatorId,
        payoutAddress: address,
        handles: handle ? { [ref.platform]: handle } : {},
      },
    },
  };
}
