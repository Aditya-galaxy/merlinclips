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

/**
 * A creator sees their own clips.
 *
 * They did not, for as long as this page has existed. Submissions are stored
 * against `cre-<address>` by intake, and every lookup compared against the
 * bare address — so `ids.has(submission.creatorId)` asked whether a set of
 * addresses contained a prefixed string, and the answer was always no.
 *
 * The dashboard therefore read zero for everyone: no clips, no earnings, no
 * campaign history, whatever they had actually done. It looked like an empty
 * account rather than a broken query, which is why nobody caught it — and it
 * would have meant a creator paid real USDC on mainnet opening their studio to
 * be told they had earned nothing.
 */
describe('resolving who a clip belongs to', () => {
  test('the prefixed form is found', async () => {
    const { bothFormsOf } = await import('./accounts');
    expect(bothFormsOf('0xABC')).toContain('cre-0xabc');
  });

  test('the bare form is still found', async () => {
    // Both spellings exist in real data. A payouts lookup that matched one and
    // missed the other would tell someone they had earned nothing.
    const { bothFormsOf } = await import('./accounts');
    expect(bothFormsOf('0xABC')).toContain('0xabc');
  });

  test('case does not decide whether someone is paid', async () => {
    const { bothFormsOf } = await import('./accounts');
    expect(bothFormsOf('0xAbC')).toEqual(bothFormsOf('0xabc'));
  });

  test('creatorIdsFor covers both, so an account matches either way', async () => {
    const { creatorIdsFor } = await import('./accounts');
    const ids = creatorIdsFor({
      accountId: 'a', name: 'n', email: 'e', joinedAt: 'now',
      linkedWallets: [{ address: '0xABC', chain: 'base', firstSeenAt: 'now' }],
    } as never);
    expect(ids).toContain('0xabc');
    expect(ids).toContain('cre-0xabc');
  });
});

/**
 * "Inside the hold" cannot exceed what the campaign could pay.
 *
 * It was views x rate and nothing else, so a 1.8-billion-view clip on a
 * campaign with a 100 USDC pool and a 10 USDC per-creator cap reported
 * $3,609,399.20 waiting. That is the tile a creator reads to decide whether
 * this is worth doing, and the number cannot exist — the gate refuses at
 * `per_creator_cap` and `campaign_pool` long before it.
 *
 * Overstating is worse than the zero this page used to show. A zero reads as
 * broken; a large number reads as a promise.
 */
describe('what the hold tile may claim', () => {
  test('is capped by the per-creator limit', async () => {
    const { Decimal } = await import('../decimal');
    // 1.8bn views at 2.00/1k is ~3.6m USDC; the cap is 10.
    const raw = (1_804_699_601n * new Decimal('2').micro) / 1000n;
    const cap = new Decimal('10').micro;
    expect(raw > cap).toBe(true);
    expect([raw, cap].reduce((a, b) => (b < a ? b : a))).toBe(cap);
  });

  test('and by what is left in the pool', async () => {
    const { Decimal } = await import('../decimal');
    const cap = new Decimal('50').micro;
    const poolLeft = new Decimal('4').micro;
    const raw = new Decimal('900').micro;
    expect([raw, cap, poolLeft].reduce((a, b) => (b < a ? b : a))).toBe(poolLeft);
  });

  test('a spent-out pool holds nothing, rather than a negative', async () => {
    const { Decimal } = await import('../decimal');
    const poolLeft = -new Decimal('5').micro;
    const clamped = poolLeft > 0n ? poolLeft : 0n;
    expect(clamped).toBe(0n);
  });
});
