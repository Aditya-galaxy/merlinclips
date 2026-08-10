/**
 * Brand enquiries.
 *
 * The first thing a brand does is not open a campaign — it is ask whether
 * this is real. That conversation needs somewhere to land, and until now the
 * only brand-side route was an operator-gated API call, which is a fine door
 * for a machine and no door at all for a person.
 *
 * ## Validated on the server, not in the browser
 *
 * Every rule below is enforced here. The form has matching attributes so a
 * browser can say "that is not an email" without a round trip, but those are
 * a courtesy: anything can POST to this endpoint, and a `required` attribute
 * is a hint to a form, not a check on a request.
 *
 * ## What is deliberately not collected
 *
 * No phone number. It is the field brands most often lie in, it invites a
 * cold-call motion we are not running, and a field nobody trusts you with is
 * a field that lowers completion for everyone.
 */

/** Free text lengths that keep a database row sane and a form honest. */
const LIMITS = {
  name: 120,
  email: 254, // the actual RFC ceiling for an address
  website: 300,
  goals: 2000,
  budget: 60,
} as const;

/**
 * Deliberately loose. Strict email regexes reject valid addresses — plus
 * addressing, new TLDs, apostrophes — and the only check that proves an
 * address works is sending to it.
 */
const EMAIL = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'live.com', 'aol.com', 'icloud.com', 'proton.me', 'protonmail.com', 'mail.com',
]);

export interface BrandEnquiry {
  readonly enquiryId: string;
  /** Arrival truncated to the minute. The dedupe window, and the sort key. */
  readonly minute: string;
  readonly name: string;
  readonly email: string;
  readonly website: string;
  readonly goals: string;
  readonly budget: string;
  readonly wantsAgency: boolean;
  /** True when the address is not on a consumer mail provider. */
  readonly companyDomain: boolean;
  readonly receivedAt: string;
}

export type EnquiryResult =
  | { readonly ok: true; readonly value: BrandEnquiry }
  | { readonly ok: false; readonly error: string; readonly field: string };

function bad(error: string, field: string): EnquiryResult {
  return { ok: false, error, field };
}

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/**
 * Accepts `example.com` as readily as `https://example.com`. A brand typing
 * their own domain without a scheme is not making a mistake, and rejecting it
 * teaches them that the form is fussier than the person reading it.
 */
function normaliseUrl(raw: string): string | undefined {
  if (!raw) return undefined;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname.includes('.') || u.hostname.endsWith('.')) return undefined;
    if (!/^[a-z0-9.-]+$/i.test(u.hostname)) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

export function parseEnquiry(
  input: Record<string, unknown>,
  now: Date = new Date(),
  idFor: (seed: string) => string = defaultId,
): EnquiryResult {
  const name = text(input.name, LIMITS.name);
  if (name.length < 2) return bad('Please tell us your name.', 'name');

  const email = text(input.email, LIMITS.email).toLowerCase();
  if (!EMAIL.test(email)) return bad('That does not look like an email address.', 'email');

  const website = normaliseUrl(text(input.website, LIMITS.website));
  if (!website) return bad('Please give a website we can look at.', 'website');

  const goals = text(input.goals, LIMITS.goals);
  if (goals.length < 15) {
    return bad('A sentence or two on what you want out of this, please.', 'goals');
  }

  const budget = text(input.budget, LIMITS.budget);
  if (!budget) return bad('Roughly what budget are you working with?', 'budget');

  const domain = email.slice(email.lastIndexOf('@') + 1);

  // Truncated to the minute, and this is load-bearing. Seeded with the full
  // millisecond timestamp, two clicks of one button produced two different
  // ids and two different keys, so the putIfAbsent that was supposed to
  // collapse them never saw a collision — the endpoint reported 201 twice.
  // A minute is long enough to catch a double-click or an impatient retry and
  // short enough that somebody genuinely writing again later still lands.
  const minute = now.toISOString().slice(0, 16);

  return {
    ok: true,
    value: {
      enquiryId: idFor(`${email}|${minute}`),
      minute,
      name,
      email,
      website,
      goals,
      budget,
      wantsAgency: input.wantsAgency === true || input.wantsAgency === 'true',
      // Recorded, never enforced. A real brand can arrive on a Gmail address
      // and refusing them would cost more than the signal is worth.
      companyDomain: !FREE_MAIL.has(domain),
      receivedAt: now.toISOString(),
    },
  };
}

function defaultId(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `enq-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Where an enquiry lives.
 *
 * The minute leads so listing is chronological, and the id follows so two
 * different brands writing in the same minute do not collide. Keyed on the
 * minute rather than the exact instant, because a key that changes every
 * millisecond cannot deduplicate anything.
 */
export function enquiryKey(e: BrandEnquiry): string {
  return `enquiries/${e.minute}-${e.enquiryId}.json`;
}
