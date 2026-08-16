/**
 * Who has signed up, for the person running this.
 *
 * There was no way to see it. A creator sees their own studio and a brand sees
 * their own dashboard, and the operator — the only party who can approve a
 * brand, end a campaign or overturn a verdict — had nothing but the storage
 * bucket. Reading `accounts/` with gcloud is inspecting a database, not
 * operating a product, and it cannot join an account to what that person has
 * actually done.
 *
 * The tests that matter here are about the gate, because the response carries
 * creator emails.
 */

import { describe, expect, test } from 'bun:test';

import { MemoryBlobStore } from './persistence';
import { CampaignRuntime } from './runtime';

const SECRET = 'operator-secret-for-tests';

const runtime = () => {
  const rt = new CampaignRuntime({
    blobs: new MemoryBlobStore(),
    env: { SESSION_SECRET: 's'.repeat(32), OPERATOR_SECRET: SECRET },
  });
  return rt;
};

const ask = (rt: CampaignRuntime, headers: Record<string, string> = {}) =>
  rt.handleOperatorSignups(new Request('http://x/api/operator/signups', { headers }));

describe('who may read it', () => {
  test('no secret is refused', async () => {
    expect((await ask(runtime())).status).toBe(401);
  });

  test('a wrong secret is refused', async () => {
    expect((await ask(runtime(), { 'x-operator-secret': 'nope' })).status).toBe(401);
  });

  test('the operator secret is accepted', async () => {
    expect((await ask(runtime(), { 'x-operator-secret': SECRET })).status).toBe(200);
  });

  test('an unconfigured deployment refuses rather than opening', async () => {
    // The response carries every creator's email. A deployment that has not
    // been given a secret must not answer at all.
    const rt = new CampaignRuntime({
      blobs: new MemoryBlobStore(), env: { SESSION_SECRET: 's'.repeat(32) },
    });
    expect((await ask(rt, { 'x-operator-secret': 'anything' })).status).toBe(503);
  });
});

describe('what it reports', () => {
  test('an empty deployment reports zero rather than failing', async () => {
    const res = await ask(runtime(), { 'x-operator-secret': SECRET });
    const body = await res.json() as { creators: unknown[]; brands: unknown[]; totals: Record<string, number> };
    expect(body.creators).toEqual([]);
    expect(body.brands).toEqual([]);
    expect(body.totals.creators).toBe(0);
  });

  test('it is never cached, because it carries emails', async () => {
    const res = await ask(runtime(), { 'x-operator-secret': SECRET });
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  test('a creator appears with the fields an operator needs to act', async () => {
    const rt = runtime();
    await rt.ready();
    await rt.record({
      type: 'account_upserted',
      account: {
        accountId: 'acct-1', name: 'Ada', email: 'ada@example.test',
        joinedAt: new Date().toISOString(), linkedWallets: [],
      } as never,
    });
    const body = await (await ask(rt, { 'x-operator-secret': SECRET })).json() as
      { creators: Array<Record<string, unknown>> };
    expect(body.creators).toHaveLength(1);
    // Email is the point: a marketplace that cannot contact the people it owes
    // money to is not one.
    expect(body.creators[0]).toMatchObject({ name: 'Ada', email: 'ada@example.test' });
    expect(body.creators[0]).toHaveProperty('standing');
    expect(body.creators[0]).toHaveProperty('earnedUsdc');
  });
});

/**
 * An account exists from the first sign-in, not the first completed form.
 *
 * `account_upserted` was only written by onboarding, so a creator who signed
 * in with Google and stopped was a session and nothing else — invisible to the
 * operator view, with the name and email Google had just supplied discarded
 * until they filled in a form. Two Google accounts were also hard to tell
 * apart from the outside, because the second one left no record at all.
 */
describe('signing in records the account', () => {
  test('a first sign-in creates one, with what Google told us', async () => {
    const rt = runtime();
    await rt.recordSignIn({ accountId: 'cre-g-aaa', googleSub: 'sub-a', name: 'Ada', email: 'ada@x.test' });
    const body = await (await ask(rt, { 'x-operator-secret': SECRET })).json() as
      { creators: Array<Record<string, unknown>> };
    expect(body.creators).toHaveLength(1);
    expect(body.creators[0]).toMatchObject({ name: 'Ada', email: 'ada@x.test' });
  });

  test('two Google accounts are two creators, not one', async () => {
    // The symptom that surfaced this: signing out and in as somebody else
    // changed nothing anyone could see.
    const rt = runtime();
    await rt.recordSignIn({ accountId: 'cre-g-aaa', googleSub: 'sub-a', name: 'Ada', email: 'ada@x.test' });
    await rt.recordSignIn({ accountId: 'cre-g-bbb', googleSub: 'sub-b', name: 'Bo', email: 'bo@x.test' });
    const body = await (await ask(rt, { 'x-operator-secret': SECRET })).json() as
      { creators: Array<Record<string, unknown>>; totals: Record<string, number> };
    expect(body.totals.creators).toBe(2);
    expect(body.creators.map((c) => c.email).sort()).toEqual(['ada@x.test', 'bo@x.test']);
  });

  test('signing in again does not overwrite what a creator set themselves', async () => {
    // A returning creator's handle and chosen name are theirs. Google's answer
    // fills a gap; it does not win an argument.
    const rt = runtime();
    await rt.recordSignIn({ accountId: 'cre-g-aaa', googleSub: 'sub-a', name: 'Ada', email: 'ada@x.test' });
    await rt.recordSignIn({ accountId: 'cre-g-aaa', googleSub: 'sub-a', name: 'Renamed By Google', email: 'ada@x.test' });
    const body = await (await ask(rt, { 'x-operator-secret': SECRET })).json() as
      { creators: Array<Record<string, unknown>> };
    expect(body.creators).toHaveLength(1);
    expect(body.creators[0]!.name).toBe('Ada');
  });
});
