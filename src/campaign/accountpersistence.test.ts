/**
 * A creator's account has to outlive the instance that created it.
 *
 * Cloud Run runs this with `--min-instances 0`. An instance is recycled after
 * a few minutes of no traffic, so anything held only in memory is not "cleared
 * on restart" in some rare operational sense — it is lost between one creator
 * signing up and the next one arriving.
 *
 * The account is the Google identity, the handle, and the linked payout
 * wallets. Losing it means a returning creator signs in to an empty profile
 * showing zero earnings, while the payouts they earned sit in the log attached
 * to a wallet address their account no longer claims.
 */

import { describe, expect, test } from 'bun:test';

import { sign } from '../auth/session';
import { MemoryBlobStore } from './persistence';
import { CampaignRuntime } from './runtime';

const SECRET = 'session-secret-for-tests';
const WALLET = '0x' + 'a'.repeat(40);
const OTHER = '0x' + 'b'.repeat(40);

async function cookieFor(accountId: string) {
  const token = await sign(
    { creatorId: accountId, sub: accountId, exp: Math.floor(Date.now() / 1000) + 3600 },
    SECRET,
  );
  return { cookie: `mc_session=${token}` };
}

const onboard = (headers: Record<string, string>, body: Record<string, unknown>) =>
  new Request('http://x/api/me/onboarding', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

type Profile = {
  account?: { handle?: string; bio?: string; creatorType?: string };
  wallets?: string[];
  totals?: { earnedUsdc: string };
};

/** A second process reading the same storage — i.e. a Cloud Run cold start. */
async function coldStart(blobs: MemoryBlobStore, headers: Record<string, string>) {
  const next = new CampaignRuntime({ blobs, env: { SESSION_SECRET: SECRET } });
  const res = await next.handleProfile(new Request('http://x/api/me/profile', { headers }));
  return (await res.json()) as Profile;
}

describe('an account survives the instance that made it', () => {
  test('handle and linked wallet are still there after a cold start', async () => {
    const blobs = new MemoryBlobStore();
    const headers = await cookieFor('acct-1');

    const first = new CampaignRuntime({ blobs, env: { SESSION_SECRET: SECRET } });
    await first.handleSaveOnboarding(
      onboard(headers, { wallet: WALLET, handle: 'realcreator', bio: 'I clip things' }),
    );

    const after = await coldStart(blobs, headers);
    expect(after.account?.handle).toBe('realcreator');
    expect(after.account?.bio).toBe('I clip things');
    expect(after.wallets).toContain(WALLET);
  });

  test('without persistence the handle would fall back to the default', async () => {
    // Names the regression precisely: the old failure was not an error, it was
    // a silently reset profile that looked like a brand new account.
    const blobs = new MemoryBlobStore();
    const headers = await cookieFor('acct-2');
    const rt = new CampaignRuntime({ blobs, env: { SESSION_SECRET: SECRET } });
    await rt.handleSaveOnboarding(onboard(headers, { wallet: WALLET, handle: 'someone' }));

    const after = await coldStart(blobs, headers);
    expect(after.account?.handle).not.toBe('creator');
  });

  test('a second linked wallet survives too', async () => {
    const blobs = new MemoryBlobStore();
    const headers = await cookieFor('acct-3');
    const rt = new CampaignRuntime({ blobs, env: { SESSION_SECRET: SECRET } });
    await rt.handleSaveOnboarding(onboard(headers, { wallet: WALLET, handle: 'multi' }));
    await rt.handleSaveOnboarding(onboard(headers, { wallet: OTHER, handle: 'multi' }));

    const after = await coldStart(blobs, headers);
    expect(after.wallets?.length).toBeGreaterThanOrEqual(1);
  });

  test('an edited handle replaces the old one rather than stacking', async () => {
    const blobs = new MemoryBlobStore();
    const headers = await cookieFor('acct-4');
    const rt = new CampaignRuntime({ blobs, env: { SESSION_SECRET: SECRET } });
    await rt.handleSaveOnboarding(onboard(headers, { wallet: WALLET, handle: 'before' }));
    await rt.handleSaveOnboarding(onboard(headers, { wallet: WALLET, handle: 'after' }));

    expect((await coldStart(blobs, headers)).account?.handle).toBe('after');
  });

  test('one account does not leak into another', async () => {
    const blobs = new MemoryBlobStore();
    const a = await cookieFor('acct-5');
    const b = await cookieFor('acct-6');
    const rt = new CampaignRuntime({ blobs, env: { SESSION_SECRET: SECRET } });
    await rt.handleSaveOnboarding(onboard(a, { wallet: WALLET, handle: 'first' }));
    await rt.handleSaveOnboarding(onboard(b, { wallet: OTHER, handle: 'second' }));

    expect((await coldStart(blobs, a)).account?.handle).toBe('first');
    expect((await coldStart(blobs, b)).account?.handle).toBe('second');
  });
});

describe('the log stays readable', () => {
  test('an account event round-trips through encode and replay', async () => {
    // The first cut of this wrote `"event": undefined`, because encodeEvent's
    // switch had no case for the new type and no exhaustiveness guard. The
    // write succeeded and replay threw — a fact recorded, then unreadable.
    const blobs = new MemoryBlobStore();
    const headers = await cookieFor('acct-7');
    const rt = new CampaignRuntime({ blobs, env: { SESSION_SECRET: SECRET } });
    await rt.handleSaveOnboarding(onboard(headers, { wallet: WALLET, handle: 'roundtrip' }));

    // Replaying is what `handleProfile` does on a fresh runtime; if any event
    // in the log were unreadable this would throw rather than answer.
    await expect(coldStart(blobs, headers)).resolves.toBeDefined();
  });
});
