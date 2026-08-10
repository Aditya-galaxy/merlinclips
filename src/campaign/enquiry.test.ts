import { describe, expect, it } from 'bun:test';
import { enquiryKey, parseEnquiry } from './enquiry';

const NOW = new Date('2026-08-10T12:00:00.000Z');

function good(over: Record<string, unknown> = {}) {
  return {
    name: 'Dana Okafor',
    email: 'dana@boxabl.com',
    website: 'boxabl.com',
    goals: 'We want short-form creators clipping our factory tour for reach.',
    budget: '$5,000 - $10,000',
    ...over,
  };
}

describe('a complete enquiry', () => {
  it('is accepted and normalised', () => {
    const r = parseEnquiry(good(), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.email).toBe('dana@boxabl.com');
    expect(r.value.website).toBe('https://boxabl.com/');
    expect(r.value.companyDomain).toBe(true);
    expect(r.value.wantsAgency).toBe(false);
    expect(r.value.receivedAt).toBe(NOW.toISOString());
  });

  // A brand typing their own domain without a scheme is not making a mistake.
  it('accepts a bare domain as readily as a full url', () => {
    for (const w of ['boxabl.com', 'www.boxabl.com', 'https://boxabl.com', 'http://boxabl.com/x']) {
      expect(parseEnquiry(good({ website: w }), NOW).ok).toBe(true);
    }
  });

  it('notes a consumer mail address without refusing it', () => {
    const r = parseEnquiry(good({ email: 'dana@gmail.com' }), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.companyDomain).toBe(false);
  });

  it('reads the agency question from either a boolean or a form string', () => {
    for (const v of [true, 'true']) {
      const r = parseEnquiry(good({ wantsAgency: v }), NOW);
      expect(r.ok && r.value.wantsAgency).toBe(true);
    }
    for (const v of [false, 'false', undefined, 'on-ish']) {
      const r = parseEnquiry(good({ wantsAgency: v }), NOW);
      expect(r.ok && r.value.wantsAgency).toBe(false);
    }
  });
});

// The form carries matching attributes, but anything can POST here and a
// `required` attribute is a hint to a browser, not a check on a request.
describe('what it refuses, and which field it blames', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['no name', { name: '' }, 'name'],
    ['a one-character name', { name: 'D' }, 'name'],
    ['no email', { email: '' }, 'email'],
    ['an address with no domain', { email: 'dana@localhost' }, 'email'],
    ['an address with no @', { email: 'dana.example.com' }, 'email'],
    ['no website', { website: '' }, 'website'],
    ['a hostname with no dot', { website: 'boxabl' }, 'website'],
    ['a javascript url', { website: 'javascript:alert(1)' }, 'website'],
    ['goals too short to act on', { goals: 'more reach' }, 'goals'],
    ['no budget', { budget: '' }, 'budget'],
  ];

  for (const [label, over, field] of cases) {
    it(`refuses ${label}, blaming ${field}`, () => {
      const r = parseEnquiry(good(over), NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.field).toBe(field);
        expect(r.error.length).toBeGreaterThan(10);
      }
    });
  }

  it('refuses a body with nothing in it rather than throwing', () => {
    const r = parseEnquiry({}, NOW);
    expect(r.ok).toBe(false);
  });

  it('ignores types it was not given', () => {
    const r = parseEnquiry({ name: 42, email: null, website: [], goals: {}, budget: true }, NOW);
    expect(r.ok).toBe(false);
  });
});

describe('deduplicating a double-submitted form', () => {
  // The bug this covers: seeded with the full millisecond timestamp, two
  // clicks of one button produced two ids and two keys, so putIfAbsent never
  // saw a collision and the endpoint reported 201 twice.
  it('gives the same key to the same brand within a minute', () => {
    const a = parseEnquiry(good(), new Date('2026-08-10T12:00:00.100Z'));
    const b = parseEnquiry(good(), new Date('2026-08-10T12:00:43.900Z'));
    expect(a.ok && b.ok && enquiryKey(a.value) === enquiryKey(b.value)).toBe(true);
  });

  it('lets a genuine second enquiry through in a later minute', () => {
    const a = parseEnquiry(good(), new Date('2026-08-10T12:00:59.000Z'));
    const b = parseEnquiry(good(), new Date('2026-08-10T12:01:01.000Z'));
    expect(a.ok && b.ok && enquiryKey(a.value) !== enquiryKey(b.value)).toBe(true);
  });

  it('does not collapse two different brands in the same minute', () => {
    const a = parseEnquiry(good(), new Date('2026-08-10T12:00:10.000Z'));
    const b = parseEnquiry(good({ email: 'sam@other.com' }), new Date('2026-08-10T12:00:20.000Z'));
    expect(a.ok && b.ok && enquiryKey(a.value) !== enquiryKey(b.value)).toBe(true);
  });
});

describe('bounds', () => {
  it('truncates rather than rejecting a very long answer', () => {
    const r = parseEnquiry(good({ goals: 'x'.repeat(50_000) }), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.goals.length).toBeLessThanOrEqual(2000);
  });

  it('gives different enquiries different ids', () => {
    const a = parseEnquiry(good(), NOW);
    const b = parseEnquiry(good({ email: 'sam@other.com' }), NOW);
    expect(a.ok && b.ok && a.value.enquiryId !== b.value.enquiryId).toBe(true);
  });

  it('keys by arrival, so listing is chronological', () => {
    const r = parseEnquiry(good(), NOW);
    if (!r.ok) throw new Error('expected ok');
    expect(enquiryKey(r.value)).toStartWith('enquiries/2026-08-10T12:00-');
  });
});
