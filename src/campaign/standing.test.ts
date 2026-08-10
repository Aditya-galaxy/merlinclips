/**
 * The property that makes this worth having: buying views lowers it.
 *
 * Every trust score in this market can be farmed by doing a lot of anything.
 * This one cannot, because the bought views land in the denominator when they
 * evaporate — the same arithmetic that decides the payout decides the score.
 */

import { describe, expect, test } from 'bun:test';
import { PROVEN_AFTER, standingFor } from './standing';
import type { Snapshot } from './types';

const snap = (id: string, views: bigint): Snapshot => ({
  submissionId: id, views, fetchedAt: '2026-08-05T00:00:00.000Z', source: 'youtube',
});

/** A view over fixed data: peak observed per clip, and what was paid. */
const world = (clips: { id: string; peak: bigint; paid: bigint }[]) => ({
  submissions: clips.map((c) => ({ submissionId: c.id })),
  view: {
    snapshots: (id: string) => {
      const c = clips.find((x) => x.id === id);
      return c ? [snap(id, c.peak / 2n), snap(id, c.peak)] : [];
    },
    viewsPaidTo: (id: string) => clips.find((x) => x.id === id)?.paid ?? 0n,
  },
});

describe('standing is earned, not awarded', () => {
  test('a creator whose views all held reads exceptional', () => {
    const w = world([
      { id: 'a', peak: 10_000n, paid: 10_000n },
      { id: 'b', peak: 20_000n, paid: 19_500n },
      { id: 'c', peak: 5_000n, paid: 5_000n },
    ]);
    const r = standingFor('cre-1', w.submissions, w.view);
    expect(r.standing).toBe('exceptional');
    expect(r.survivalRate).toBeGreaterThan(0.95);
  });

  test('buying views lowers it — the whole point', () => {
    // Same creator, same effort, except one clip was inflated to 800k and
    // scrubbed to almost nothing. Volume does not rescue the number.
    const w = world([
      { id: 'a', peak: 10_000n, paid: 10_000n },
      { id: 'b', peak: 20_000n, paid: 19_500n },
      { id: 'bought', peak: 800_000n, paid: 50n },
    ]);
    const r = standingFor('cre-1', w.submissions, w.view);
    expect(r.survivalRate).toBeLessThan(0.05);
    expect(r.standing).toBe('building');
  });

  test('posting more cannot farm it', () => {
    // Twenty honest clips do not offset one bought one, because the score is a
    // ratio rather than a count. That is what makes it unfarmable by volume.
    const honest = Array.from({ length: 20 }, (_, i) => ({ id: 'h' + i, peak: 1_000n, paid: 1_000n }));
    const clean = standingFor('c', world(honest).submissions, world(honest).view);
    const withBought = world([...honest, { id: 'x', peak: 500_000n, paid: 0n }]);
    const dirty = standingFor('c', withBought.submissions, withBought.view);
    expect(clean.survivalRate).toBeCloseTo(1, 2);
    expect(dirty.survivalRate!).toBeLessThan(0.1);
  });

  test('one good clip proves nothing, and says so', () => {
    const w = world([{ id: 'a', peak: 10_000n, paid: 10_000n }]);
    const r = standingFor('cre-1', w.submissions, w.view);
    expect(r.standing).toBe('unproven');
    expect(r.summary).toContain('of ' + PROVEN_AFTER);
  });

  test('a creator with no observed views has no rate, rather than a zero', () => {
    // Absent and bad are different facts. Reporting 0% for someone who has
    // simply not been measured yet would be a false accusation.
    const r = standingFor('cre-1', [{ submissionId: 'a' }], {
      snapshots: () => [], viewsPaidTo: () => 0n,
    });
    expect(r.survivalRate).toBeNull();
    expect(r.judged).toBe(0);
    expect(r.standing).toBe('unproven');
  });

  test('the denominator is the peak, not the final count', () => {
    // A clip inflated to 800k and scrubbed to 50 was observed at 800k. Using
    // the last figure would quietly forgive the exact behaviour this measures.
    const w = world([
      { id: 'a', peak: 800_000n, paid: 50n },
      { id: 'b', peak: 800_000n, paid: 50n },
      { id: 'c', peak: 800_000n, paid: 50n },
    ]);
    expect(standingFor('c', w.submissions, w.view).survivalRate).toBeLessThan(0.01);
  });
});
