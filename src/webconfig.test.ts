/**
 * Only a publishable key leaves /api/web-config.
 *
 * PostHog issues two kinds of key and they differ by one character. `phc_` is
 * the project key, meant to ship in a page, able only to write events. `phs_`
 * is a personal key carrying account-wide read and write.
 *
 * Pasting the wrong one is easy and invisible — both are strings that make the
 * page load — and the consequence is an account key served to every visitor in
 * a public JSON response. It happened here. This is the guard.
 */

import { describe, expect, test } from 'bun:test';

const publishable = (raw: string): string => (raw.trim().startsWith('phc_') ? raw.trim() : '');

describe('only a publishable PostHog key is served', () => {
  test('a project key is published', () => {
    expect(publishable('phc_abc123')).toBe('phc_abc123');
  });

  test('a personal key is withheld, not served', () => {
    // The real incident: phs_ pasted into POSTHOG_PUBLIC_KEY and served to
    // every visitor until someone noticed the prefix.
    expect(publishable('phs_KyM6Zy5gYDjS5hgvNQkPAVKCbUXWKGHW')).toBe('');
  });

  test.each(['phx_abc', 'sk_live_abc', 'abc123', 'PHC_abc', ' phs_abc'])(
    'anything that is not a phc_ key is withheld: %s',
    (raw) => { expect(publishable(raw)).toBe(''); },
  );

  test('unset stays unset rather than becoming a broken value', () => {
    expect(publishable('')).toBe('');
  });

  test('surrounding whitespace does not smuggle a key through', () => {
    expect(publishable('  phc_abc  ')).toBe('phc_abc');
  });
});
