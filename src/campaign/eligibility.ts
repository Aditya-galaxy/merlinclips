/**
 * Whether a creator may join a campaign.
 *
 * Brands asked for a floor: only creators whose views actually hold. That is a
 * reasonable thing to want and it is the brand setting their own terms up
 * front, frozen at acceptance like the rate and the wait — categorically
 * different from adjusting anyone's rate afterwards.
 *
 * ## Why a filter alone would be a trap
 *
 * Standing is `unproven` until three clips have been judged, so a campaign
 * requiring `reliable` excludes every creator who has not been here before.
 * Ship only the filter and you have built a marketplace nobody can enter: the
 * people you most need to acquire are precisely the ones it turns away, and
 * they never get the three clips that would have let them in.
 *
 * So a filtered campaign always keeps slots open. A share of its accepted
 * submissions is reserved for creators who have not proved anything yet. The
 * brand still gets mostly-proven creators; a newcomer still has a door.
 *
 * ## Reserved, not lowered
 *
 * The reserved slots do not weaken the brand's terms. Everything else still
 * applies to the clip that fills one: the same brief, the same verifier, the
 * same wait, the same caps. What is waived is prior history, which is the one
 * thing a new creator cannot have and cannot fake.
 */

import type { Standing } from './standing';

/** Weakest to strongest. Comparison is by index, so the order is the meaning. */
const RANK: readonly Standing[] = ['unproven', 'building', 'reliable', 'exceptional'];

export function rankOf(s: Standing): number {
  const i = RANK.indexOf(s);
  return i < 0 ? 0 : i;
}

export function meets(actual: Standing, required: Standing): boolean {
  return rankOf(actual) >= rankOf(required);
}

/**
 * The share of accepted submissions held open for unproven creators.
 *
 * A fifth, and a floor of three. The fraction alone would round to zero on a
 * small campaign, which is exactly where a newcomer is most likely to be
 * looking — a campaign accepting five clips would reserve one at 20%, and none
 * at all on the first four decisions.
 */
export const RESERVED_SHARE = 0.2;
export const RESERVED_FLOOR = 3;

export function reservedSlots(cap: number | undefined, explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) {
    return Math.floor(explicit);
  }
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) return RESERVED_FLOOR;
  return Math.max(RESERVED_FLOOR, Math.floor(cap * RESERVED_SHARE));
}

export interface EligibilityInput {
  /** Absent means the campaign is open to anyone, which is the default. */
  readonly minStanding?: Standing;
  /** Overrides the computed reservation. */
  readonly reservedForUnproven?: number;
  /** Expected total submissions, used to size the reservation. */
  readonly expectedSubmissions?: number;
  /** The creator asking. */
  readonly standing: Standing;
  /** Accepted submissions on this campaign from creators below the floor. */
  readonly acceptedBelowFloor: number;
}

export type Eligibility =
  | { readonly admitted: true; readonly viaReservedSlot: boolean; readonly reason: string }
  | { readonly admitted: false; readonly reason: string; readonly slotsWere: number };

export function eligible(input: EligibilityInput): Eligibility {
  const floor = input.minStanding;

  if (!floor || floor === 'unproven') {
    return { admitted: true, viaReservedSlot: false, reason: 'this campaign is open to everyone' };
  }

  if (meets(input.standing, floor)) {
    return {
      admitted: true,
      viaReservedSlot: false,
      reason: `standing is ${input.standing}, and this campaign asks for ${floor}`,
    };
  }

  const slots = reservedSlots(input.expectedSubmissions, input.reservedForUnproven);
  if (input.acceptedBelowFloor < slots) {
    return {
      admitted: true,
      viaReservedSlot: true,
      reason:
        `this campaign asks for ${floor} and keeps ${slots} places for creators who have not ` +
        `proved anything yet — you have one of them`,
    };
  }

  // Named, and it says what to do about it. A refusal a creator cannot act on
  // is a refusal that reads as a closed door.
  return {
    admitted: false,
    slotsWere: slots,
    reason:
      `this campaign asks for ${floor} standing and its ${slots} places for new creators are ` +
      `taken. Standing is the share of your views still there after the wait — three counted ` +
      `clips on an open campaign is enough to have one`,
  };
}
