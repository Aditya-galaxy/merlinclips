/**
 * Money leaves the wallet coverage was checked against.
 *
 * These were two different addresses. `fundingFor` read `campaign.fundingWallet`
 * — the address a brand is told to deposit to, and the balance a creator sees
 * described as backing the pool — while every payout transferred out of a
 * single deployment-wide `CAMPAIGN_WALLET`.
 *
 * So "this campaign is covered" was a statement about a wallet that had nothing
 * to do with the payment. A campaign could read `covered` while the wallet
 * actually paying was empty, and a brand's deposit could sit untouched while
 * their creators were paid out of a balance belonging to somebody else. With
 * one campaign and one operator wallet the two happened to coincide, which is
 * why it survived; with two brands it is other people's money.
 *
 * The payer is now the campaign's own wallet, and a campaign without one is
 * refused rather than charged to the operator.
 */

import { describe, expect, test } from 'bun:test';

import { Decimal } from '../decimal';
import { CircleCliExecutor, type CommandRunner } from './executor';
import type { PayoutDecision } from './payout';
import type { Campaign, Creator } from './types';

const CREATOR: Creator = { creatorId: 'cre-1', payoutAddress: '0xdest', handles: {} };
const BRAND_A = '0xaaa1111111111111111111111111111111111111';
const BRAND_B = '0xbbb2222222222222222222222222222222222222';

const campaign = (fundingWallet?: string): Campaign => ({
  campaignId: 'camp-1',
  brief: 'brief',
  poolUsdc: new Decimal('100'),
  cpmUsdc: new Decimal('1'),
  rateBand: { minUsdc: new Decimal('0.5'), maxUsdc: new Decimal('2') },
  perCreatorCapUsdc: new Decimal('10'),
  dwellMs: 86_400_000,
  settlementWindowMs: 14 * 86_400_000,
  platforms: ['youtube'],
  chain: 'base-sepolia',
  status: 'active',
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-09-01T00:00:00.000Z',
  fundingWallet,
});

const DECISION = {
  submissionId: 'sub-1',
  campaignId: 'camp-1',
  creatorId: 'cre-1',
  disposition: 'auto_pay',
  control: 'mandated',
  reason: 'within caps',
  confirmedViews: 2_000n,
  payableViews: 2_000n,
  amountUsdc: new Decimal('2'),
  decidedAt: '2026-08-05T12:00:00.000Z',
} as unknown as PayoutDecision;

function spy() {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(args) {
      calls.push(args);
      return { code: 0, stdout: '0x' + 'e'.repeat(64), stderr: '' };
    },
  };
  return { calls, runner };
}

/** Broadcasting for real, so the argv under test is the one that moves money. */
const live = (runner: CommandRunner) =>
  new CircleCliExecutor({ runner, dryRun: false, env: { BROADCAST: 'true' } });

const payerIn = (args: string[]) => args[args.indexOf('--address') + 1];

describe('the payer is the campaign', () => {
  test('the transfer leaves the campaign funding wallet', async () => {
    const { calls, runner } = spy();
    await live(runner).send({ decision: DECISION, creator: CREATOR, campaign: campaign(BRAND_A) });
    expect(payerIn(calls[0]!)).toBe(BRAND_A);
  });

  test('two campaigns pay from their own wallets, not a shared one', async () => {
    // The property that makes coverage mean anything once there is more than
    // one brand. One executor, two campaigns, two different payers.
    const { calls, runner } = spy();
    const executor = live(runner);
    await executor.send({ decision: DECISION, creator: CREATOR, campaign: campaign(BRAND_A) });
    await executor.send({ decision: DECISION, creator: CREATOR, campaign: campaign(BRAND_B) });
    expect([payerIn(calls[0]!), payerIn(calls[1]!)]).toEqual([BRAND_A, BRAND_B]);
  });
});

describe('a campaign with no wallet is refused, not charged to the operator', () => {
  test('nothing is sent', async () => {
    const { calls, runner } = spy();
    await live(runner).send({ decision: DECISION, creator: CREATOR, campaign: campaign(undefined) });
    // Not "sent from a default" and not "sent with an empty --address": the
    // CLI is never reached at all.
    expect(calls).toEqual([]);
  });

  test('it reports executed: false so no payout is recorded', async () => {
    // The tick records a payout and marks views settled off `executed`. A
    // refusal that reported success would mark views paid for money that never
    // moved, and those views never pay again.
    const { runner } = spy();
    const outcome = await live(runner)
      .send({ decision: DECISION, creator: CREATOR, campaign: campaign(undefined) });
    expect(outcome.executed).toBe(false);
    expect(outcome.txHash).toBeUndefined();
  });

  test('the reason names the campaign rather than blaming the chain', async () => {
    const { runner } = spy();
    const outcome = await live(runner)
      .send({ decision: DECISION, creator: CREATOR, campaign: campaign(undefined) });
    expect(outcome.error).toContain('camp-1');
    expect(outcome.detail).toContain('no funding wallet');
  });

  test('an empty-string wallet is treated as absent, not sent as blank', async () => {
    // `--address ''` would be accepted as an argument and fail somewhere less
    // obvious, or worse, be filled in by the CLI's default wallet.
    const { calls, runner } = spy();
    const outcome = await live(runner)
      .send({ decision: DECISION, creator: CREATOR, campaign: campaign('   ') });
    expect(calls).toEqual([]);
    expect(outcome.executed).toBe(false);
  });
});
