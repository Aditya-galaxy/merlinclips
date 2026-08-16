/**
 * Proving a creator controls the address their USDC goes to.
 *
 * Until now a payout address was typed into a box. Nothing checked that the
 * person typing it could open the wallet, so a single mistyped character sent
 * real USDC to an address nobody holds — irrecoverably, and only discovered
 * after the clip had already earned. That is the failure this removes.
 *
 * The mechanism is a signature, not a connection. A wallet extension reporting
 * an address proves only that the extension will say so; signing a challenge
 * with that address's key is what proves control. So "connect wallet" is the
 * convenience and this is the substance.
 *
 * ## Why the nonce is issued here and not chosen by the caller
 *
 * A signature over a caller-chosen string is a signature over anything they
 * already have. If a creator ever signs a message on some other site, that
 * signature could be replayed here. The server issues the challenge, remembers
 * it, and spends it on first use — so a captured signature is worth exactly one
 * attempt, on the account it was issued to, inside its window.
 *
 * ## What it deliberately does not do
 *
 * It does not prove the address can *receive* — every address can. It does not
 * prove the creator owns the channel they clip from; that is a different
 * problem, addressed by one-post-one-claimant. It proves that whoever links
 * this address holds its key, which is the only question that matters for
 * where money is sent.
 */

import { verifyMessage } from 'viem';

/** How long a challenge stays valid. Long enough to read, short enough to matter. */
const CHALLENGE_TTL_MS = 5 * 60_000;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface Challenge {
  readonly nonce: string;
  readonly accountId: string;
  readonly issuedAt: number;
}

export type LinkResult =
  | { ok: true; address: string }
  | { ok: false; reason: string };

/**
 * The text a creator is asked to sign.
 *
 * Written to be read by the person approving it, because a wallet shows this
 * verbatim and an unreadable challenge trains people to approve without
 * looking. It names what is being agreed, the account agreeing, and the nonce
 * that makes it single-use.
 */
export function challengeMessage(input: { nonce: string; address: string; host: string }): string {
  return [
    `Link this wallet to your ${input.host} account.`,
    '',
    'This proves you control the address your USDC will be sent to.',
    'It is not a transaction and moves no funds.',
    '',
    `Wallet: ${input.address}`,
    `Nonce: ${input.nonce}`,
  ].join('\n');
}

/**
 * Challenges that have been issued and not yet spent.
 *
 * In memory, and bounded by the TTL. A challenge surviving a restart would be
 * worse than one that does not: the point is that it is spent once, and an
 * instance that forgets is an instance that refuses, which is the safe
 * direction. A creator whose challenge is forgotten asks for another.
 */
export class ChallengeStore {
  private readonly live = new Map<string, Challenge>();

  constructor(private readonly ttlMs: number = CHALLENGE_TTL_MS) {}

  issue(accountId: string): Challenge {
    this.forgetExpired();
    const nonce = crypto.randomUUID().replace(/-/g, '');
    const challenge = { nonce, accountId, issuedAt: Date.now() };
    this.live.set(nonce, challenge);
    return challenge;
  }

  /** Returns the challenge and removes it. Single use, by construction. */
  spend(nonce: string): Challenge | undefined {
    this.forgetExpired();
    const found = this.live.get(nonce);
    if (found) this.live.delete(nonce);
    return found;
  }

  private forgetExpired(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [nonce, c] of this.live) if (c.issuedAt < cutoff) this.live.delete(nonce);
  }
}

/**
 * Check a signed challenge and report the address it proves.
 *
 * Every failure is a refusal with a reason a person can act on. The address is
 * returned lowercased, because it is used as a key and a checksummed spelling
 * of the same address must not read as a different wallet.
 */
export async function verifyLink(input: {
  accountId: string;
  address: unknown;
  signature: unknown;
  nonce: unknown;
  host: string;
  challenges: ChallengeStore;
}): Promise<LinkResult> {
  const address = typeof input.address === 'string' ? input.address.trim() : '';
  const signature = typeof input.signature === 'string' ? input.signature.trim() : '';
  const nonce = typeof input.nonce === 'string' ? input.nonce.trim() : '';

  if (!ADDRESS.test(address)) {
    return { ok: false, reason: 'that is not a Base address — 0x followed by 40 characters' };
  }
  if (!signature.startsWith('0x') || signature.length < 66) {
    return { ok: false, reason: 'the signature is missing or malformed' };
  }

  const challenge = input.challenges.spend(nonce);
  if (!challenge) {
    // Covers unknown, expired and already-spent alike, on purpose: telling a
    // caller which of the three would help someone probing for a live nonce.
    return { ok: false, reason: 'that challenge has expired or was already used — ask for a new one' };
  }

  if (challenge.accountId !== input.accountId) {
    // A challenge issued to one account, presented by another. The signature
    // may be perfectly valid and still prove nothing about this session.
    return { ok: false, reason: 'that challenge was issued to a different account' };
  }

  const message = challengeMessage({ nonce: challenge.nonce, address, host: input.host });

  let valid = false;
  try {
    valid = await verifyMessage({
      address: address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    // A malformed signature throws rather than returning false.
    return { ok: false, reason: 'the signature could not be read' };
  }

  if (!valid) {
    // The signature is real but recovers to a different address — which is
    // what a replayed or borrowed signature looks like.
    return { ok: false, reason: 'that signature was not made by this wallet' };
  }

  return { ok: true, address: address.toLowerCase() };
}
