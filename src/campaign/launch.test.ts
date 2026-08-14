/**
 * The path a campaign takes from a brand's draft to creators' feeds.
 *
 * Three states, and the boundaries between them are where the money is:
 * `pending_funding` → `awaiting_operator_approval` → `active`.
 *
 * The first hop is decided by the chain — a deposit landed, or it did not.
 * The second is decided by a person, because coverage says a budget can be
 * paid, not that this brief should be published to creators. The tests below
 * are mostly about the two failures that would matter: a campaign going live
 * without money behind it, and anyone but an operator being able to launch one.
 */

import { describe, expect, test } from 'bun:test';

import { Decimal } from '../decimal';
import type { BalanceReader } from './funding';
import { MemoryBlobStore } from './persistence';
import { CampaignRuntime } from './runtime';
import { DryRunExecutor } from './tick';
import type { Campaign, CampaignStatus } from './types';

const WALLET = '0x' + '1'.repeat(40);

const draft: Campaign & { fundingWallet: string } = {
  campaignId: 'camp-launch',
  brief: 'Clip the launch stream.',
  poolUsdc: new Decimal('100'),
  cpmUsdc: new Decimal('1'),
  rateBand: { minUsdc: new Decimal('0.5'), maxUsdc: new Decimal('2') },
  perCreatorCapUsdc: new Decimal('50'),
  dwellMs: 86_400_000,
  settlementWindowMs: 14 * 86_400_000,
  platforms: ['youtube'],
  chain: 'base-sepolia',
  status: 'pending_funding',
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-09-01T00:00:00.000Z',
  fundingWallet: WALLET,
};

/** A chain that holds whatever the test says it holds. */
const holding = (usdc: string | undefined): BalanceReader => ({
  async usdcBalance() {
    return usdc === undefined ? undefined : new Decimal(usdc);
  },
});

async function runtime(
  balance: string | undefined,
  status: CampaignStatus = 'pending_funding',
  env: Record<string, string | undefined> = {},
) {
  const rt = new CampaignRuntime({
    blobs: new MemoryBlobStore(),
    executor: new DryRunExecutor(),
    env: { OPERATOR_SECRET: 'operator-key', ...env },
  });
  rt.balances = holding(balance);
  await rt.record({ type: 'campaign_upserted', campaign: { ...draft, status } });
  return rt;
}

const approve = (secret?: string) =>
  new Request('http://x/api/campaigns/camp-launch/approve', {
    method: 'POST',
    headers: secret === undefined ? {} : { 'x-operator-secret': secret },
  });

const statusOf = async (rt: CampaignRuntime) => {
  await rt.ready();
  return rt.store.campaign('camp-launch')?.status;
};

describe('a deposit moves a campaign into the approval queue', () => {
  test('a covered pool queues the campaign for an operator', async () => {
    const rt = await runtime('100');
    const res = await rt.handleCheckFunding('camp-launch');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { advanced: boolean; status: string };
    expect(body.advanced).toBe(true);
    expect(body.status).toBe('awaiting_operator_approval');
    expect(await statusOf(rt)).toBe('awaiting_operator_approval');
  });

  test('a partly funded pool stays where it is', async () => {
    const rt = await runtime('40');
    const body = (await (await rt.handleCheckFunding('camp-launch')).json()) as {
      advanced: boolean;
      funding: { coverage: string };
    };
    expect(body.funding.coverage).toBe('partial');
    expect(body.advanced).toBe(false);
    expect(await statusOf(rt)).toBe('pending_funding');
  });

  test('a chain we could not read does not advance anything', async () => {
    // "We could not check" must not be spent as if it were "the money is here".
    const rt = await runtime(undefined);
    const body = (await (await rt.handleCheckFunding('camp-launch')).json()) as {
      advanced: boolean;
      funding: { coverage: string };
    };
    expect(body.funding.coverage).toBe('unknown');
    expect(body.advanced).toBe(false);
    expect(await statusOf(rt)).toBe('pending_funding');
  });

  test('a paused campaign is not dragged back into the queue by a balance read', async () => {
    const rt = await runtime('100', 'paused');
    const body = (await (await rt.handleCheckFunding('camp-launch')).json()) as { advanced: boolean };
    expect(body.advanced).toBe(false);
    expect(await statusOf(rt)).toBe('paused');
  });

  test('a live campaign is not demoted by a balance read', async () => {
    const rt = await runtime('100', 'active');
    const body = (await (await rt.handleCheckFunding('camp-launch')).json()) as { advanced: boolean };
    expect(body.advanced).toBe(false);
    expect(await statusOf(rt)).toBe('active');
  });
});

