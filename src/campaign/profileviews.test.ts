/**
 * What a creator's own dashboard says they were paid for.
 *
 * `viewsPaidTo` is the high-water mark a submission reached, not an increment.
 * A clip that keeps accruing gets paid more than once — 8,000 views, then
 * 12,400 — and each payout carries the mark at that moment. Adding the marks
 * reports 20,400 views for a clip that reached 12,400.
 *
 * Amounts are different in kind: each payout moves that much USDC, so those do
 * sum. The two must not be treated the same way, and this file is the test that
 * says so.
 */

import { describe, expect, test } from 'bun:test';

import { sign } from '../auth/session';
import { Decimal } from '../decimal';
import { MemoryBlobStore } from './persistence';
import { CampaignRuntime } from './runtime';
import { termsFor } from './terms';
import type { Campaign } from './types';

const SECRET = 'session-secret-for-tests';
const WALLET = '0x' + 'a'.repeat(40);

const campaign: Campaign = {
  campaignId: 'camp-1',
  brief: 'Clip the launch stream.',
  poolUsdc: new Decimal('100'),
  cpmUsdc: new Decimal('1'),
  rateBand: { minUsdc: new Decimal('0.5'), maxUsdc: new Decimal('2') },
  perCreatorCapUsdc: new Decimal('50'),
  dwellMs: 86_400_000,
  settlementWindowMs: 14 * 86_400_000,
  platforms: ['youtube'],
  chain: 'base',
  status: 'active',
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-09-01T00:00:00.000Z',
};

/** A creator with one clip, paid `marks` times as it kept accruing. */
async function profileAfter(marks: readonly (readonly [bigint, string])[]) {
  const rt = new CampaignRuntime({
    blobs: new MemoryBlobStore(),
    env: { SESSION_SECRET: SECRET },
  });
  await rt.record({ type: 'campaign_upserted', campaign });
  await rt.record({
    type: 'creator_upserted',
    creator: { creatorId: WALLET, payoutAddress: WALLET, handles: {} },
  });
  await rt.record({
    type: 'submission_accepted',
    submission: {
      submissionId: 'sub-1',
      campaignId: 'camp-1',
      creatorId: WALLET,
      platform: 'youtube',
      postId: 'p1',
      url: 'https://youtube.com/shorts/p1',
      submittedAt: '2026-08-02T00:00:00.000Z',
      acceptedTerms: termsFor(campaign, new Date('2026-08-02T00:00:00.000Z')),
    },
  });

  let n = 0;
  for (const [views, amount] of marks) {
    n += 1;
    await rt.record({
      type: 'payout_settled',
      payout: {
        payoutId: `pay-${n}`,
        submissionId: 'sub-1',
        campaignId: 'camp-1',
        creatorId: WALLET,
        viewsPaidTo: views,
        amountUsdc: new Decimal(amount),
        at: `2026-08-0${2 + n}T00:00:00.000Z`,
      },
    });
  }

  // Sign in, and link the wallet the payouts were made to.
  const token = await sign(
    { creatorId: 'acct-1', sub: 'acct-1', exp: Math.floor(Date.now() / 1000) + 3600 },
    SECRET,
  );
  const cookie = { cookie: `mc_session=${token}` };
  await rt.handleSaveOnboarding(
    new Request('http://x/api/me/onboarding', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...cookie },
      body: JSON.stringify({ wallet: WALLET, handle: 'someone' }),
    }),
  );

  const res = await rt.handleProfile(new Request('http://x/api/me/profile', { headers: cookie }));
  return (await res.json()) as {
    totals: { earnedUsdc: string; viewsPaid: string; payouts: number };
  };
}

describe('a clip paid twice is not counted twice', () => {
  test('views report the mark reached, not the sum of the marks', async () => {
    // 8,000 then 12,400 on one clip. The clip reached 12,400 views.
    const p = await profileAfter([
      [8_000n, '8.00'],
      [12_400n, '4.40'],
    ]);
    expect(p.totals.viewsPaid).toBe('12400');
  });

  test('amounts still sum, because each payout moved that much USDC', async () => {
    const p = await profileAfter([
      [8_000n, '8.00'],
      [12_400n, '4.40'],
    ]);
    expect(p.totals.earnedUsdc).toBe('12.40');
    expect(p.totals.payouts).toBe(2);
  });

  test('a single payout is unaffected', async () => {
    const p = await profileAfter([[12_400n, '12.40']]);
    expect(p.totals.viewsPaid).toBe('12400');
    expect(p.totals.earnedUsdc).toBe('12.40');
  });

  test('nothing paid reports nothing, not a stale mark', async () => {
    const p = await profileAfter([]);
    expect(p.totals.viewsPaid).toBe('0');
    expect(p.totals.earnedUsdc).toBe('0.00');
  });
});
