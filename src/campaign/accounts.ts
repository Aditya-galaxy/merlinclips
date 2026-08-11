/**
 * Linking a signed-in account to the wallets it earns with.
 *
 * Two identity spaces existed and never met. A submission is filed under
 * `cre-<wallet>`, because the wallet is what gets paid. A session is
 * `cre-g-<hash of the Google subject>`, because that is what survives a change
 * of wallet. Nothing recorded that a wallet belonged to an account, so a
 * creator could sign in and find a profile with none of their own work in it.
 *
 * That gap also made the sign-up page untrue. It promises "your standing
 * follows you instead of resetting every time you use a different wallet",
 * which is only true once something writes the link down.
 *
 * ## First use wins, permanently
 *
 * A wallet is claimed by the first account that submits with it, through
 * `putIfAbsent` — the one operation the blob store guarantees is atomic.
 * Without that, a second account could name a wallet it does not control and
 * inherit somebody else's earnings history, standing and payout record.
 *
 * A conflict is not an error to retry. It means two accounts have claimed one
 * wallet, and the honest response is to refuse the link and let the submission
 * proceed unlinked: the creator still gets paid, because payment goes to the
 * address, and the address has not changed. Only the profile aggregation is
 * affected, and quietly attributing one creator's work to another account
 * would be a far worse failure than an incomplete profile.
 */

/** Who owns this wallet. One key, claimed once. */
export function walletOwnerKey(wallet: string): string {
  return `wallets/${wallet.toLowerCase()}.json`;
}

/** A wallet under an account, so an account's wallets can be listed. */
export function accountWalletKey(accountId: string, wallet: string): string {
  return `accounts/${accountId}/wallets/${wallet.toLowerCase()}.json`;
}

export const ACCOUNT_WALLET_PREFIX = (accountId: string) => `accounts/${accountId}/wallets/`;

export interface WalletLink {
  readonly accountId: string;
  readonly wallet: string;
  readonly firstSeen: string;
}

export type LinkOutcome =
  /** Newly claimed by this account. */
  | { readonly status: 'linked'; readonly link: WalletLink }
  /** Already this account's. Submitting again is normal, not an error. */
  | { readonly status: 'already_yours' }
  /** Another account claimed it first. The submission still stands. */
  | { readonly status: 'claimed_by_another'; readonly owner: string }
  /** Storage was unavailable. Linking is best-effort; earning is not. */
  | { readonly status: 'unavailable' };

interface Store {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  putIfAbsent(key: string, value: string): Promise<boolean>;
}

export async function linkWallet(
  store: Store,
  accountId: string,
  wallet: string,
  now: Date = new Date(),
): Promise<LinkOutcome> {
  const address = wallet.trim().toLowerCase();
  if (!accountId || !address) return { status: 'unavailable' };

  const link: WalletLink = { accountId, wallet: address, firstSeen: now.toISOString() };

  try {
    const claimed = await store.putIfAbsent(walletOwnerKey(address), JSON.stringify(link));
    if (!claimed) {
      const raw = await store.get(walletOwnerKey(address));
      const existing = raw ? (JSON.parse(raw) as WalletLink) : undefined;
      if (existing?.accountId === accountId) {
        // Already ours. Make sure the account-side key exists too, so a
        // half-written link from an earlier failure repairs itself.
        await store.putIfAbsent(accountWalletKey(accountId, address), JSON.stringify(link));
        return { status: 'already_yours' };
      }
      return { status: 'claimed_by_another', owner: existing?.accountId ?? 'unknown' };
    }

    await store.putIfAbsent(accountWalletKey(accountId, address), JSON.stringify(link));
    return { status: 'linked', link };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Every wallet this account has earned with. */
export async function walletsFor(store: Store, accountId: string): Promise<string[]> {
  try {
    const keys = await store.list(ACCOUNT_WALLET_PREFIX(accountId));
    return keys
      .map((k) => k.slice(k.lastIndexOf('/') + 1).replace(/\.json$/, ''))
      .filter((w) => /^0x[0-9a-f]{40}$/.test(w))
      .sort();
  } catch {
    return [];
  }
}

/**
 * The creator ids an account's work is filed under.
 *
 * Submissions are keyed `cre-<wallet>`, so an account's history is the union
 * over its wallets. Derived on read rather than stored, because a stored copy
 * is a thing that can disagree with the submissions it claims to summarise.
 */
export function creatorIdsFor(wallets: readonly string[]): string[] {
  return wallets.map((w) => `cre-${w.toLowerCase()}`);
}
