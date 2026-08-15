/**
 * One wallet per campaign, and the refusals that make it true.
 *
 * The version this replaces asserted that two generated addresses differed and
 * matched a hex pattern. Both hold for twenty random bytes, which is what it
 * was generating — so the suite passed while the thing under test could not
 * have held a cent. These tests are about custody and exclusivity instead,
 * because those are the properties that decide whether money survives.
 */

import { describe, expect, test } from 'bun:test';

import { USDC } from '../decimal';
import { MultiAgentClusterManager, provisionCommand } from './cluster';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const ZERO = '0x' + '0'.repeat(40);

const ok = <T,>(r: T | { ok: false }): T => {
  if (r && typeof r === 'object' && 'ok' in r && r.ok === false) {
    throw new Error(`expected success, got ${JSON.stringify(r)}`);
  }
  return r as T;
};

describe('an address has to be one somebody can sign for', () => {
  test('a well-formed address registers', () => {
    const c = new MultiAgentClusterManager();
    const r = c.register('camp-1', A, 'circle-agent-wallet');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.wallet.address).toBe(A);
      expect(r.wallet.custody).toBe('circle-agent-wallet');
    }
  });

  test('nothing is generated — a missing wallet stays missing', () => {
    // The previous implementation invented an address on demand. Sending USDC
    // to twenty random bytes destroys it, so the absence must persist.
    const c = new MultiAgentClusterManager();
    expect(c.walletFor('camp-1')).toBeUndefined();
    expect(provisionCommand('camp-1')).toContain('circle wallet create');
  });

  test('a malformed address is refused, not coerced', () => {
    const c = new MultiAgentClusterManager();
    for (const bad of ['', 'not-an-address', '0x123', A + 'ff']) {
      const r = c.register('camp-1', bad);
      expect(r.ok).toBe(false);
    }
  });

  test('the zero address and the old placeholder are refused by name', () => {
    const c = new MultiAgentClusterManager();
    expect(c.register('camp-1', ZERO).ok).toBe(false);
    // Shipped as the default treasury: 50 characters, not hex, not an address.
    expect(c.register('camp-2', '0xSafeTreasury000000000000000000000000000000000000').ok).toBe(false);
  });
});

describe('one wallet cannot back two pools', () => {
  test('a second campaign claiming the same address is refused', () => {
    // The failure this prevents: both campaigns read the same balance as their
    // own funding, and both publish it to creators as budget left.
    const c = new MultiAgentClusterManager();
    ok(c.register('camp-1', A));

    const second = c.register('camp-2', A);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain('camp-1');
    expect(c.walletFor('camp-2')).toBeUndefined();
  });

  test('re-registering the same pair is idempotent, not a conflict', () => {
    const c = new MultiAgentClusterManager();
    ok(c.register('camp-1', A));
    expect(c.register('camp-1', A).ok).toBe(true);
  });

  test('moving a funded campaign to a different address is refused', () => {
    // The published pool is backed by the first address; silently repointing
    // it would leave that promise behind.
    const c = new MultiAgentClusterManager();
    ok(c.register('camp-1', A));
    expect(c.register('camp-1', B).ok).toBe(false);
  });

  test('topology reports whether isolation actually holds', () => {
    const c = new MultiAgentClusterManager();
    ok(c.register('camp-1', A));
    ok(c.register('camp-2', B));
    const t = c.topology();
    expect(t.campaigns).toHaveLength(2);
    expect(t.isolated).toBe(true);
  });
});

describe('splitting a deposit', () => {
  test('refuses when no treasury is configured', () => {
    // SAFE_TREASURY_ADDRESS is unset under test. Computing a split against a
    // placeholder is how every fee got routed to a string that is not an
    // address, so the refusal is the point.
    const c = new MultiAgentClusterManager();
    ok(c.register('camp-1', A));
    const r = c.splitDeposit('camp-1', USDC('549.00'), USDC('49.00'));
    expect('ok' in r && r.ok === false).toBe(true);
    if ('field' in r) expect(r.field).toBe('treasury');
  });

  test('refuses for a campaign with no registered wallet', () => {
    const c = new MultiAgentClusterManager();
    const r = c.splitDeposit('camp-unknown', USDC('549.00'), USDC('49.00'));
    expect('ok' in r && r.ok === false).toBe(true);
  });
});

describe('a wallet is freed when its campaign can no longer claim it', () => {
  test('release lets the same address back a later campaign', () => {
    // A Circle agent wallet is one per account per chain. A permanent lock
    // meant an agent got one campaign ever and was then shut out of the
    // platform by the rule meant to protect its creators.
    const c = new MultiAgentClusterManager();
    ok(c.register('camp-1', A));
    expect(c.register('camp-2', A).ok).toBe(false);

    expect(c.release('camp-1')).toBe(true);
    expect(c.register('camp-2', A).ok).toBe(true);
    expect(c.campaignAt(A)).toBe('camp-2');
  });

  test('releasing something never registered is not an error', () => {
    expect(new MultiAgentClusterManager().release('camp-nope')).toBe(false);
  });

  test('a live campaign still holds its wallet', () => {
    const c = new MultiAgentClusterManager();
    ok(c.register('camp-1', A));
    expect(c.register('camp-2', A).ok).toBe(false);
    expect(c.walletFor('camp-1')?.address).toBe(A);
  });
});
