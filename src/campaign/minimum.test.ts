import { describe, expect, it } from 'bun:test';
import { Decimal } from '../decimal';
import { MINIMUM_PAYOUT_USDC } from './payout';

/**
 * At a dollar per thousand views, ten views is a cent. Paying that out spends
 * a brand's budget on transaction fees rather than on views.
 *
 * The floor holds rather than refuses, and payouts are computed against a
 * high-water mark of views already paid for — so an amount held today is
 * included in the next payment rather than lost. These cover the arithmetic
 * that makes that true.
 */
function earnings(views: bigint, cpmUsdc: string): Decimal {
  return new Decimal(((Number(views) / 1000) * Number(cpmUsdc)).toFixed(6));
}

describe('the minimum worth sending', () => {
  it('is a quarter of a dollar', () => {
    expect(MINIMUM_PAYOUT_USDC.toString()).toBe('0.25');
  });

  it('sits above the amounts that cost more to send than they carry', () => {
    // 10 views at $1/1k is a cent; 100 views is a dime.
    expect(MINIMUM_PAYOUT_USDC.gt(earnings(10n, '1.00'))).toBe(true);
    expect(MINIMUM_PAYOUT_USDC.gt(earnings(100n, '1.00'))).toBe(true);
  });

  it('lets a real payment through', () => {
    // 1,000 views at $1/1k is a dollar; 250 views is exactly the floor.
    expect(MINIMUM_PAYOUT_USDC.gt(earnings(1000n, '1.00'))).toBe(false);
    expect(MINIMUM_PAYOUT_USDC.gt(earnings(250n, '1.00'))).toBe(false);
  });

  // The floor must never be so high that a normal creator cannot reach it.
  it('is reachable inside one ordinary clip', () => {
    expect(MINIMUM_PAYOUT_USDC.gt(earnings(5000n, '0.50'))).toBe(false);
    expect(MINIMUM_PAYOUT_USDC.gt(earnings(500n, '0.50'))).toBe(false);
  });
});
