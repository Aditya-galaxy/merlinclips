import { describe, expect, test } from 'bun:test';
import { Decimal } from '../decimal';
import { ReservationEngine } from './reservation';
import { CampaignLockManager } from './lock';

describe('Enterprise Concurrency & Pool Protection', () => {
  test('100 concurrent reservations do not exceed pool budget', async () => {
    const reservations = new ReservationEngine({ ttlMs: 10_000 });
    const lock = new CampaignLockManager();

    const poolCapacity = new Decimal('100.00');
    let allocated = new Decimal(0n);
    let successfulCount = 0;
    let rejectedCount = 0;

    const attempts = Array.from({ length: 100 }, (_, i) => i);

    await Promise.all(
      attempts.map((id) =>
        lock.withLock('c-stress', async () => {
          const reqAmount = new Decimal('2.00'); // Each asks for 2 USDC
          const currentReserved = reservations.reservedForCampaign('c-stress');

          if (currentReserved.plus(reqAmount).lte(poolCapacity)) {
            const res = reservations.reserve({
              intentId: `intent-${id}`,
              campaignId: 'c-stress',
              creatorId: `cr-${id}`,
              amountUsdc: reqAmount,
            });

            if (res) {
              allocated = allocated.plus(reqAmount);
              successfulCount += 1;
            }
          } else {
            rejectedCount += 1;
          }
        }),
      ),
    );

    // Exactly 50 reservations of 2.00 USDC fit in 100.00 USDC pool
    expect(successfulCount).toBe(50);
    expect(rejectedCount).toBe(50);
    expect(allocated.toString()).toBe('100');
  });
});
