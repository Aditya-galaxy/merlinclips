/**
 * What a creator has earned the right to be believed about.
 *
 * Every platform in this market ships a trust score, and they are all built
 * the same way: ratings, approval rates, badges awarded for participation.
 * Those measure how a platform *feels* about someone, and they can be farmed
 * by doing a lot of anything.
 *
 * We have a better number and it is already in the ledger. **Survival rate**
 * is the share of a creator's observed views that were still there after the
 * dwell window closed. It cannot be gamed by volume, because buying views
 * lowers it — the bought ones evaporate and land in the denominator. A
 * creator who has never bought a view sits near 100% without trying, and one
 * who buys them cannot get there no matter how much they post.
 *
 * So the reputation here is not an opinion about a person. It is the same
 * arithmetic that decides their payout, reported back to them.
 *
 * ## Levels are deliberately hard to reach and easy to keep
 *
 * A creator with two clips has not proved anything, so standing stays
 * `unproven` until there is enough history for the number to mean something.
 * That is the honest state, and showing `100%` off one clip would be the kind
 * of flattery that makes the whole signal worthless.
 */

import type { Snapshot } from './types';

export type Standing = 'unproven' | 'building' | 'reliable' | 'exceptional';

export interface CreatorRecord {
  readonly creatorId: string;
  /** Submissions with enough history to judge. */
  readonly judged: number;
  /** Views that survived, across everything judged. */
  readonly survivedViews: string;
  /** Views observed at their peak, across everything judged. */
  readonly observedViews: string;
  /**
   * `survived / observed`, 0–1. Null when nothing has been judged yet — an
   * absent number and a bad one are different facts.
   */
  readonly survivalRate: number | null;
  readonly standing: Standing;
  /** Said in words, because a creator reads this, not a log parser. */
  readonly summary: string;
}

/** Enough clips that the rate is measuring a habit rather than an accident. */
export const PROVEN_AFTER = 3;

/**
 * Peak observed views for a submission.
 *
 * The denominator is the *highest* count ever seen, not the latest: a clip
 * inflated to 800,000 and scrubbed to 50 was observed at 800,000, and using
 * the final figure would quietly forgive exactly the behaviour this measures.
 */
function peakOf(snapshots: readonly Snapshot[]): bigint {
  let peak = 0n;
  for (const s of snapshots) if (s.views > peak) peak = s.views;
  return peak;
}

export function standingFor(
  creatorId: string,
  submissions: readonly { submissionId: string }[],
  view: {
    snapshots(submissionId: string): readonly Snapshot[];
    viewsPaidTo(submissionId: string): bigint;
  },
): CreatorRecord {
  let survived = 0n;
  let observed = 0n;
  let judged = 0;

  for (const s of submissions) {
    const peak = peakOf(view.snapshots(s.submissionId));
    if (peak <= 0n) continue; // nothing observed: nothing to judge
    judged += 1;
    observed += peak;
    survived += view.viewsPaidTo(s.submissionId);
  }

  const rate = observed > 0n ? Number(survived) / Number(observed) : null;

  let standing: Standing = 'unproven';
  if (judged >= PROVEN_AFTER && rate !== null) {
    if (rate >= 0.9) standing = 'exceptional';
    else if (rate >= 0.7) standing = 'reliable';
    else standing = 'building';
  }

  const pct = rate === null ? null : Math.round(rate * 100);
  const summary =
    standing === 'unproven'
      ? `${judged} of ${PROVEN_AFTER} clips counted. Standing appears once there is enough history to mean something.`
      : standing === 'exceptional'
        ? `${pct}% of your views held. Brands see this.`
        : standing === 'reliable'
          ? `${pct}% of your views held.`
          : `${pct}% of your views held. Views that vanish before the window closes are not paid, and they show here.`;

  return {
    creatorId,
    judged,
    survivedViews: survived.toString(),
    observedViews: observed.toString(),
    survivalRate: rate,
    standing,
    summary,
  };
}
