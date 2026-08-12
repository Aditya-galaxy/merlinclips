/**
 * Creator Account & Linked Wallet Management.
 *
 * Fulfills the sign-up promise: an Account owns multiple payout EVM wallets,
 * and standing/payouts aggregate across all addresses owned by the creator.
 */

import type { Chain } from '../schemas';
import type { CreatorAccount, LinkedWallet } from './types';
import type { CampaignStore } from './store';

export class AccountService {
  constructor(private readonly store: CampaignStore) {}

  getOrCreateAccount(params: {
    accountId: string;
    googleSub?: string;
    name: string;
    email: string;
  }): CreatorAccount {
    const existing = this.store.getCreatorAccount(params.accountId);
    if (existing) return existing;

    const account: CreatorAccount = {
      accountId: params.accountId,
      googleSub: params.googleSub,
      name: params.name,
      email: params.email,
      joinedAt: new Date().toISOString(),
      linkedWallets: [],
    };

    this.store.putCreatorAccount(account);
    return account;
  }

  linkWallet(accountId: string, address: string, chain: Chain = 'base'): CreatorAccount {
    const normalized = address.trim().toLowerCase();
    const account = this.getOrCreateAccount({
      accountId,
      name: 'Creator',
      email: `${accountId}@merlinclips.user`,
    });

    const alreadyLinked = account.linkedWallets.some(
      (w) => w.address.toLowerCase() === normalized,
    );
    if (alreadyLinked) return account;

    const newWallet: LinkedWallet = {
      address: normalized,
      chain,
      firstSeenAt: new Date().toISOString(),
    };

    const updated: CreatorAccount = {
      ...account,
      linkedWallets: [...account.linkedWallets, newWallet],
    };

    this.store.putCreatorAccount(updated);
    return updated;
  }

  getProfile(accountId: string): CreatorAccount | undefined {
    return this.store.getCreatorAccount(accountId);
  }
}

/**
 * Returns all wallet addresses linked to a given creator account.
 */
export function walletsFor(account: CreatorAccount): readonly string[] {
  return account.linkedWallets.map((w) => w.address.toLowerCase());
}

/**
 * Returns all creator IDs (address-keyed) associated with an account.
 */
export function creatorIdsFor(account: CreatorAccount): readonly string[] {
  return account.linkedWallets.map((w) => w.address.toLowerCase());
}

/**
 * Links a wallet address to an account in the store.
 */
export function linkWallet(
  store: CampaignStore,
  accountId: string,
  address: string,
  chain: Chain = 'base',
): CreatorAccount {
  const service = new AccountService(store);
  return service.linkWallet(accountId, address, chain);
}
