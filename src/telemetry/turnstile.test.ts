/**
 * Turnstile, and the two checks that were missing.
 *
 * `success: true` says a token is a real token. It does not say it was issued
 * for this form, or by this site — and the sitekey is public by design, so
 * anyone can paste it into their own page, solve challenges there, and post
 * the tokens here. Cloudflare's guidance requires all three checks; this had
 * one.
 *
 * The posture around them is deliberate and differs from the payout path.
 * Unconfigured passes everything, because refusing every enquiry costs the
 * customer while refusing a payment costs a delay. The asymmetry is the point,
 * so it is asserted rather than left to be re-derived.
 */

import { describe, expect, test } from 'bun:test';

import { Turnstile } from './turnstile';

const ok = (extra: Record<string, unknown> = {}) =>
  (async () => Response.json({ success: true, action: 'brand-enquiry',
    hostname: 'merlinclips.com', ...extra })) as unknown as typeof fetch;

const CONFIGURED = { TURNSTILE_SECRET: 's', TURNSTILE_HOSTNAMES: 'merlinclips.com' };

describe('a deployment with no secret', () => {
  test('passes everything, and says it did not check', async () => {
    const t = new Turnstile({}, ok());
    expect(await t.check('anything')).toEqual({ ok: true, checked: false });
  });

  test('passes even with no token at all', async () => {
    // The enquiry form must keep working on a deployment nobody configured.
    expect((await new Turnstile({}, ok()).check(undefined)).ok).toBe(true);
  });
});

describe('a configured deployment', () => {
  test('accepts a token for the right action from the right host', async () => {
    const t = new Turnstile(CONFIGURED, ok());
    expect(await t.check('tok', undefined, 'brand-enquiry')).toEqual({ ok: true, checked: true });
  });

  test('refuses a missing token', async () => {
    const r = await new Turnstile(CONFIGURED, ok()).check('', undefined, 'brand-enquiry');
    expect(r.ok).toBe(false);
  });

  test('refuses when Cloudflare says the token is bad, and quotes it', async () => {
    const bad = (async () => Response.json({
      success: false, 'error-codes': ['timeout-or-duplicate'],
    })) as unknown as typeof fetch;
    const r = await new Turnstile(CONFIGURED, bad).check('tok', undefined, 'brand-enquiry');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('timeout-or-duplicate');
  });
});

describe('a token minted somewhere else', () => {
  test('a different action is refused', async () => {
    // Our sitekey embedded on another surface produces valid tokens carrying
    // that surface's action.
    const t = new Turnstile(CONFIGURED, ok({ action: 'some-other-form' }));
    const r = await t.check('tok', undefined, 'brand-enquiry');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('not for this form');
  });

  test('a different hostname is refused', async () => {
    // The attack the sitekey being public makes possible: host it yourself,
    // farm tokens, forward them.
    const t = new Turnstile(CONFIGURED, ok({ hostname: 'attacker.example' }));
    const r = await t.check('tok', undefined, 'brand-enquiry');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('another site');
  });

  test('localhost is refused when it is not on the list', async () => {
    // Cloudflare's guidance names this one: a production backend must not
    // accept a token issued by a page running on someone's laptop.
    const t = new Turnstile(CONFIGURED, ok({ hostname: 'localhost' }));
    expect((await t.check('tok', undefined, 'brand-enquiry')).ok).toBe(false);
  });

  test('hostname matching ignores case', async () => {
    const t = new Turnstile({ ...CONFIGURED, TURNSTILE_HOSTNAMES: 'MerlinClips.com' }, ok());
    expect((await t.check('tok', undefined, 'brand-enquiry')).ok).toBe(true);
  });
});

describe('half-configured', () => {
  test('an unset hostname list checks the rest rather than closing the door', async () => {
    // Deliberate, and the reason is in the module: a mistake in configuration
    // should be loud, not fatal to the only channel a brand has. The action is
    // still enforced.
    const t = new Turnstile({ TURNSTILE_SECRET: 's' }, ok({ hostname: 'anywhere.example' }));
    expect((await t.check('tok', undefined, 'brand-enquiry')).ok).toBe(true);
  });

  test('and still refuses a wrong action', async () => {
    const t = new Turnstile({ TURNSTILE_SECRET: 's' }, ok({ action: 'elsewhere' }));
    expect((await t.check('tok', undefined, 'brand-enquiry')).ok).toBe(false);
  });
});

describe('when Cloudflare cannot be reached', () => {
  test('the enquiry still goes through, marked unchecked', async () => {
    // An outage at Cloudflare must not take the contact form down with it.
    const dead = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    expect(await new Turnstile(CONFIGURED, dead).check('tok', undefined, 'brand-enquiry'))
      .toEqual({ ok: true, checked: false });
  });
});
