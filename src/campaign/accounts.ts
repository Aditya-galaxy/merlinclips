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
 * The creator id a payout address is stored under.
 *
 * One definition, because there were two and they disagreed silently. A
 * submission is recorded against `cre-<address>` (intake.ts), while every
 * place that looked one up compared against the bare address — so
 * `ids.has(submission.creatorId)` asked whether a set of addresses contained
 * a `cre-`-prefixed string, which it never did.
 *
 * The result was that no creator ever saw their own clips, earnings or
 * campaign history: the dashboard read zero for everyone regardless of what
 * they had submitted or been paid. It looked like an empty account rather than
 * a broken query, which is why it survived.
 */
export function creatorIdOf(address: string): string {
  return `cre-${address.trim().toLowerCase()}`;
}

/**
 * Every creator id an account owns, in the form submissions are stored under.
 *
 * This returned bare addresses despite its name and its own doc comment
 * promising ids — identical to `walletsFor`, and wrong wherever the difference
 * mattered.
 */
export function creatorIdsFor(account: CreatorAccount): readonly string[] {
  return account.linkedWallets.flatMap((w) => bothFormsOf(w.address));
}

/**
 * Both spellings a creator id has ever been written in.
 *
 * `intake.ts` mints `cre-<address>`, and records exist keyed on the bare
 * address as well. Which is canonical matters less than which is *found*: this
 * resolves who a payout belongs to, so matching one form and missing the other
 * means telling someone they have earned nothing when they have been paid.
 *
 * Accepting both cannot over-match — an address only ever belongs to its own
 * owner in either spelling — so the asymmetry runs the safe way.
 */
export function bothFormsOf(address: string): string[] {
  const bare = address.trim().toLowerCase();
  return [bare, creatorIdOf(bare)];
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
