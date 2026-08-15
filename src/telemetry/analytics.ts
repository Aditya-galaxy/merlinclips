/**
 * Product analytics, captured server-side.
 *
 * Client-side capture alone would undercount badly here: this audience is
 * crypto-native and runs blockers, so a browser snippet silently loses a large
 * slice of exactly the events that matter — a creator finishing onboarding, a
 * brand sending an enquiry. Those two are recorded from the server, where no
 * extension can intervene, so the funnel is complete by construction.
 *
 * ## What is deliberately not sent
 *
 * No wallet address, no email, no name. A wallet linked to a person inside a
 * third-party analytics store is a disclosure that cannot be walked back, and
 * it buys nothing a hash does not. `distinct_id` is a salted hash, and the
 * properties carry shape — budget band, platform, whether a website was given
 * — rather than identity. The enquiry record in the blob store remains the
 * place to look up who someone actually is.
 *
 * Fire-and-forget: analytics must never delay or fail a request that is
 * otherwise fine. Every send is awaited only to the point of dispatch, and a
 * failure is swallowed after being counted.
 */

import { createHash } from 'node:crypto';

export interface AnalyticsEvent {
  /** Snake-case, past tense: `creator_onboarded`, `brand_enquiry_received`. */
  readonly event: string;
  /** Stable per subject, never reversible to a person. */
  readonly distinctId: string;
  readonly properties?: Record<string, string | number | boolean | null>;
}

/**
 * A one-way id for a subject.
 *
 * Salted with POSTHOG_SALT so the same wallet does not produce the same hash
 * across unrelated deployments, and so a leaked analytics export cannot be
 * rainbow-tabled back to an address list.
 */
export function pseudonym(raw: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${raw.toLowerCase().trim()}`).digest('hex').slice(0, 32);
}

export class Analytics {
  private readonly key?: string;
  private readonly host: string;
  private readonly salt: string;
  /** Counted rather than thrown, so a broken pipe is visible without noise. */
  public failures = 0;
  public sent = 0;

  constructor(
    env: Record<string, string | undefined> = Bun.env,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.key = env.POSTHOG_KEY?.trim() || undefined;
    this.host = (env.POSTHOG_HOST?.trim() || 'https://eu.i.posthog.com').replace(/\/+$/, '');
    this.salt = env.POSTHOG_SALT?.trim() || 'merlinclips';
  }

  get configured(): boolean {
    return Boolean(this.key);
  }

  /** Hash a wallet, email or account id into a stable analytics subject. */
  idFor(raw: string): string {
    return pseudonym(raw, this.salt);
  }

  /**
   * Record an event. Never throws, never blocks the caller's response.
   *
   * Unconfigured is a no-op rather than an error: a deployment without an
   * analytics key should still take signups.
   */
  async capture(event: AnalyticsEvent): Promise<boolean> {
    if (!this.key) return false;
    try {
      const res = await this.fetchImpl(`${this.host}/i/v0/e/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: this.key,
          event: event.event,
          distinct_id: event.distinctId,
          properties: { ...event.properties, $lib: 'merlinclips-server' },
          timestamp: new Date().toISOString(),
        }),
      });
      if (!res.ok) {
        this.failures += 1;
        return false;
      }
      this.sent += 1;
      return true;
    } catch {
      this.failures += 1;
      return false;
    }
  }
}

export function analyticsFromEnv(env: Record<string, string | undefined> = Bun.env): Analytics {
  return new Analytics(env);
}
