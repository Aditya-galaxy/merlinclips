/**
 * An ended campaign stops reserving money it can no longer spend.
 *
 * A live campaign reserves its whole remaining pool against its funding
 * wallet, and it has to: any of that pool might still be claimed by a clip
 * nobody has submitted yet, so releasing it would let a second campaign
 * publish "fully funded" against dollars the first one owes.
 *
 * An ended campaign is different. It accepts no new clips. The only claims
 * left are the creators who already have accepted ones, each capped at the
 * per-creator limit. Reserving the full pool for them strands the difference —
 * a 100 USDC campaign that ends owing one creator capped at 10 holds 90 USDC
 * hostage against every other campaign sharing that wallet, forever, because
 * nothing ever comes along to claim it.
 *
 * This is a capital-efficiency bug rather than a safety one: the old behaviour
 * over-reserved, which refuses honest campaigns but never over-promises. The
 * fix has to keep that asymmetry — the ceiling may shrink what is reserved,
 * never below what the outstanding clips could actually draw.
 */

import { describe, expect, test } from 'bun:test';

import { Decimal } from '../decimal';
import { MemoryBlobStore } from './persistence';
import { CampaignRuntime } from './runtime';
import type { Campaign } from './types';

const WALLET = '0x' + 'c'.repeat(40);

const campaign = (id: string, status: Campaign['status'], pool: string): Campaign => ({
  campaignId: id,
  brief: 'Clip the launch stream.',
  poolUsdc: new Decimal(pool),
  cpmUsdc: new Decimal('1'),
  rateBand: { minUsdc: new Decimal('0.5'), maxUsdc: new Decimal('2') },
  perCreatorCapUsdc: new Decimal('10'),
  dwellMs: 86_400_000,
  settlementWindowMs: 14 * 86_400_000,
  platforms: ['youtube'],
  chain: 'base',
  status,
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-09-01T00:00:00.000Z',
  fundingWallet: WALLET,
});

/**
 * A runtime holding one prior campaign on WALLET, plus `clips` accepted clips
 * on it from distinct creators. Balance is fixed so coverage is decided purely
 * by what the prior campaign reserves.
 */
async function withPrior(status: Campaign['status'], clips: number, balance: string) {
  const rt = new CampaignRuntime({
    blobs: new MemoryBlobStore(),
    env: { SESSION_SECRET: 's'.repeat(32) },
  });
  rt.balances = { async usdcBalance() { return new Decimal(balance); } };
  await rt.ready();

  await rt.record({ type: 'campaign_upserted', campaign: campaign('camp-prior', status, '100') });
  for (let i = 0; i < clips; i++) {
    await rt.record({
      type: 'submission_accepted',
      submission: {
        submissionId: `sub-${i}`,
        campaignId: 'camp-prior',
        creatorId: `creator-${i}`,
        platform: 'youtube',
        postId: `post-${i}`,
        url: `https://youtube.com/watch?v=post-${i}`,
        submittedAt: '2026-08-02T00:00:00.000Z',
        acceptedTerms: {
          cpmUsdc: new Decimal('1'),
          dwellMs: 86_400_000,
          perCreatorCapUsdc: new Decimal('10'),
          acceptedAt: '2026-08-02T00:00:00.000Z',
          settlementDeadline: '2026-09-01T00:00:00.000Z',
        },
      },
    });
  }

  // The campaign asking whether anything is left for it.
  await rt.record({
    type: 'campaign_upserted',
    campaign: campaign('camp-new', 'pending_funding', '100'),
  });

  const res = await rt.handleCheckFunding('camp-new');
  return (await res.json()) as { funding: { coverage: string; fundedUsdc: string | null } };
}

describe('a live campaign reserves everything it might still owe', () => {
  test('120 behind a live 100 does not cover a second 100', async () => {
    // Unchanged, and the reason the netting exists: a live campaign can still
    // receive a clip that claims any part of its pool.
    const { funding } = await withPrior('active', 1, '120');
    expect(funding.coverage).toBe('partial');
  });
});

describe('an ended campaign reserves only what its accepted clips can draw', () => {
  test('120 behind an ended 100 owing one capped creator covers a second 100', async () => {
    // The ended campaign can pay out at most 10 (one creator, 10 cap), so 110
    // of the 120 is genuinely free and the 100 pool is covered.
    const { funding } = await withPrior('ended', 1, '120');
    expect(funding.coverage).toBe('covered');
  });

  test('an ended campaign with no accepted clips reserves nothing at all', async () => {
    const { funding } = await withPrior('ended', 0, '100');
    expect(funding.coverage).toBe('covered');
  });

  test('the ceiling scales with the creators actually owed', async () => {
    // Five creators × 10 cap = 50 reserved, leaving 70 of 120 — short of 100.
    const { funding } = await withPrior('ended', 5, '120');
    expect(funding.coverage).toBe('partial');
  });

  test('the ceiling never exceeds what the pool has left', async () => {
    // Twenty creators × 10 cap = 200 in theory, but the pool is 100 and that
    // is all it can pay. Reserving 200 would refuse a campaign that fits.
    const { funding } = await withPrior('ended', 20, '250');
    expect(funding.coverage).toBe('covered');
  });

  test('the wallet balance is still reported honestly', async () => {
    // Only the verdict moves. A brand still sees what is actually on-chain.
    const { funding } = await withPrior('ended', 1, '120');
    expect(funding.fundedUsdc).toBe('120');
  });
});
