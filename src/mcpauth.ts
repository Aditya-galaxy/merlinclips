/**
 * Who may write through the MCP endpoint.
 *
 * The endpoint was open. Anyone who found it could open campaigns and register
 * clips, and the reason that was survivable rather than dangerous is worth
 * stating precisely, because it is also why the fix is narrow: no tool can
 * move USDC out of a wallet the caller does not control. `create_campaign`
 * names a wallet the *caller* funds. So an anonymous caller could never take
 * money — what they could do is fill an append-only log with campaigns nobody
 * funds, and that log is what every payout decision is replayed from.
 *
 * **Reads stay open, deliberately.** The ledger, the payout rules, a clip's
 * status and a creator's earnings are the public audit surface. The whole
 * claim of this system is that its arithmetic can be checked by anyone, and a
 * transparency surface behind an API key is not one. Only the tools that write
 * to the log require a key.
 *
 * Keys are held as SHA-256 hashes, never in the clear. An environment variable
 * is readable by anyone with viewer on the project — that is why the YouTube
 * key lives in Secret Manager — so configuration that leaks should reveal
 * something an attacker cannot use. The operator mints a key, stores its hash,
 * and hands the key to one agent.
 *
 * Each key names an owner, so a campaign records who opened it. That is the
 * point of keys over one shared secret: a shared secret tells you a request
 * was authorised and nothing about by whom, and it cannot be revoked for one
 * caller without revoking it for all of them.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Tools that need a key. Everything else is open, and two different reasons
 * sit behind that.
 *
 * The reads are open because they are the audit surface — the ledger, the
 * payout rules, a clip's status, a creator's earnings. This system's claim is
 * that its arithmetic can be checked by anyone, and a transparency surface
 * behind an API key is not one.
 *
 * `submit_clip` is open for a different reason: the payout address is the
 * identity. A creator should not need credentials from us to get paid, and
 * requiring a key would mean every clipper had to be onboarded by an operator
 * before they could earn — which is the friction this product exists to
 * remove. It writes to the log, so it is rate limited, and a junk submission
 * costs a log entry rather than money: verification runs in the tick, and no
 * clip pays before its views survive the hold.
 *
 * `create_campaign` is different in kind. It binds a funding wallet, creates
 * an obligation to creators, and is the tool whose abuse fills the log with
 * campaigns nobody funds.
 */
export const WRITE_TOOLS = new Set(['create_campaign']);

export interface ApiKey {
  /** SHA-256 of the key, hex. */
  readonly hash: string;
  /** Who this key acts as. Recorded on what it opens. */
  readonly owner: string;
}

export type AuthResult =
  | { ok: true; owner: string }
  | { ok: false; status: number; reason: string };

/** `<sha256>:<owner>` pairs, comma-separated. */
export function apiKeysFromEnv(env: Record<string, string | undefined> = Bun.env): ApiKey[] {
  return (env.MCP_API_KEYS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const at = entry.indexOf(':');
      if (at <= 0) return [];
      const hash = entry.slice(0, at).trim().toLowerCase();
      const owner = entry.slice(at + 1).trim();
      // A malformed entry is dropped rather than becoming a key that matches
      // something unintended. Sixty-four hex characters or it is not a SHA-256.
      if (!/^[0-9a-f]{64}$/.test(hash) || !owner) return [];
      return [{ hash, owner }];
    });
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key.trim()).digest('hex');
}

/**
 * Authorise a tool call.
 *
 * Fails closed when no keys are configured. That direction is deliberate, and
 * it is the third time this codebase has needed it: the settlement guard, the
 * x402 paywall and this were all written to permit the action when the check
 * could not run, and the first two were therefore off in production without
 * anyone noticing. A deployment that has not been told who may write does not
 * know, and does not know means no.
 */
export function authorise(
  toolName: string,
  header: string | null,
  keys: readonly ApiKey[],
): AuthResult {
  if (!WRITE_TOOLS.has(toolName)) return { ok: true, owner: 'public' };

  if (keys.length === 0) {
    return {
      ok: false,
      status: 503,
      reason:
        `${toolName} writes to the log and this deployment has no API keys configured, `
        + 'so it cannot tell who is asking. Set MCP_API_KEYS to <sha256-of-key>:<owner> '
        + 'pairs — ./scripts/mcp-key.sh mints one.',
    };
  }

  if (!header) {
    return {
      ok: false,
      status: 401,
      reason: `${toolName} requires an Authorization: Bearer <key> header`,
    };
  }

  const presented = header.replace(/^Bearer\s+/i, '').trim();
  if (!presented) return { ok: false, status: 401, reason: 'empty bearer token' };

  const digest = Buffer.from(hashKey(presented), 'hex');

  // Every key is compared, and each comparison is constant-time. Returning on
  // the first match would make the response time depend on a key's position in
  // the list, which is a slow but real way to learn one.
  let owner: string | undefined;
  for (const key of keys) {
    const candidate = Buffer.from(key.hash, 'hex');
    if (candidate.length === digest.length && timingSafeEqual(candidate, digest)) {
      owner = key.owner;
    }
  }

  if (owner === undefined) {
    return { ok: false, status: 401, reason: 'that key is not recognised' };
  }
  return { ok: true, owner };
}
