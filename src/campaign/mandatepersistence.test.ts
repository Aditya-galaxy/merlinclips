/**
 * Spend authority has to survive the instance that granted it.
 *
 * The policy engine refuses a payment to a counterparty with no live mandate —
 * correctly, since the agent may propose paying anyone but may only pay who an
 * operator mandated. Mandates were held only in memory, so every cold instance
 * started with none and the hourly tick sent every eligible payout to
 * `requires_approval`. The system was not "not yet paying"; it could not pay.
 *
 * A mandate is issued when a clip is accepted, because that is when the
 * obligation is created: an operator approved the campaign, the chain
 * confirmed USDC behind its pool, and the clip was accepted under caps the
 * campaign set. The mandate encodes that and nothing wider.
 */

import { describe, expect, test } from 'bun:test';

import { Decimal } from '../decimal';
import { MemoryBlobStore } from './persistence';
import { CampaignRuntime } from './runtime';
import type { Campaign } from './types';

const WALLET = '0x' + 'a'.repeat(40);

const campaign: Campaign = {
  campaignId: 'camp-pay',
  brief: 'Clip the launch stream.',
  poolUsdc: new Decimal('100'),
  cpmUsdc: new Decimal('1'),
  rateBand: { minUsdc: new Decimal('0.5'), maxUsdc: new Decimal('2') },
  perCreatorCapUsdc: new Decimal('20'),
  dwellMs: 86_400_000,
  settlementWindowMs: 14 * 86_400_000,
  platforms: ['youtube'],
  chain: 'base-sepolia',
  status: 'active',
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-09-01T00:00:00.000Z',
};

const submit = (url = 'https://youtube.com/shorts/abc123XYZ_1') =>
  new Request('http://x/api/submissions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ campaignId: 'camp-pay', payoutAddress: WALLET, url }),
  });

async function accepted(blobs: MemoryBlobStore) {
  const rt = new CampaignRuntime({ blobs, env: {} });
  await rt.record({ type: 'campaign_upserted', campaign });
  await rt.handleSubmit(submit());
  return rt;
}

describe('accepting a clip grants authority to pay for it', () => {
  test('a mandate exists on the instance that accepted the clip', async () => {
    // Not only after a restart: the instance that took the submission must be
    // able to pay for it on its own next pass.
    const rt = await accepted(new MemoryBlobStore());
    expect(rt.mandates.list()).toHaveLength(1);
  });

  test('it survives a cold start', async () => {
    const blobs = new MemoryBlobStore();
    await accepted(blobs);

    const next = new CampaignRuntime({ blobs, env: {} });
    await next.ready();
    expect(next.mandates.list()).toHaveLength(1);
  });

  test('it is capped at the campaign per-creator cap, not something wider', async () => {
    const rt = await accepted(new MemoryBlobStore());
    const [mandate] = rt.mandates.list();
    expect(mandate?.maxPerPaymentUsdc.toString()).toBe('20');
    expect(mandate?.counterparty).toBe(WALLET);
  });

  test('it names why it exists, so a later reader can judge it', async () => {
    const rt = await accepted(new MemoryBlobStore());
    const [mandate] = rt.mandates.list();
    expect(mandate?.issuedBy).toBe('campaign-acceptance');
    expect(mandate?.reason).toContain('camp-pay');
  });

  test('it expires with the settlement window rather than standing forever', async () => {
    const rt = await accepted(new MemoryBlobStore());
    const [mandate] = rt.mandates.list();
    expect(mandate?.expiresAt).toBeDefined();
  });

  test('a second clip from the same creator does not stack a second mandate', async () => {
    const blobs = new MemoryBlobStore();
    const rt = await accepted(blobs);
    await rt.handleSubmit(submit('https://youtube.com/shorts/def456ABC_2'));
    expect(rt.mandates.list()).toHaveLength(1);
  });
});

describe('a payout completes after a cold start', () => {
  test('the pass pays rather than parking everything in requires_approval', async () => {
    const blobs = new MemoryBlobStore();
    await accepted(blobs);

    const rt = new CampaignRuntime({ blobs, env: {} });
    await rt.ready();
    const sub = rt.store.exportState().submissions[0]!;

    await rt.record({
      type: 'verdict_recorded',
      verdict: {
        verdictId: 'v1', submissionId: sub.submissionId, pass: true,
        reasons: ['meets the brief'], confidence: 0.95, model: 'test',
        at: '2026-08-02T00:00:00.000Z',
      },
    });
    // Two observations a day apart; the dwell minimum resolves to 4,000.
    for (const [at, views] of [
      ['2026-08-02T01:00:00.000Z', 4_000n],
      ['2026-08-03T02:00:00.000Z', 9_000n],
    ] as const) {
      await rt.record({
        type: 'snapshot_taken',
        snapshot: { submissionId: sub.submissionId, views, fetchedAt: at, source: 'youtube' },
      });
    }

    const result = await rt.tick(new Date('2026-08-03T03:00:00.000Z'));
    expect(result.needsApproval).toBe(0);
    expect(result.paid).toBe(1);
    // 4,000 surviving views at 1.00 per 1k.
    expect(result.totalPaidUsdc.toString()).toBe('4');
  });
});
