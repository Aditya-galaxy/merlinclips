import { describe, expect, it } from 'bun:test';
import { circleChain, createCreatorWallet, walletConfig, type WalletsClient } from './wallets';

const OK: WalletsClient = {
  async createWalletSet() { return { data: { walletSet: { id: 'set-1' } } }; },
  async createWallets() {
    return { data: { wallets: [{ id: 'wal-1', address: '0xabc0000000000000000000000000000000000001' }] } };
  },
};
const never = async () => undefined;
const makeSet = async () => 'set-made';

describe('configuration', () => {
  // Same shape as sign-in: a feature that cannot work should be absent rather
  // than present and failing.
  it('is undefined unless both secrets are present', () => {
    expect(walletConfig({})).toBeUndefined();
    expect(walletConfig({ CIRCLE_API_KEY: 'k' })).toBeUndefined();
    expect(walletConfig({ ENTITY_SECRET: 's' })).toBeUndefined();
    expect(walletConfig({ CIRCLE_API_KEY: 'k', ENTITY_SECRET: 's' })).toBeDefined();
  });

  it('treats whitespace as absent', () => {
    expect(walletConfig({ CIRCLE_API_KEY: '  ', ENTITY_SECRET: 's' })).toBeUndefined();
  });
});

describe('creating a wallet', () => {
  it('returns the address and the wallet id', async () => {
    const r = await createCreatorWallet(OK, 'base-sepolia', 'set-1', never);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.wallet.address).toMatch(/^0x[0-9a-f]{40}$/i);
    expect(r.wallet.walletId).toBe('wal-1');
    expect(r.wallet.chain).toBe('base-sepolia');
  });

  it('opens a wallet set when none was configured', async () => {
    let opened = false;
    const r = await createCreatorWallet(OK, 'base', undefined, async () => {
      opened = true; return 'set-made';
    });
    expect(opened).toBe(true);
    expect(r.ok).toBe(true);
  });
});

describe('when it cannot', () => {
  it('says so, and says whether it was ever configured', async () => {
    const r = await createCreatorWallet(undefined, 'base', 'set-1', never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.configured).toBe(false);
  });

  it('refuses a chain Circle does not name', async () => {
    const r = await createCreatorWallet(OK, 'solana' as never, 'set-1', never);
    expect(r.ok).toBe(false);
  });

  it('refuses when no wallet set can be opened', async () => {
    const r = await createCreatorWallet(OK, 'base', undefined, never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('wallet set');
  });

  it('refuses when Circle returns nothing usable', async () => {
    const empty: WalletsClient = { ...OK, async createWallets() { return { data: { wallets: [] } }; } };
    const r = await createCreatorWallet(empty, 'base', 'set-1', never);
    expect(r.ok).toBe(false);
  });

  // The reason string reaches a browser, and an SDK error can carry request
  // details with it.
  it('does not leak the underlying error to the caller', async () => {
    const boom: WalletsClient = {
      ...OK,
      async createWallets() { throw new Error('entity secret ciphertext rejected for key abc123'); },
    };
    const r = await createCreatorWallet(boom, 'base', 'set-1', makeSet);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).not.toContain('entity secret');
      expect(r.reason).not.toContain('abc123');
    }
  });
});

describe('chains', () => {
  it('names every chain this settles on', () => {
    for (const c of ['base', 'base-sepolia', 'ethereum', 'eth-sepolia',
      'polygon', 'polygon-amoy'] as const) {
      expect(circleChain(c)).toBeTruthy();
    }
  });

  it('keeps mainnet and testnet distinct', () => {
    expect(circleChain('base')).not.toBe(circleChain('base-sepolia'));
  });
});
