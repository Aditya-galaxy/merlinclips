/**
 * Brand accounts, created by approval rather than by signing up.
 *
 * Creators self-serve; brands do not. A creator account costs nothing to be
 * wrong about — a fake one submits a clip and the clip is judged on its
 * merits. A brand account is a *spending* account: it publishes a budget that
 * creators spend evenings working against, and an unfunded budget is the exact
 * harm this product exists to prevent. `funding.ts` already calls that "a
 * promise nobody checked"; letting anyone mint one would be manufacturing them.
 *
 * It is also what every serious platform in this market does. Creators get a
 * one-click account; brands get a form, a conversation, and someone deciding.
 *
 * ## How the pieces meet
 *
 * A brand fills in the enquiry form. An operator approves it, which creates a
 * brand record keyed by the email that enquired. When somebody signs in with
 * Google using that address, they are that brand — and see exactly the
 * campaigns whose `ownerId` is theirs, and nothing else.
 *
 * Matching on the verified Google email rather than on a password means there
 * is no brand credential to leak, and no invitation link to forward.
 */

export interface Brand {
  readonly brandId: string;
  /** Lowercased. The Google address that signs in as this brand. */
  readonly email: string;
  readonly company: string;
  readonly website: string;
  /** Which enquiry this came from, so an approval can be traced back. */
  readonly fromEnquiry?: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
}

export function brandKey(email: string): string {
  return `brands/${email.trim().toLowerCase()}.json`;
}

export type ApproveResult =
  | { readonly ok: true; readonly brand: Brand; readonly created: boolean }
  | { readonly ok: false; readonly error: string; readonly field: string };

interface Store {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  putIfAbsent(key: string, value: string): Promise<boolean>;
}

/** Deliberately loose, matching the enquiry form: the check that matters is that someone read it. */
const EMAIL = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

export async function approveBrand(
  store: Store,
  input: {
    email?: unknown; company?: unknown; website?: unknown;
    fromEnquiry?: unknown; approvedBy?: unknown;
  },
  now: Date = new Date(),
): Promise<ApproveResult> {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (!EMAIL.test(email)) {
    return { ok: false, error: 'a brand is keyed by the email that signs in', field: 'email' };
  }
  const company = typeof input.company === 'string' ? input.company.trim().slice(0, 160) : '';
  if (company.length < 2) return { ok: false, error: 'company is required', field: 'company' };

  const brand: Brand = {
    brandId: `brd-${await shortHash(email)}`,
    email,
    company,
    website: typeof input.website === 'string' ? input.website.trim().slice(0, 300) : '',
    fromEnquiry: typeof input.fromEnquiry === 'string' ? input.fromEnquiry : undefined,
    approvedBy: typeof input.approvedBy === 'string' ? input.approvedBy : 'operator',
    approvedAt: now.toISOString(),
  };

  // putIfAbsent, so approving twice does not silently rewrite an existing
  // brand — and in particular cannot move an established brand's identity
  // onto a different company name after campaigns already point at it.
  const created = await store.putIfAbsent(brandKey(email), JSON.stringify(brand, null, 2));
  if (created) return { ok: true, brand, created: true };

  const raw = await store.get(brandKey(email));
  const existing = raw ? (JSON.parse(raw) as Brand) : brand;
  return { ok: true, brand: existing, created: false };
}

/** The brand for a signed-in email, if one was ever approved. */
export async function brandFor(store: Store, email: string | undefined): Promise<Brand | undefined> {
  if (!email) return undefined;
  try {
    const raw = await store.get(brandKey(email));
    return raw ? (JSON.parse(raw) as Brand) : undefined;
  } catch {
    return undefined;
  }
}

async function shortHash(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  return Array.from(new Uint8Array(digest).slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join('');
}
