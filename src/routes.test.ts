/**
 * Every static route resolves to a file that exists, and the creator path
 * actually connects.
 *
 * Two failures this closes, both of which had already happened.
 *
 * `/architecture` was not routed at all — only `/architecture.html` — so the
 * bare link 404'd wherever it was shared. And the homepage's "Campaigns" link
 * pointed at `/ledger`, whose own title is "Public Audit Ledger": the page
 * exists, renders live campaigns, and is named for auditors rather than for
 * the clippers being sent to it. Neither is a crash, which is why neither was
 * noticed — a route table is a set of strings, and nothing checked the strings
 * against the filesystem or against where a creator needs to end up.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

const SERVER = readFileSync('src/server.ts', 'utf8');

/** `'/path': 'landing/file.html'` pairs out of the static route table. */
const ROUTES: Array<[string, string]> = [
  ...SERVER.matchAll(/'(\/[a-zA-Z0-9._/-]*)':\s*'(landing\/[a-zA-Z0-9._-]+)'/g),
].map((m) => [m[1]!, m[2]!]);

describe('the static route table', () => {
  test('is found at all, so this file cannot silently test nothing', () => {
    expect(ROUTES.length).toBeGreaterThan(10);
  });

  test('every route points at a file that exists', () => {
    const missing = ROUTES.filter(([, file]) => !existsSync(file));
    expect(missing).toEqual([]);
  });

  test('the pages a creator is sent to are routed without their extension', () => {
    // A link shared in a Discord message is written `/campaigns`, not
    // `/campaigns.html`. Both resolve; only one gets typed.
    for (const path of ['/campaigns', '/profile', '/ledger', '/architecture']) {
      expect(ROUTES.some(([p]) => p === path)).toBe(true);
    }
  });
});

describe('the creator path from the front door', () => {
  const home = readFileSync('landing/index.html', 'utf8');

  test('the homepage offers a way to see the work before signing up', () => {
    // The only creator call to action was `/signup`. A clipper arriving from
    // someone else's post could not see whether any work existed without first
    // handing over a Google account.
    expect(home).toContain('href="/campaigns"');
  });

  test('"Campaigns" does not point at the audit ledger', () => {
    expect(home).not.toContain('href="/ledger">Campaigns');
  });
});

describe('the campaigns page reads the API it is served', () => {
  const page = readFileSync('landing/campaigns.html', 'utf8');

  test('it fetches the public campaign feed', () => {
    expect(page).toContain("fetch('/api/campaign'");
  });

  test('it submits to the endpoint that accepts keyless submissions', () => {
    // The payout address is the identity, which is what lets this page work
    // for someone who has never signed in. Pointed at a session-gated route it
    // would fail for exactly the audience it exists to serve.
    expect(page).toContain("fetch('/api/submissions'");
  });

  test('it reads only fields the campaign feed actually returns', () => {
    // The studio page composed a mainnet explorer URL by hand for settlements
    // that were on Sepolia, which is the same mistake in a different shape:
    // a page inventing data it was not given.
    const served = [
      'campaignId', 'brief', 'status', 'cpmUsdc', 'poolUsdc', 'remainingUsdc',
      'perCreatorCapUsdc', 'dwellHours', 'platforms', 'creators', 'funding',
      'brandName', 'title', 'category', 'approvalRate', 'judged', 'approved',
      'paidViews', 'spentUsdc',
    ];
    for (const field of [...page.matchAll(/\bc\.([a-zA-Z]+)/g)].map((m) => m[1]!)) {
      expect(served).toContain(field);
    }
  });

  test('an empty feed is stated, never filled with a placeholder campaign', () => {
    // The worst thing this page could do is invent work: a clipper would spend
    // an evening editing for a campaign that does not exist.
    expect(page).toContain('No campaigns are open right now');
  });
});
