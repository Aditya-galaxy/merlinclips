/**
 * A wallet for a creator who does not have one.
 *
 * The funnel hole this closes: a creator who has never held USDC reached the
 * submit form, was asked for a `0x…` address, and stopped. Everything else in
 * the product worked for them and the one field they could not fill was the
 * one that gets them paid.
 *
 * ## On request, never by default
 *
 * A developer-controlled wallet means Circle holds the keys on our behalf,
 * which means we hold them. That is a real change to what this product
 * promises — "we never hold your balance" is on three pages and load-bearing
 * in the compliance terms — so it is offered rather than imposed.
 *
 * A creator who brings their own address keeps using it and nothing about
 * their custody changes. A creator who has none can ask for one, and the
 * copy says plainly what they are agreeing to.
 *
 * ## Absent until configured
 *
 * Without CIRCLE_API_KEY and ENTITY_SECRET this reports unavailable and the
 * app does not offer the option. Same shape as sign-in: a feature that cannot
 * work should be absent rather than present and failing.
 *
 * The entity secret is the key to every wallet in the set. It is read from the
 * environment, never logged, never returned in a response, and never written
 * to the event log.
 */

import type { Chain } from '../schemas';

/** Circle's identifiers for the chains this settles on. */
const CIRCLE_CHAIN: Partial<Record<Chain, string>> = {
  base: 'BASE',
  'base-sepolia': 'BASE-SEPOLIA',
  ethereum: 'ETH',
  'eth-sepolia': 'ETH-SEPOLIA',
  polygon: 'MATIC',
  'polygon-amoy': 'MATIC-AMOY',
};

export interface WalletConfig {
  readonly apiKey: string;
  readonly entitySecret: string;
  /** Created once and reused; every creator wallet lives in this set. */
  readonly walletSetId?: string;
}

export function walletConfig(env: Record<string, string | undefined>): WalletConfig | undefined {
  const apiKey = env.CIRCLE_API_KEY?.trim();
  // Either name. The registration script writes CIRCLE_ENTITY_SECRET and
  // Circle's own examples read ENTITY_SECRET, so whichever a deployment ends
  // up with, this finds it. A mismatch here fails as "wallet creation is not
  // enabled" — a message that sends somebody looking for a missing feature
  // rather than a misspelt variable.
  const entitySecret = (env.ENTITY_SECRET ?? env.CIRCLE_ENTITY_SECRET)?.trim();
  if (!apiKey || !entitySecret) return undefined;
  return { apiKey, entitySecret, walletSetId: env.CIRCLE_WALLET_SET_ID?.trim() };
}

export interface CreatedWallet {
  readonly walletId: string;
  readonly address: string;
  readonly chain: Chain;
}

export type WalletOutcome =
  | { readonly ok: true; readonly wallet: CreatedWallet }
  | { readonly ok: false; readonly reason: string; readonly configured: boolean };

/** The SDK surface actually used, so this stays testable without a network. */
export interface WalletsClient {
  createWalletSet(input: { name: string }): Promise<{ data?: { walletSet?: { id?: string } } }>;
  createWallets(input: {
    accountType: string; blockchains: string[]; count: number; walletSetId: string;
  }): Promise<{ data?: { wallets?: Array<{ id?: string; address?: string }> } }>;
}

/**
 * SCA rather than EOA.
 *
 * An EOA needs native gas before it can move anything, so a creator's first
 * payout would land in a wallet they cannot spend from until somebody sends
 * them ETH. On an L2 an SCA can be sponsored, and the point of this feature is
 * that a creator never has to learn what gas is.
 */
const ACCOUNT_TYPE = 'SCA';

export async function createCreatorWallet(
  client: WalletsClient | undefined,
  chain: Chain,
  walletSetId: string | undefined,
  ensureSet: () => Promise<string | undefined>,
): Promise<WalletOutcome> {
  if (!client) {
    return { ok: false, configured: false, reason: 'wallet creation is not enabled here' };
  }
  const blockchain = CIRCLE_CHAIN[chain];
  if (!blockchain) {
    return { ok: false, configured: true, reason: `no Circle chain for ${chain}` };
  }

  try {
    const setId = walletSetId ?? (await ensureSet());
    if (!setId) {
      return { ok: false, configured: true, reason: 'could not open a wallet set' };
    }

    const created = await client.createWallets({
      accountType: ACCOUNT_TYPE,
      blockchains: [blockchain],
      count: 1,
      walletSetId: setId,
    });

    const wallet = created.data?.wallets?.[0];
    if (!wallet?.address || !wallet.id) {
      return { ok: false, configured: true, reason: 'Circle returned no wallet' };
    }
    return { ok: true, wallet: { walletId: wallet.id, address: wallet.address, chain } };
  } catch (error) {
    // Never surface the underlying message: it can carry request details, and
    // this string reaches a browser.
    return { ok: false, configured: true, reason: 'could not create a wallet just now' };
  }
}

/** Exported for tests and for anyone auditing which chains are reachable. */
export function circleChain(chain: Chain): string | undefined {
  return CIRCLE_CHAIN[chain];
}
