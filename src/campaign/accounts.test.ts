import { describe, expect, it } from 'bun:test';
import { MemoryBlobStore } from './persistence';
import {
  accountWalletKey, creatorIdsFor, linkWallet, walletOwnerKey, walletsFor,
} from './accounts';

const ALICE = 'cre-g-aaaaaaaaaaaaaaaa';
const BOB = 'cre-g-bbbbbbbbbbbbbbbb';
const W1 = '0x840175F5106eb2FAa7408c0B38002e09f80D5Da2';
const W2 = '0x000000000000000000000000000000000000dEaD';

describe('claiming a wallet', () => {
  it('links it to the account that used it first', async () => {
    const s = new MemoryBlobStore();
    const r = await linkWallet(s, ALICE, W1);
    expect(r.status).toBe('linked');
    expect(await walletsFor(s, ALICE)).toEqual([W1.toLowerCase()]);
  });

  it('is idempotent for the same account', async () => {
    const s = new MemoryBlobStore();
    await linkWallet(s, ALICE, W1);
    expect((await linkWallet(s, ALICE, W1)).status).toBe('already_yours');
    expect(await walletsFor(s, ALICE)).toHaveLength(1);
  });

  it('collects several wallets under one account', async () => {
    const s = new MemoryBlobStore();
    await linkWallet(s, ALICE, W1);
    await linkWallet(s, ALICE, W2);
    expect(await walletsFor(s, ALICE)).toEqual([W2.toLowerCase(), W1.toLowerCase()].sort());
  });

  it('treats the address case-insensitively, since chains do', async () => {
    const s = new MemoryBlobStore();
    await linkWallet(s, ALICE, W1.toUpperCase().replace('0X', '0x'));
    expect((await linkWallet(s, ALICE, W1.toLowerCase())).status).toBe('already_yours');
  });
});

// Without first-use-wins, a second account could name a wallet it does not
// control and inherit somebody else's earnings, standing and payout record.
describe('a wallet another account already claimed', () => {
  it('is refused, and names who holds it', async () => {
    const s = new MemoryBlobStore();
    await linkWallet(s, ALICE, W1);
    const r = await linkWallet(s, BOB, W1);
    expect(r.status).toBe('claimed_by_another');
    if (r.status === 'claimed_by_another') expect(r.owner).toBe(ALICE);
  });

  it('does not appear among the second account wallets', async () => {
    const s = new MemoryBlobStore();
    await linkWallet(s, ALICE, W1);
    await linkWallet(s, BOB, W1);
    expect(await walletsFor(s, BOB)).toEqual([]);
    expect(await walletsFor(s, ALICE)).toEqual([W1.toLowerCase()]);
  });

  it('leaves the original claim untouched', async () => {
    const s = new MemoryBlobStore();
    await linkWallet(s, ALICE, W1);
    await linkWallet(s, BOB, W1);
    const owner = JSON.parse((await s.get(walletOwnerKey(W1)))!);
    expect(owner.accountId).toBe(ALICE);
  });
});

describe('when storage misbehaves', () => {
  // Linking is best-effort; earning is not. A creator is paid to an address,
  // and the address has not changed because a blob write failed.
  it('reports unavailable rather than throwing', async () => {
    const broken = {
      get: async () => { throw new Error('down'); },
      put: async () => { throw new Error('down'); },
      list: async () => { throw new Error('down'); },
      putIfAbsent: async () => { throw new Error('down'); },
    };
    expect((await linkWallet(broken, ALICE, W1)).status).toBe('unavailable');
    expect(await walletsFor(broken, ALICE)).toEqual([]);
  });

  it('repairs a half-written link on the next submission', async () => {
    const s = new MemoryBlobStore();
    // Owner key written, account-side key never was.
    await s.putIfAbsent(walletOwnerKey(W1),
      JSON.stringify({ accountId: ALICE, wallet: W1.toLowerCase(), firstSeen: 'x' }));
    expect(await walletsFor(s, ALICE)).toEqual([]);
    expect((await linkWallet(s, ALICE, W1)).status).toBe('already_yours');
    expect(await walletsFor(s, ALICE)).toEqual([W1.toLowerCase()]);
  });

  it('refuses empty inputs without touching storage', async () => {
    const s = new MemoryBlobStore();
    expect((await linkWallet(s, '', W1)).status).toBe('unavailable');
    expect((await linkWallet(s, ALICE, '   ')).status).toBe('unavailable');
  });
});

describe('finding the work', () => {
  it('maps wallets onto the creator ids submissions are filed under', () => {
    expect(creatorIdsFor([W1.toLowerCase(), W2.toLowerCase()]))
      .toEqual([`cre-${W1.toLowerCase()}`, `cre-${W2.toLowerCase()}`]);
  });

  it('ignores anything in the account prefix that is not an address', async () => {
    const s = new MemoryBlobStore();
    await linkWallet(s, ALICE, W1);
    await s.put(accountWalletKey(ALICE, 'not-an-address'), '{}');
    expect(await walletsFor(s, ALICE)).toEqual([W1.toLowerCase()]);
  });
});
