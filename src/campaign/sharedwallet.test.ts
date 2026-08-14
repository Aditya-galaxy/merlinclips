/**
 * The same dollars cannot back two campaigns.
 *
 * `fundingFor` compares a wallet's balance against one campaign's pool. Point
 * two campaigns at the same wallet and each asks "is there 100 USDC here?"
 * about the same 100 USDC — both hear yes, and both publish "fully funded" to
 * creators deciding whether an evening of editing is worth it.
 *
 * Netting the other outstanding pools off the balance first is what makes the
 * answer mean "backing available to *this* campaign".
 */

import { describe, expect, test } from 'bun:test';

import { Decimal } from '../decimal';
import type { BalanceReader } from './funding';
import { fundingFor } from './funding';
import type { Campaign } from './types';

const WALLET = '0x' + '1'.repeat(40);

const campaign = (id: string, pool: string): Campaign & { fundingWallet: string } => ({
  campaignId: id,
  brief: 'Clip the launch stream.',
  poolUsdc: new Decimal(pool),
  cpmUsdc: new Decimal('1'),
  rateBand: { minUsdc: new Decimal('0.5'), maxUsdc: new Decimal('2') },
  perCreatorCapUsdc: new Decimal('20'),
  dwellMs: 86_400_000,
  settlementWindowMs: 14 * 86_400_000,
  platforms: ['youtube'],
  chain: 'base',
  status: 'active',
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-09-01T00:00:00.000Z',
  fundingWallet: WALLET,
});

const holding = (usdc: string): BalanceReader => ({
  async usdcBalance() { return new Decimal(usdc); },
});

const NONE = new Decimal(0n);

describe('a wallet backing one campaign', () => {
  test('a covered pool reads covered', async () => {
    const f = await fundingFor(campaign('camp-1', '100'), NONE, holding('100'), NONE);
    expect(f.coverage).toBe('covered');
  });

  test('a short pool reads partial', async () => {
    const f = await fundingFor(campaign('camp-1', '100'), NONE, holding('40'), NONE);
    expect(f.coverage).toBe('partial');
  });
});

describe('a wallet backing more than one', () => {
  test('100 USDC behind two 100 pools does not cover the second', async () => {
    // The whole point. Without netting, both campaigns report `covered`.
    const f = await fundingFor(campaign('camp-2', '100'), NONE, holding('100'), new Decimal('100'));
    expect(f.coverage).toBe('empty');
    expect(f.summary).toContain('already promised to other campaigns');
  });

  test('250 behind a 100 and a 100 still covers the second', async () => {
    const f = await fundingFor(campaign('camp-2', '100'), NONE, holding('250'), new Decimal('100'));
    expect(f.coverage).toBe('covered');
  });

  test('150 behind two 100s leaves the second partly funded, and says by how much', async () => {
    const f = await fundingFor(campaign('camp-2', '100'), NONE, holding('150'), new Decimal('100'));
    expect(f.coverage).toBe('partial');
    expect(f.summary).toContain('50 USDC backs a 100 budget');
  });

  test('an oversubscribed wallet reports empty rather than a negative credit', async () => {
    const f = await fundingFor(campaign('camp-3', '100'), NONE, holding('50'), new Decimal('400'));
    expect(f.coverage).toBe('empty');
    expect(f.fundedUsdc).toBe('50');
  });

  test('the balance is still reported honestly, only the verdict changes', async () => {
    // A brand looking at this needs to see what is in the wallet *and* why it
    // does not count as theirs.
    const f = await fundingFor(campaign('camp-2', '100'), NONE, holding('100'), new Decimal('100'));
    expect(f.fundedUsdc).toBe('100');
    expect(f.summary).toContain('100 USDC sits here');
  });
});

describe('what does not change', () => {
  test('a failed lookup is still unknown, not empty', async () => {
    const reader: BalanceReader = { async usdcBalance() { return undefined; } };
    const f = await fundingFor(campaign('camp-1', '100'), NONE, reader, new Decimal('100'));
    expect(f.coverage).toBe('unknown');
  });

  test('no wallet is still no_wallet', async () => {
    const c = { ...campaign('camp-1', '100'), fundingWallet: undefined };
    const f = await fundingFor(c, NONE, holding('100'), NONE);
    expect(f.coverage).toBe('no_wallet');
  });
});
