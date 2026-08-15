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
 */

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type TurnstileResult =
  | { readonly ok: true; readonly checked: boolean }
  | { readonly ok: false; readonly reason: string };

export class Turnstile {
  private readonly secret?: string;

  constructor(
    env: Record<string, string | undefined> = Bun.env,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.secret = env.TURNSTILE_SECRET?.trim() || undefined;
  }

  get configured(): boolean {
    return Boolean(this.secret);
  }

  /**
   * @param token  The `cf-turnstile-response` the widget produced.
   * @param ip     Caller address, so Cloudflare can weigh it. Optional.
   */
  async check(token: unknown, ip?: string): Promise<TurnstileResult> {
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
      const body = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
      if (body.success === true) return { ok: true, checked: true };
      return {
        ok: false,
        reason: (body['error-codes'] ?? []).join(', ') || 'the challenge did not verify',
      };
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
