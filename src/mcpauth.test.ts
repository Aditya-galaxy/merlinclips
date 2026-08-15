/**
 * Who may open a campaign through MCP.
 *
 * The endpoint was open to anyone who found it. No tool could ever take money
 * — `create_campaign` names a wallet the *caller* funds, and nothing can move
 * USDC out of a wallet the caller does not control — so the exposure was never
 * theft. It was that an anonymous caller could fill an append-only log with
 * campaigns nobody funds, and that log is what every payout is replayed from.
 *
 * The shape of the fix is as much the point as the fix. Reads stay open
 * because they are the audit surface, and `submit_clip` stays open because the
 * payout address is a creator's identity and requiring credentials from us
 * would put an operator between a clipper and getting paid.
 */

import { describe, expect, test } from 'bun:test';

import { apiKeysFromEnv, authorise, hashKey } from './mcpauth';

const KEY = 'mc_a1b2c3d4e5f6';
const OWNER = '0xf461c5bb7e314670ae5c5eeb9929b15728ab2b6c';
const KEYS = [{ hash: hashKey(KEY), owner: OWNER }];

describe('what a key is needed for', () => {
  test('opening a campaign needs one', () => {
    expect(authorise('create_campaign', null, KEYS).ok).toBe(false);
  });

  test('submitting a clip does not — the payout address is the identity', () => {
    // Gating this would mean every clipper had to be onboarded by an operator
    // before they could earn, which is the friction this product removes.
    expect(authorise('submit_clip', null, KEYS)).toEqual({ ok: true, owner: 'public' });
  });

  test('reading needs nothing, because reading is the audit surface', () => {
    for (const tool of [
      'list_open_campaigns', 'check_clip', 'check_earnings',
      'check_campaign_funding', 'get_ledger', 'explain_payout_rules',
    ]) {
      expect(authorise(tool, null, KEYS).ok).toBe(true);
    }
  });
});

describe('presenting a key', () => {
  test('the right one is accepted and names its owner', () => {
    const r = authorise('create_campaign', `Bearer ${KEY}`, KEYS);
    expect(r).toEqual({ ok: true, owner: OWNER });
  });

  test('the scheme is optional and case-insensitive', () => {
    expect(authorise('create_campaign', KEY, KEYS).ok).toBe(true);
    expect(authorise('create_campaign', `bearer ${KEY}`, KEYS).ok).toBe(true);
  });

  test('a wrong key is refused with 401, not 503', () => {
    // The distinction matters to the caller: 401 is "your key is wrong",
    // 503 is "this deployment cannot authorise anyone". Collapsing them sends
    // an agent to re-read its config when the operator is the one at fault.
    const r = authorise('create_campaign', 'Bearer mc_wrong', KEYS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  test('an empty bearer is refused rather than read as absent', () => {
    const r = authorise('create_campaign', 'Bearer   ', KEYS);
    expect(r.ok).toBe(false);
  });

  test('the right key among several still resolves to its own owner', () => {
    const many = [
      { hash: hashKey('mc_one'), owner: 'first' },
      ...KEYS,
      { hash: hashKey('mc_three'), owner: 'third' },
    ];
    expect(authorise('create_campaign', `Bearer ${KEY}`, many)).toEqual({ ok: true, owner: OWNER });
  });
});

describe('a deployment that has not been told who may write', () => {
  test('refuses, rather than permitting because it cannot check', () => {
    // The direction this codebase got wrong twice before — a settlement guard
    // and an x402 paywall both permitted the action when their check could not
    // run, and both were therefore off in production without anyone noticing.
    const r = authorise('create_campaign', `Bearer ${KEY}`, []);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.reason).toContain('MCP_API_KEYS');
    }
  });

  test('still serves the reads', () => {
    // An unconfigured deployment is not a broken one for anyone checking the
    // ledger, and taking transparency offline would be a strange way to
    // respond to missing configuration.
    expect(authorise('get_ledger', null, []).ok).toBe(true);
  });
});

describe('reading the configured keys', () => {
  test('parses hash:owner pairs', () => {
    const keys = apiKeysFromEnv({ MCP_API_KEYS: `${hashKey('a')}:one, ${hashKey('b')}:two` });
    expect(keys.map((k) => k.owner)).toEqual(['one', 'two']);
  });

  test('unset is no keys, not one empty key', () => {
    // `''.split(',')` is `['']`. A naive parse yields one entry that could
    // match an empty presented token.
    expect(apiKeysFromEnv({})).toEqual([]);
    expect(apiKeysFromEnv({ MCP_API_KEYS: '' })).toEqual([]);
    expect(apiKeysFromEnv({ MCP_API_KEYS: ' , ' })).toEqual([]);
  });

  test('a malformed entry is dropped rather than becoming a key', () => {
    // Notably: a raw key pasted in place of its hash. That entry must not
    // authorise anything, and it must not stop the valid ones working.
    const keys = apiKeysFromEnv({
      MCP_API_KEYS: `not-a-hash:owner,${hashKey('good')}:real,${hashKey('x')}:`,
    });
    expect(keys.map((k) => k.owner)).toEqual(['real']);
  });

  test('a key is never stored in the clear', () => {
    // The property the hashing exists for: an environment readable by a
    // project viewer should reveal nothing presentable.
    const config = `${hashKey(KEY)}:${OWNER}`;
    expect(config).not.toContain(KEY);
    expect(authorise('create_campaign', `Bearer ${KEY}`, apiKeysFromEnv({ MCP_API_KEYS: config })).ok)
      .toBe(true);
  });
});
