/**
 * A campaign cannot be opened against a wallet we could never pay from.
 *
 * A campaign is funded to `campaign.fundingWallet` and settled out of that same
 * wallet. Name an address this deployment holds no key for and the campaign
 * takes a brand's deposit, shows creators a funded brief, accepts their clips —
 * and fails at the first payout, after the work is done and the money is in a
 * wallet we cannot spend from.
 *
 * The container has no Circle CLI, so it cannot ask which wallets it holds. The
 * deployment declares them, and creation checks against that. Checked at
 * creation rather than settlement purely because of when it hurts: at creation
 * nothing has happened and the caller can pick another wallet.
 */

import { describe, expect, test } from 'bun:test';

import { MemoryBlobStore } from './persistence';
import { CampaignRuntime, signableWallets } from './runtime';

const OURS = '0xf461c5bb7e314670ae5c5eeb9929b15728ab2b6c';
const THEIRS = '0x0003a59858f44451be2a5b486ee612b4139700f0';

const SECRET = 's'.repeat(32);

const body = (fundingWallet?: string) => ({
  brief: 'Clip the launch stream and keep it under 60 seconds.',
  poolUsdc: '100',
  cpmUsdc: '2',
  perCreatorCapUsdc: '10',
  dwellHours: 24,
  platforms: ['youtube'],
  chain: 'base-sepolia',
  ...(fundingWallet === undefined ? {} : { fundingWallet }),
});

async function create(env: Record<string, string | undefined>, fundingWallet?: string) {
  const rt = new CampaignRuntime({
    blobs: new MemoryBlobStore(),
    env: { SESSION_SECRET: SECRET, ...env },
  });
  await rt.ready();
  const res = await rt.handleAgentCampaign(
    new Request('http://x/mcp/campaigns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body(fundingWallet)),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('reading the declared list', () => {
  test('a comma-separated list is parsed and lowercased', () => {
    // Addresses arrive checksummed from block explorers and lowercased from
    // our own JSON. Matching case-sensitively would reject a wallet we hold.
    const set = signableWallets({ SETTLEMENT_WALLETS: `0x${OURS.slice(2).toUpperCase()}, ${THEIRS}` });
    expect(set.has(OURS)).toBe(true);
    expect(set.has(THEIRS)).toBe(true);
  });

  test('unset is an empty set, not a set containing an empty string', () => {
    // `''.split(',')` is `['']`, so the naive version holds one entry that
    // matches a campaign with no wallet.
    expect(signableWallets({}).size).toBe(0);
    expect(signableWallets({ SETTLEMENT_WALLETS: '' }).size).toBe(0);
    expect(signableWallets({ SETTLEMENT_WALLETS: ' , ' }).size).toBe(0);
  });

  test('the mainnet list is read only when mainnet is armed', () => {
    // A Circle agent wallet lives on one chain, so reading the wrong list
    // means holding keys for none of the addresses in it.
    const env = { SETTLEMENT_WALLETS: OURS, MAINNET_SETTLEMENT_WALLETS: THEIRS };
    expect([...signableWallets(env)]).toEqual([OURS]);
    expect([...signableWallets({ ...env, ALLOW_MAINNET: 'true' })]).toEqual([THEIRS]);
  });
});

describe('opening a campaign against a wallet we hold', () => {
  test('is accepted', async () => {
    const { status, json } = await create({ SETTLEMENT_WALLETS: OURS }, OURS);
    expect(status).toBe(201);
    expect(json.depositTo).toBe(OURS);
  });

  test('is accepted in the checksummed form a block explorer shows', async () => {
    // `0x` stays lowercase — uppercasing that is a malformed address and is
    // rejected earlier, by validation rather than by this guard.
    const checksummed = '0x' + OURS.slice(2).toUpperCase();
    const { status } = await create({ SETTLEMENT_WALLETS: OURS }, checksummed);
    expect(status).toBe(201);
  });
});

describe('opening a campaign against a wallet we do not hold', () => {
  test('is refused before the campaign exists', async () => {
    const { status, json } = await create({ SETTLEMENT_WALLETS: OURS }, THEIRS);
    expect(status).toBe(400);
    expect(json.field).toBe('fundingWallet');
  });

  test('the refusal explains the consequence, not just the rule', async () => {
    // The caller is an agent that will otherwise retry with the same address.
    // It needs to know this is about custody, not a formatting mistake.
    const { json } = await create({ SETTLEMENT_WALLETS: OURS }, THEIRS);
    expect(json.error).toContain('never pay a creator');
    expect(json.error).toContain(THEIRS);
  });

  test('nothing is recorded, so a retry with a good wallet is clean', async () => {
    const rt = new CampaignRuntime({
      blobs: new MemoryBlobStore(),
      env: { SESSION_SECRET: SECRET, SETTLEMENT_WALLETS: OURS },
    });
    await rt.ready();
    const post = (w: string) =>
      rt.handleAgentCampaign(new Request('http://x/mcp/campaigns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body(w)),
      }));

    expect((await post(THEIRS)).status).toBe(400);
    expect(rt.store.exportState().campaigns).toEqual([]);
    expect((await post(OURS)).status).toBe(201);
  });
});

describe('a deployment with no settlement rail', () => {
  test('accepts any wallet, because it pays from none of them', async () => {
    // Singling out one address would be misleading when the deployment settles
    // nothing at all — that is a `DryRunExecutor`, and it is visible elsewhere.
    const { status } = await create({}, THEIRS);
    expect(status).toBe(201);
  });
});
