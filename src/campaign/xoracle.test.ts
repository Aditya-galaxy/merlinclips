/**
 * The X oracle, and the line it must not cross.
 *
 * Payment is gated on `min()` across the dwell window, so a zero that was
 * really a failed lookup does not just lose one observation — it caps what the
 * creator can ever be paid for that clip. Every failure path here has to
 * return `undefined`, which means "not observed", rather than `0`, which means
 * "nobody watched it".
 */

import { describe, expect, test } from 'bun:test';

import { XMarketplaceOracle, type MarketplacePayer } from './xoracle';

const body = (tweets: unknown[]) => JSON.stringify({ tweets, status: 'success' });

/** A payer that returns whatever the test says, and records what was asked. */
function payer(reply: string | undefined | (() => never)) {
  const urls: string[] = [];
  const p: MarketplacePayer = {
    async get(url) {
      urls.push(url);
      if (typeof reply === 'function') reply();
      return reply as string | undefined;
    },
  };
  return { payer: p, urls };
}

describe('reading view counts', () => {
  test('a count comes back for the post it belongs to', async () => {
    const { payer: p } = payer(body([{ id: '123', viewCount: 4821 }]));
    const o = new XMarketplaceOracle({ payer: p });
    expect(await o.count({ platform: 'x', postId: '123' })).toBe(4821n);
  });

  test('a string count is accepted, since the API is not strict about it', async () => {
    const { payer: p } = payer(body([{ id: '123', viewCount: '9000' }]));
    const o = new XMarketplaceOracle({ payer: p });
    expect((await o.batchCount(['123']))['123']).toBe(9000n);
  });

  test('a genuine zero is reported as zero, not as unobserved', async () => {
    const { payer: p } = payer(body([{ id: '123', viewCount: 0 }]));
    const o = new XMarketplaceOracle({ payer: p });
    expect((await o.batchCount(['123']))['123']).toBe(0n);
  });

  test('many posts cost one call', async () => {
    const { payer: p, urls } = payer(body([
      { id: '1', viewCount: 10 }, { id: '2', viewCount: 20 }, { id: '3', viewCount: 30 },
    ]));
    const o = new XMarketplaceOracle({ payer: p });
    const got = await o.batchCount(['1', '2', '3']);
    expect(urls).toHaveLength(1);
    expect(got['2']).toBe(20n);
    expect(o.calls).toBe(1);
  });

  test('a repeated id is not paid for twice', async () => {
    const { payer: p, urls } = payer(body([{ id: '1', viewCount: 5 }]));
    const o = new XMarketplaceOracle({ payer: p });
    await o.batchCount(['1', '1', '1']);
    expect(urls[0]).toContain('tweet_ids=1');
    expect(urls[0]).not.toContain('1%2C1');
  });
});

describe('every failure is unobserved, never zero', () => {
  test('the paid call throwing', async () => {
    const { payer: p } = payer(() => { throw new Error('no gateway balance'); });
    const o = new XMarketplaceOracle({ payer: p });
    expect((await o.batchCount(['123']))['123']).toBeUndefined();
  });

  test('an empty response body', async () => {
    const { payer: p } = payer(undefined);
    const o = new XMarketplaceOracle({ payer: p });
    expect((await o.batchCount(['123']))['123']).toBeUndefined();
  });

  test('a response that is not JSON', async () => {
    const { payer: p } = payer('<html>402 payment required</html>');
    const o = new XMarketplaceOracle({ payer: p });
    expect((await o.batchCount(['123']))['123']).toBeUndefined();
  });

  test('a post the response simply omits', async () => {
    const { payer: p } = payer(body([{ id: '1', viewCount: 10 }]));
    const o = new XMarketplaceOracle({ payer: p });
    const got = await o.batchCount(['1', '2']);
    expect(got['1']).toBe(10n);
    expect(got['2']).toBeUndefined();
  });

  test('a post with no viewCount field', async () => {
    const { payer: p } = payer(body([{ id: '1' }]));
    const o = new XMarketplaceOracle({ payer: p });
    expect((await o.batchCount(['1']))['1']).toBeUndefined();
  });

  test('a nonsense count', async () => {
    const { payer: p } = payer(body([{ id: '1', viewCount: 'lots' }, { id: '2', viewCount: -5 }]));
    const o = new XMarketplaceOracle({ payer: p });
    const got = await o.batchCount(['1', '2']);
    expect(got['1']).toBeUndefined();
    expect(got['2']).toBeUndefined();
  });
});

describe('it stays in its lane', () => {
  test('a YouTube ref is not answered here', async () => {
    const { payer: p, urls } = payer(body([]));
    const o = new XMarketplaceOracle({ payer: p });
    expect(await o.count({ platform: 'youtube', postId: 'dQw4w9WgXcQ' })).toBeUndefined();
    expect(urls).toHaveLength(0);
  });

  test('a non-numeric post id is never bought', async () => {
    // Tweet ids are numeric. Anything else is a parse bug upstream, and paying
    // to ask about it would spend real USDC on a certainty.
    const { payer: p, urls } = payer(body([]));
    const o = new XMarketplaceOracle({ payer: p });
    expect(await o.batchCount(['not-an-id'])).toEqual({});
    expect(urls).toHaveLength(0);
  });

  test('nothing to look up costs nothing', async () => {
    const { payer: p, urls } = payer(body([]));
    const o = new XMarketplaceOracle({ payer: p });
    await o.batchCount([]);
    expect(urls).toHaveLength(0);
    expect(o.calls).toBe(0);
  });
});
