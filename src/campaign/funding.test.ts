/**
 * The number a creator bets an evening on.
 *
 * Remaining budget was published without anything checking it existed. A brand
 * could advertise $85,000, fund nothing, and we would show that figure as the
 * amount left to earn — which is the complaint this product answers, arriving
 * through our own front door.
 */

import { describe, expect, test } from 'bun:test';
import { Decimal } from '../decimal';
import { fundingFor, type BalanceReader } from './funding';
import type { Campaign } from './types';

const campaign = (over: Partial<Campaign> & { fundingWallet?: string } = {}) => ({
  campaignId: 'camp-1', brief: 'Clip the podcast.',
  poolUsdc: new Decimal('1000'), cpmUsdc: new Decimal('1'),
  rateBand: { minUsdc: new Decimal('0.5'), maxUsdc: new Decimal('2') },
  perCreatorCapUsdc: new Decimal('100'), dwellMs: 86_400_000,
  settlementWindowMs: 14 * 86_400_000, platforms: ['youtube'] as const,
  chain: 'base' as const, status: 'active' as const,
  startsAt: '2026-08-01T00:00:00.000Z', endsAt: '2026-09-01T00:00:00.000Z',
  fundingWallet: '0x' + 'a'.repeat(40),
  ...over,
});

const reads = (amount: string | undefined): BalanceReader => ({
  async usdcBalance() { return amount === undefined ? undefined : new Decimal(amount); },
});
const throws = (): BalanceReader => ({ async usdcBalance() { throw new Error('rpc down'); } });

const zero = new Decimal(0n);

describe('a budget is only real if the money is there', () => {
  test('fully funded says so, with the figure', async () => {
    const f = await fundingFor(campaign(), zero, reads('1000'));
    expect(f.coverage).toBe('covered');
    expect(f.fundedUsdc).toBe('1000');
  });

  test('an unfunded campaign is called empty, not shown as available', async () => {
    const f = await fundingFor(campaign(), zero, reads('0'));
    expect(f.coverage).toBe('empty');
    expect(f.summary).toMatch(/Do not start/);
  });

  test('partly funded reports what can actually be paid', async () => {
    // Not fraud — a campaign that can pay a tenth of its budget. The creator is
    // entitled to know that while it is still their decision.
    const f = await fundingFor(campaign(), zero, reads('100'));
    expect(f.coverage).toBe('partial');
    expect(f.summary).toContain('100');
    expect(f.summary).toContain('1000');
  });

  test('a campaign with no wallet named backs nothing', async () => {
    const f = await fundingFor(campaign({ fundingWallet: undefined }), zero, reads('999'));
    expect(f.coverage).toBe('no_wallet');
    expect(f.fundedUsdc).toBeNull();
  });
});

describe('a failed lookup is not an accusation', () => {
  test('an unreadable balance is unknown, never zero', async () => {
    // Reading a failed lookup as "empty" would libel a brand that funded
    // correctly, at the exact moment a creator is deciding whether to trust it.
    const f = await fundingFor(campaign(), zero, reads(undefined));
    expect(f.coverage).toBe('unknown');
    expect(f.fundedUsdc).toBeNull();
    expect(f.summary).toMatch(/could not check/i);
  });

  test('a throwing reader is also unknown, not empty', async () => {
    const f = await fundingFor(campaign(), zero, throws());
    expect(f.coverage).toBe('unknown');
  });
});