describe('who may take a campaign live', () => {
  test('an operator with the secret launches a funded campaign', async () => {
    const rt = await runtime('100', 'awaiting_operator_approval');
    const res = await rt.handleApproveCampaign(approve('operator-key'), 'camp-launch');

    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({ status: 'active' });
    expect(await statusOf(rt)).toBe('active');
  });

  test('a wrong secret is refused and the campaign stays queued', async () => {
    const rt = await runtime('100', 'awaiting_operator_approval');
    expect((await rt.handleApproveCampaign(approve('guess'), 'camp-launch')).status).toBe(401);
    expect(await statusOf(rt)).toBe('awaiting_operator_approval');
  });

  test('no secret at all is refused', async () => {
    const rt = await runtime('100', 'awaiting_operator_approval');
    expect((await rt.handleApproveCampaign(approve(), 'camp-launch')).status).toBe(401);
  });

  test('a deployment with no OPERATOR_SECRET refuses rather than launching open', async () => {
    const rt = await runtime('100', 'awaiting_operator_approval', { OPERATOR_SECRET: undefined });
    const res = await rt.handleApproveCampaign(approve('anything'), 'camp-launch');
    expect(res.status).toBe(503);
    expect(await statusOf(rt)).toBe('awaiting_operator_approval');
  });
});

describe('approval will not outrun the money', () => {
  test('a pool drained after the deposit was seen cannot be approved', async () => {
    // The window this closes: funding lands, the campaign queues, the brand
    // withdraws, and an operator clicks approve on a stale queue entry.
    const rt = await runtime('0', 'awaiting_operator_approval');
    const res = await rt.handleApproveCampaign(approve('operator-key'), 'camp-launch');

    expect(res.status).toBe(409);
    expect((await res.json()) as { coverage: string }).toMatchObject({ coverage: 'empty' });
    expect(await statusOf(rt)).toBe('awaiting_operator_approval');
  });

  test('a deployment that cannot read the chain refuses rather than opening blind', async () => {
    const rt = await runtime('100', 'awaiting_operator_approval');
    rt.balances = undefined;
    const res = await rt.handleApproveCampaign(approve('operator-key'), 'camp-launch');
    expect(res.status).toBe(503);
    expect(await statusOf(rt)).toBe('awaiting_operator_approval');
  });

  test('a campaign still waiting on funding cannot be approved', async () => {
    const rt = await runtime('100', 'pending_funding');
    const res = await rt.handleApproveCampaign(approve('operator-key'), 'camp-launch');
    expect(res.status).toBe(409);
    expect(await statusOf(rt)).toBe('pending_funding');
  });

  test('approving twice is not an error and does not reactivate a paused campaign', async () => {
    const rt = await runtime('100', 'active');
    expect((await rt.handleApproveCampaign(approve('operator-key'), 'camp-launch')).status).toBe(200);

    const paused = await runtime('100', 'paused');
    expect((await paused.handleApproveCampaign(approve('operator-key'), 'camp-launch')).status).toBe(409);
    expect(await statusOf(paused)).toBe('paused');
  });

  test('an unknown campaign is a 404, not a launch', async () => {
    const rt = await runtime('100');
    expect((await rt.handleApproveCampaign(approve('operator-key'), 'camp-nope')).status).toBe(404);
  });
});

describe('creators are not shown a pool nobody has funded', () => {
  test('a campaign waiting on funding is withheld from the public listing', async () => {
    const rt = await runtime('0', 'pending_funding');
    const view = await rt.publicView();
    expect(view.campaigns).toHaveLength(0);
  });

  test('a queued campaign is still not listed — funded is not the same as open', async () => {
    const rt = await runtime('100', 'awaiting_operator_approval');
    expect((await rt.publicView()).campaigns).toHaveLength(0);
  });

  test('once live it appears, with what backs it', async () => {
    const rt = await runtime('100', 'active');
    const view = await rt.publicView();
    expect(view.campaigns).toHaveLength(1);
    expect(view.campaigns[0]?.funding.coverage).toBe('covered');
  });
});

describe('a queued campaign pays nobody', () => {
  test('neither pre-launch status is picked up by a payout pass', async () => {
    for (const status of ['pending_funding', 'awaiting_operator_approval'] as const) {
      const rt = await runtime('100', status);
      const result = await rt.tick(new Date('2026-08-05T12:00:00.000Z'));
      expect(result.paid).toBe(0);
    }
  });
});
