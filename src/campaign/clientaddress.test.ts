/**
 * The rate limiter must key on an address the caller cannot choose.
 *
 * It read the whole `x-forwarded-for` header and used that as the key. Cloud
 * Run appends the real client address to whatever arrived, so a caller who
 * sends their own header produces `<anything they like>, <real ip>` — a
 * different key on every request, and therefore no limit at all. Rotating a
 * fake value defeated the limiter on campaign creation, clip submission and
 * the enquiry form.
 *
 * The last hop is the one the proxy added. An attacker can prepend as much as
 * they like; they cannot stop the real address being appended after it.
 */

import { describe, expect, test } from 'bun:test';

import { MemoryBlobStore } from './persistence';
import { CampaignRuntime } from './runtime';

const rt = new CampaignRuntime({
  blobs: new MemoryBlobStore(), env: { SESSION_SECRET: 's'.repeat(32) },
});
// The method is private because nothing outside should choose a caller's
// address; the test reaches in because this is exactly what must not drift.
const addr = (header?: string) =>
  (rt as unknown as { clientAddress(r: Request): string }).clientAddress(
    new Request('http://x/', { headers: header === undefined ? {} : { 'x-forwarded-for': header } }),
  );

describe('which hop is trusted', () => {
  test('a single address is used as-is', () => {
    expect(addr('203.0.113.7')).toBe('203.0.113.7');
  });

  test('the proxy-appended hop wins over anything the caller prepended', () => {
    // What an attacker sends, followed by what Cloud Run adds.
    expect(addr('1.2.3.4, 203.0.113.7')).toBe('203.0.113.7');
  });

  test('rotating a forged prefix does not change the key', () => {
    // The bypass, stated directly: vary the forged part all you like and the
    // bucket must not move.
    const keys = new Set([
      addr('9.9.9.1, 203.0.113.7'),
      addr('9.9.9.2, 203.0.113.7'),
      addr('spoofed, 203.0.113.7'),
    ]);
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe('203.0.113.7');
  });

  test('several forged hops still resolve to the real one', () => {
    expect(addr('a, b, c, 203.0.113.7')).toBe('203.0.113.7');
  });

  test('whitespace does not create a second bucket for one address', () => {
    expect(addr('1.2.3.4,   203.0.113.7  ')).toBe(addr('1.2.3.4,203.0.113.7'));
  });

  test('no header at all is a single shared bucket, not an empty key', () => {
    // An empty string as a key would give every header-less caller their own
    // unlimited bucket, which is the same bug in a different shape.
    expect(addr()).toBe('anonymous');
    expect(addr('')).toBe('anonymous');
    expect(addr('  ,  ')).toBe('anonymous');
  });
});
