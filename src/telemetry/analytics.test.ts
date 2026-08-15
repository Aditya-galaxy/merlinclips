/**
 * What reaches PostHog, and what is deliberately held back.
 *
 * Creators and brands are identified by email and name — they are the product's
 * users and reaching them is the point. The line is drawn at wallet addresses:
 * an email is revocable, while a wallet is a permanent key into a public
 * ledger, so publishing the link between a person and their address cannot be
 * undone. That one field is off unless explicitly switched on.
 */

import { describe, expect, test } from 'bun:test';

import { Analytics, pseudonym } from './analytics';

const WALLET = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
const EMAIL = 'dana@nimbus.io';

/** Captures the request body instead of sending it. */
function spy(env: Record<string, string | undefined> = { POSTHOG_KEY: 'phc_test' }) {
  const sent: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  return { analytics: new Analytics(env, fetchImpl), sent };
}

describe('who a person is', () => {
  test('a creator profile carries their email and name', async () => {
    // Deliberate: these are your users and you need to reach them. An email in
    // an analytics store is ordinary and revocable.
    const { analytics, sent } = spy();
    await analytics.identify('acct-1', { $email: EMAIL, $name: 'Dana', role: 'creator' });

    const set = (sent[0]?.properties as Record<string, unknown>).$set as Record<string, unknown>;
    expect(sent[0]?.event).toBe('$identify');
    expect(sent[0]?.distinct_id).toBe('acct-1');
    expect(set.$email).toBe(EMAIL);
    expect(set.role).toBe('creator');
  });

  test('undefined fields are dropped rather than sent as null', async () => {
    const { analytics, sent } = spy();
    await analytics.identify('acct-1', { $email: EMAIL, handle: undefined });
    const set = (sent[0]?.properties as Record<string, unknown>).$set as Record<string, unknown>;
    expect('handle' in set).toBe(false);
  });
});

describe('wallets are the one field held back', () => {
  test('excluded by default', async () => {
    // An email is revocable. A wallet is a permanent key into a public ledger:
    // anyone reading this, or a leaked export, can see every transaction that
    // person has ever made, for as long as the chain exists.
    const { analytics } = spy();
    expect(analytics.includeWallets).toBe(false);
  });

  test('included only when explicitly turned on', async () => {
    const { analytics } = spy({ POSTHOG_KEY: 'phc_test', POSTHOG_INCLUDE_WALLETS: 'true' });
    expect(analytics.includeWallets).toBe(true);
  });

  test('anything other than the exact opt-in leaves it off', async () => {
    for (const v of ['1', 'yes', 'TRUE', '']) {
      const { analytics } = spy({ POSTHOG_KEY: 'phc_test', POSTHOG_INCLUDE_WALLETS: v });
      expect(analytics.includeWallets).toBe(false);
    }
  });
});

describe('hashing is still available where it is wanted', () => {
  test('the same subject hashes the same way, so funnels join up', () => {
    expect(pseudonym(WALLET, 's')).toBe(pseudonym(WALLET.toLowerCase(), 's'));
  });

  test('a different salt gives a different hash, so exports cannot be cross-referenced', () => {
    expect(pseudonym(WALLET, 'a')).not.toBe(pseudonym(WALLET, 'b'));
  });

  test('a hash does not contain what it hashed', () => {
    expect(pseudonym(WALLET, 's')).not.toContain(WALLET.slice(2, 10));
  });
});

describe('analytics never break the request they observe', () => {
  test('unconfigured is a silent no-op, not an error', async () => {
    const { analytics, sent } = spy({});
    expect(await analytics.capture({ event: 'x', distinctId: 'y' })).toBe(false);
    expect(sent).toHaveLength(0);
    expect(analytics.configured).toBe(false);
  });

  test('a network failure is counted, not thrown', async () => {
    const fetchImpl = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const a = new Analytics({ POSTHOG_KEY: 'phc_test' }, fetchImpl);
    expect(await a.capture({ event: 'x', distinctId: 'y' })).toBe(false);
    expect(a.failures).toBe(1);
  });

  test('a rejected request is counted, not thrown', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const a = new Analytics({ POSTHOG_KEY: 'phc_test' }, fetchImpl);
    expect(await a.capture({ event: 'x', distinctId: 'y' })).toBe(false);
    expect(a.failures).toBe(1);
  });
});

describe('errors land in Error Tracking', () => {
  test('an exception is sent as $exception with its message', async () => {
    const { analytics, sent } = spy();
    await analytics.captureException(new TypeError('cannot read views'), 'verifier', { submissionId: 's1' });

    const p = sent[0]?.properties as Record<string, unknown>;
    expect(sent[0]?.event).toBe('$exception');
    expect(p.$exception_type).toBe('TypeError');
    expect(p.$exception_message).toBe('cannot read views');
    expect(p.$exception_source).toBe('verifier');
    expect(p.submissionId).toBe('s1');
  });

  test('grouping is by surface, not by person', async () => {
    // One bug scattered across every user who hit it is a bug nobody triages.
    const { analytics, sent } = spy();
    await analytics.captureException(new Error('boom'), 'http');
    expect(sent[0]?.distinct_id).toBe('surface:http');
  });

  test('a thrown non-Error still reports something usable', async () => {
    const { analytics, sent } = spy();
    await analytics.captureException('just a string', 'oracle');
    const p = sent[0]?.properties as Record<string, unknown>;
    expect(p.$exception_message).toBe('just a string');
    expect(p.$exception_stack_trace_raw).toBeUndefined();
  });
});

describe('model calls carry the verdict, not the transcript', () => {
  test('a pass records latency and confidence', async () => {
    const { analytics, sent } = spy();
    await analytics.captureModelCall({
      model: 'gemini-3-flash-preview', latencyMs: 24_000, traceId: 'sub-1',
      pass: true, confidence: 0.95, campaignId: 'camp-1',
    });

    const p = sent[0]?.properties as Record<string, unknown>;
    expect(sent[0]?.event).toBe('$ai_generation');
    expect(p.$ai_model).toBe('gemini-3-flash-preview');
    expect(p.$ai_latency).toBe(24);
    expect(p.verdictPass).toBe(true);
    expect(p.campaignId).toBe('camp-1');
    expect(p.$ai_is_error).toBe(false);
  });

  test('a refusal carries a truncated reason, so briefs can be judged in aggregate', async () => {
    const { analytics, sent } = spy();
    await analytics.captureModelCall({
      model: 'm', latencyMs: 1, traceId: 't', pass: false,
      refusalReason: 'x'.repeat(400),
    });
    const p = sent[0]?.properties as Record<string, unknown>;
    expect(String(p.refusalReason)).toHaveLength(200);
  });

  test('a failed call is flagged as an error rather than a silent zero', async () => {
    const { analytics, sent } = spy();
    await analytics.captureModelCall({ model: 'unknown', latencyMs: 5, traceId: 't', error: 'timeout' });
    const p = sent[0]?.properties as Record<string, unknown>;
    expect(p.$ai_is_error).toBe(true);
    expect(p.$ai_error).toBe('timeout');
    expect(p.verdictPass).toBeNull();
  });
});
