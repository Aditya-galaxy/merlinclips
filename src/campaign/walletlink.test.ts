/**
 * Proving control of a payout address.
 *
 * A payout address was typed into a box, so one mistyped character sent real
 * USDC to a wallet nobody holds — irrecoverably, and only discovered after the
 * clip had earned. A signature is what removes that, and only if the checks
 * around it hold.
 *
 * The interesting cases are not "a valid signature works". They are the four
 * ways a valid signature proves nothing: made for a different address, made
 * for a different account, made from a nonce we never issued, and made once
 * but presented twice.
 */

import { describe, expect, test } from 'bun:test';
import { privateKeyToAccount } from 'viem/accounts';

import { ChallengeStore, challengeMessage, verifyLink } from './walletlink';

const HOST = 'merlinclips.com';
const KEY_A = ('0x' + '1'.repeat(64)) as `0x${string}`;
const KEY_B = ('0x' + '2'.repeat(64)) as `0x${string}`;

const signer = (key: `0x${string}`) => privateKeyToAccount(key);

/** Issue, sign honestly, and present — the path a real creator takes. */
async function link(options: {
  key?: `0x${string}`;
  claimAddress?: string;
  accountId?: string;
  presentAs?: string;
  challenges?: ChallengeStore;
  nonce?: string;
} = {}) {
  const challenges = options.challenges ?? new ChallengeStore();
  const accountId = options.accountId ?? 'acct-1';
  const issued = options.nonce
    ? { nonce: options.nonce }
    : challenges.issue(accountId);

  const account = signer(options.key ?? KEY_A);
  const address = options.claimAddress ?? account.address;
  const signature = await account.signMessage({
    message: challengeMessage({ nonce: issued.nonce, address, host: HOST }),
  });

  return verifyLink({
    accountId: options.presentAs ?? accountId,
    address, signature, nonce: issued.nonce, host: HOST, challenges,
  });
}

describe('a creator proving their own wallet', () => {
  test('is accepted, and the address comes back lowercased', async () => {
    // Lowercased because it is used as a key — a checksummed spelling of the
    // same address must not read as a different wallet.
    const r = await link();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.address).toBe(signer(KEY_A).address.toLowerCase());
  });
});

describe('a signature that proves nothing', () => {
  test('signed by a different wallet than the one claimed', async () => {
    // The attack the whole thing exists to stop: claim an address, sign with
    // a key you actually hold.
    const r = await link({ key: KEY_B, claimAddress: signer(KEY_A).address });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('not made by this wallet');
  });

  test('a nonce we never issued', async () => {
    // A signature over a string the caller chose is a signature over anything
    // they already had.
    const r = await link({ nonce: 'nonce-we-never-issued' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('expired or was already used');
  });

  test('a challenge issued to a different account', async () => {
    // Perfectly valid signature, wrong session. It proves someone holds that
    // key, not that *this* creator does.
    const r = await link({ accountId: 'acct-1', presentAs: 'acct-2' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('different account');
  });

  test('the same challenge twice — replay', async () => {
    const challenges = new ChallengeStore();
    const accountId = 'acct-1';
    const issued = challenges.issue(accountId);
    const account = signer(KEY_A);
    const signature = await account.signMessage({
      message: challengeMessage({ nonce: issued.nonce, address: account.address, host: HOST }),
    });
    const args = {
      accountId, address: account.address, signature,
      nonce: issued.nonce, host: HOST, challenges,
    };

    expect((await verifyLink(args)).ok).toBe(true);
    const second = await verifyLink(args);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toContain('already used');
  });

  test('an expired challenge', async () => {
    const challenges = new ChallengeStore(0);
    const r = await link({ challenges });
    expect(r.ok).toBe(false);
  });
});

describe('malformed input is refused before any crypto runs', () => {
  test('a non-address', async () => {
    const challenges = new ChallengeStore();
    const { nonce } = challenges.issue('acct-1');
    const r = await verifyLink({
      accountId: 'acct-1', address: 'not-an-address', signature: '0x' + 'a'.repeat(130),
      nonce, host: HOST, challenges,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('not a Base address');
  });

  test('a missing signature', async () => {
    const challenges = new ChallengeStore();
    const { nonce } = challenges.issue('acct-1');
    const r = await verifyLink({
      accountId: 'acct-1', address: signer(KEY_A).address, signature: '',
      nonce, host: HOST, challenges,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('missing or malformed');
  });

  test('a signature that is not decodable at all', async () => {
    const challenges = new ChallengeStore();
    const { nonce } = challenges.issue('acct-1');
    const r = await verifyLink({
      accountId: 'acct-1', address: signer(KEY_A).address,
      signature: '0x' + 'z'.repeat(130), nonce, host: HOST, challenges,
    });
    expect(r.ok).toBe(false);
  });

  test('a bad address is refused without spending the challenge', async () => {
    // A typo must not cost the creator their nonce — they would have to start
    // over for a mistake the form should simply reject.
    const challenges = new ChallengeStore();
    const { nonce } = challenges.issue('acct-1');
    await verifyLink({
      accountId: 'acct-1', address: 'nope', signature: '0x' + 'a'.repeat(130),
      nonce, host: HOST, challenges,
    });
    const account = signer(KEY_A);
    const signature = await account.signMessage({
      message: challengeMessage({ nonce, address: account.address, host: HOST }),
    });
    const retry = await verifyLink({
      accountId: 'acct-1', address: account.address, signature, nonce, host: HOST, challenges,
    });
    expect(retry.ok).toBe(true);
  });
});

describe('the message a person is asked to approve', () => {
  test('says what it is, and that it moves nothing', async () => {
    // A wallet shows this verbatim. An unreadable challenge trains people to
    // approve without looking, which is the habit that gets them drained
    // somewhere else.
    const m = challengeMessage({ nonce: 'abc', address: '0x' + '1'.repeat(40), host: HOST });
    expect(m).toContain('moves no funds');
    expect(m).toContain('merlinclips.com');
    expect(m).toContain('abc');
  });
});
