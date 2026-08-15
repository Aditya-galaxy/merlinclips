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
  private readonly walletsAllowed: boolean;
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
    this.walletsAllowed = env.POSTHOG_INCLUDE_WALLETS === 'true';
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

  /**
   * An error worth someone's attention.
   *
   * Sent as PostHog's `$exception` so it lands in Error Tracking rather than
   * as a bare event. The message is included; a stack is included only when
   * one exists, because a synthesised stack points at this file rather than at
   * whatever actually broke.
   *
   * The distinct id is the surface, not the person: an error is a property of
   * the code path, and grouping by user would scatter one bug across everyone
   * who hit it.
   */
  async captureException(
    error: unknown,
    where: string,
    context: Record<string, string | number | boolean | null> = {},
  ): Promise<boolean> {
    const e = error instanceof Error ? error : undefined;
    return this.capture({
      event: '$exception',
      distinctId: `surface:${where}`,
      properties: {
        ...context,
        $exception_type: e?.name ?? 'Error',
        $exception_message: e?.message ?? String(error).slice(0, 400),
        $exception_source: where,
        ...(e?.stack ? { $exception_stack_trace_raw: e.stack.slice(0, 4000) } : {}),
      },
    });
  }

  /**
   * One model call, in the shape PostHog's LLM analytics reads.
   *
   * The verdict fields are the point. Latency and token counts say what the
   * call cost; `pass` and `refusalReason` say whether the brief is asking for
   * something creators can actually deliver — a campaign refusing most clips
   * is usually a badly written brief, not a wave of bad creators, and that is
   * only visible in aggregate.
   */
  async captureModelCall(input: {
    model: string;
    latencyMs: number;
    traceId: string;
    pass?: boolean;
    confidence?: number;
    refusalReason?: string;
    inputTokens?: number;
    outputTokens?: number;
    error?: string;
    campaignId?: string;
  }): Promise<boolean> {
    return this.capture({
      event: '$ai_generation',
      distinctId: `trace:${input.traceId}`,
      properties: {
        $ai_trace_id: input.traceId,
        $ai_model: input.model,
        $ai_provider: 'google',
        $ai_latency: input.latencyMs / 1000,
        $ai_input_tokens: input.inputTokens ?? 0,
        $ai_output_tokens: input.outputTokens ?? 0,
        $ai_is_error: Boolean(input.error),
        ...(input.error ? { $ai_error: input.error.slice(0, 400) } : {}),
        verdictPass: input.pass ?? null,
        verdictConfidence: input.confidence ?? null,
        // Truncated: a reason is a signal here, not a transcript.
        refusalReason: input.refusalReason?.slice(0, 200) ?? null,
        campaignId: input.campaignId ?? null,
      },
    });
  }

  /**
   * Who someone is, attached to their profile.
   *
   * `$set` properties are PostHog's person properties: they persist on the
   * profile rather than on a single event, which is what makes a People page
   * show a person instead of a row of hashes.
   *
   * Wallet addresses are the one field held back by default. An email in an
   * analytics store is ordinary and revocable; a wallet is a permanent key
   * into a public ledger, so anyone reading this — or a leaked export — can
   * see every transaction that person has ever made, forever. Set
   * POSTHOG_INCLUDE_WALLETS=true to include them anyway; the switch exists so
   * that is a decision rather than a default.
   */
  async identify(
    distinctId: string,
    person: Record<string, string | number | boolean | null | undefined>,
  ): Promise<boolean> {
    const set: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(person)) {
      if (v !== undefined) set[k] = v;
    }
    return this.capture({
      event: '$identify',
      distinctId,
      properties: { $set: set } as unknown as Record<string, string>,
    });
  }

  /** Whether wallet addresses may be sent. Off unless explicitly turned on. */
  get includeWallets(): boolean {
    return this.walletsAllowed;
  }
}

export function analyticsFromEnv(env: Record<string, string | undefined> = Bun.env): Analytics {
  return new Analytics(env);
}
