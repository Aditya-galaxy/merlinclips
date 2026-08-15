/**
 * Replay is in time order, not key order.
 *
 * Campaigns, creators and accounts are content-addressed: the event id ends in
 * a hash of the content, so an edit records a new fact instead of colliding
 * with the old one. That is right, and it made replay order load-bearing in a
 * way nothing enforced.
 *
 * `blobs.list` returns keys lexicographically, and the key is the event id.
 * Replaying in that order meant the *content hash* decided which version of a
 * campaign survived a restart. Ending a campaign wrote a correct, newest event
 * — and the campaign came back live on the next cold start, because the hash
 * of the active version happened to sort after the hash of the ended one.
 *
 * This is not a rare tie-break. It is every mutable entity, every restart, with
 * the winner chosen by SHA-256.
 */

import { describe, expect, test } from 'bun:test';

import { Decimal } from '../decimal';
import { EventLog } from './eventlog';
import { MemoryBlobStore } from './persistence';
import { CampaignStore } from './store';
import type { Campaign } from './types';

const at = (iso: string) => new Date(iso);

const campaign = (status: Campaign['status']): Campaign => ({
  campaignId: 'camp-1',
  brief: 'Clip the launch stream.',
  poolUsdc: new Decimal('100'),
  cpmUsdc: new Decimal('1'),
  rateBand: { minUsdc: new Decimal('0.5'), maxUsdc: new Decimal('2') },
  perCreatorCapUsdc: new Decimal('10'),
  dwellMs: 86_400_000,
  settlementWindowMs: 14 * 86_400_000,
  platforms: ['youtube'],
  chain: 'base',
  status,
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-09-01T00:00:00.000Z',
});

/**
 * A blob store that lists keys the way GCS does: sorted, not in insertion
 * order. `MemoryBlobStore` happens to return insertion order, which is the
 * one ordering that hides this bug — a test built on it passes against the
 * broken code and proves nothing about production.
 */
class SortedListStore extends MemoryBlobStore {
  constructor(private readonly order: 'asc' | 'desc' = 'asc') { super(); }
  override async list(prefix: string): Promise<string[]> {
    const keys = (await super.list(prefix)).slice().sort();
    return this.order === 'asc' ? keys : keys.reverse();
  }
}

/**
 * Write the pilot campaign's real history, then rebuild a store from it.
 *
 * Parameterised by listing order because the property under test is that the
 * answer does not depend on it. Asserting against one fixed order only proves
 * the hashes fell out favourably for that fixture — which is exactly how this
 * bug survived: whether it bites depends on what the content happens to hash
 * to, so a test pinned to one ordering passes on broken code.
 */
async function rebuild(order: 'asc' | 'desc' = 'asc'): Promise<Campaign | undefined> {
  const blobs = new SortedListStore(order);
  const log = new EventLog(blobs);

  // The order the operator wrote them in — ending the campaign last.
  await log.append({ type: 'campaign_upserted', campaign: campaign('pending_funding') },
    at('2026-08-14T15:59:07.019Z'));
  await log.append({ type: 'campaign_upserted', campaign: campaign('awaiting_operator_approval') },
    at('2026-08-14T15:59:08.148Z'));
  await log.append({ type: 'campaign_upserted', campaign: campaign('active') },
    at('2026-08-14T15:59:09.060Z'));
  await log.append({ type: 'campaign_upserted', campaign: campaign('ended') },
    at('2026-08-15T09:48:28.019Z'));

  const store = new CampaignStore();
  await log.hydrate(store);
  return store.campaign('camp-1');
}

describe('the newest fact wins a restart', () => {
  test('a campaign ended last is still ended after replay', async () => {
    // The bug this covers: in production these events hashed to keys where the
    // `active` version sorted last, so key-order replay resurrected a campaign
    // the operator had taken down.
    expect((await rebuild('asc'))?.status).toBe('ended');
  });

  test('and still ended when the listing comes back the other way', async () => {
    // The half that actually pins it. Whether the ascending case passes is
    // decided by what the content hashes to; this one fails on key-order
    // replay for any fixture, because reversing puts the oldest event last.
    expect((await rebuild('desc'))?.status).toBe('ended');
  });
});

describe('the derived chain is reproducible', () => {
  test('two replays of the same log produce the same root', async () => {
    // The chain is offered as something anyone can check. That claim requires
    // a total order — if events sharing a timestamp can swap places between
    // replays, the root moves and checking it proves nothing.
    const blobs = new SortedListStore();
    const log = new EventLog(blobs);
    const sameMs = at('2026-08-15T09:48:28.019Z');
    await log.append({ type: 'campaign_upserted', campaign: campaign('active') }, sameMs);
    await log.append({ type: 'campaign_upserted', campaign: campaign('ended') }, sameMs);

    const first = await log.chain();
    const second = await log.chain();
    expect(first.root).toBe(second.root);
  });
});
