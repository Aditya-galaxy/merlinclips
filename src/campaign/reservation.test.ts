import { describe, expect, test } from 'bun:test';
import { Decimal } from '../decimal';
import { ReservationEngine } from './reservation';

describe('ReservationEngine', () => {
  test('reserves, commits, and releases budget', () => {
    const engine = new ReservationEngine({ ttlMs: 1000 });
    const now = new Date('2026-08-09T10:00:00Z');

    const res = engine.reserve(
      { intentId: 'pay-sub1-100', campaignId: 'c1', creatorId: 'cr1', amountUsdc: new Decimal('5.00') },
      now,
    );

    expect(res).not.toBeNull();
    expect(res?.state).toBe('reserved');
    expect(engine.reservedForCampaign('c1', now).toString()).toBe('5');

    // Commit
    expect(engine.commit('pay-sub1-100', '0xhash123')).toBe(true);
    expect(res?.state).toBe('settled');
    expect(engine.reservedForCampaign('c1', now).toString()).toBe('0');
  });

  test('sweeps expired reservations automatically', () => {
    const engine = new ReservationEngine({ ttlMs: 1000 });
    const start = new Date('2026-08-09T10:00:00Z');

    engine.reserve(
      { intentId: 'pay-sub2-100', campaignId: 'c2', creatorId: 'cr2', amountUsdc: new Decimal('2.00') },
      start,
    );
    expect(engine.reservedForCampaign('c2', start).toString()).toBe('2');

    const later = new Date('2026-08-09T10:00:05Z');
    expect(engine.reservedForCampaign('c2', later).toString()).toBe('0');
    expect(engine.get('pay-sub2-100')?.state).toBe('expired');
  });
});
