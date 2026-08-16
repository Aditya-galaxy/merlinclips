/**
 * Cloudflare Turnstile, on the one door that needs it.
 *
 * The enquiry form is public, unauthenticated, and fires Slack and Discord
 * alerts on every submission — a spam vector with a notification amplifier
 * attached. That is what this guards.
 *
 * It is deliberately *not* on `/api/submissions`. Submitting a clip is public
 * and keyless on purpose — "requiring a signup before someone can be paid is
 * the friction this product exists to remove" — and a challenge there would
 * trade that promise for protection the dwell mechanic already provides: a bot
 * that inflates a view count is not paid, because the views do not survive.
 *
 * ## Unconfigured is open, configured is enforced
 *
 * Without `TURNSTILE_SECRET` this passes everything, so a deployment that has
 * not set it still takes enquiries rather than silently rejecting every brand
 * that writes in. That is the opposite of the fail-closed posture used on the
 * payout path, and the difference is what each protects: refusing a payment
 * costs a delay, refusing every enquiry costs the customer.
 *
 * Once the secret is set, a missing or invalid token is refused.
 *
 * ## Three checks, not one
 *
 * `success` alone says the token is a real token. It does not say it was
 * issued for this form, or by this site. Cloudflare's own guidance requires
 * all three, and the two that were missing are the ones that matter against a
 * deliberate attacker rather than a crawler:
 *
 * - **action** — a token minted by the widget on some other surface, or by a
 *   copy of our sitekey embedded elsewhere with a different action, is not a
 *   token for this form.
 * - **hostname** — the sitekey is public by design. Anyone can paste it into
 *   their own page, solve challenges there, and post the tokens here. Pinning
 *   the issuing hostname is what stops that, and it is why production must not
 *   accept `localhost`.
 */

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type TurnstileResult =
  | { readonly ok: true; readonly checked: boolean }
  | { readonly ok: false; readonly reason: string };

export class Turnstile {
  private readonly secret?: string;
  /** Hostnames allowed to issue a token. Empty means unpinned — see `check`. */
  private readonly hostnames: ReadonlySet<string>;
  private warnedUnpinned = false;

  constructor(
    env: Record<string, string | undefined> = Bun.env,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.secret = env.TURNSTILE_SECRET?.trim() || undefined;
    this.hostnames = new Set(
      (env.TURNSTILE_HOSTNAMES ?? '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    );
  }

  get configured(): boolean {
    return Boolean(this.secret);
  }

  /**
   * @param token  The `cf-turnstile-response` the widget produced.
   * @param ip     Caller address, so Cloudflare can weigh it. Optional.
   */
  async check(token: unknown, ip?: string, expectedAction?: string): Promise<TurnstileResult> {
    if (!this.secret) return { ok: true, checked: false };

    const response = typeof token === 'string' ? token.trim() : '';
    if (!response) {
      return { ok: false, reason: 'no challenge was completed' };
    }

    const form = new FormData();
    form.set('secret', this.secret);
    form.set('response', response);
    if (ip) form.set('remoteip', ip);

    try {
      const res = await this.fetchImpl(VERIFY_URL, { method: 'POST', body: form });
      const body = (await res.json()) as {
        success?: boolean;
        action?: string;
        hostname?: string;
        'error-codes'?: string[];
      };

      if (body.success !== true) {
        return {
          ok: false,
          reason: (body['error-codes'] ?? []).join(', ') || 'the challenge did not verify',
        };
      }

      // Issued for this form, not merely issued.
      if (expectedAction && body.action !== expectedAction) {
        return { ok: false, reason: 'that challenge was not for this form' };
      }

      // Issued by this site. The sitekey is public, so without this anyone can
      // host it on their own page and forward the tokens here.
      if (this.hostnames.size > 0) {
        const host = String(body.hostname ?? '').toLowerCase();
        if (!this.hostnames.has(host)) {
          return { ok: false, reason: 'that challenge came from another site' };
        }
      } else if (!this.warnedUnpinned) {
        // Loud once rather than silent forever, and open rather than closed:
        // this module's whole posture is that refusing every enquiry costs the
        // customer while refusing a payment costs a delay. A half-configured
        // deployment is a mistake to fix, not a reason to shut the only door a
        // brand can reach us through.
        this.warnedUnpinned = true;
        console.error(
          'TURNSTILE_SECRET is set but TURNSTILE_HOSTNAMES is not, so the issuing '
          + 'hostname is unchecked. The sitekey is public: anyone can host it and '
          + 'forward tokens here. Set it to the domains that serve this form.',
        );
      }

      return { ok: true, checked: true };
    } catch (error) {
      // A Cloudflare outage must not close the only door a brand can reach us
      // through. Reported as unchecked rather than passed silently.
      return { ok: true, checked: false };
    }
  }
}

export function turnstileFromEnv(env: Record<string, string | undefined> = Bun.env): Turnstile {
  return new Turnstile(env);
}
