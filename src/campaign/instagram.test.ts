/**
 * Instagram view counts, and the ways they must fail.
 *
 * The rule this shares with every other oracle: a failure is `undefined`, never
 * zero. Zero is a real answer meaning nobody watched, and the dwell mechanic
 * takes the *minimum* across the window — so one zero from a blip permanently
 * caps a clip's confirmed count at zero and the creator is never paid for views
 * they actually had.
 *
 * The rule specific to this one: a count is only readable for media inside an
 * account that authorised us. That is what stops a creator claiming somebody
 * else's reel, so "not ours" must resolve to "could not tell" rather than to
 * anything a payout could be computed from.
 */

import { describe, expect, test } from 'bun:test';

import {
  InstagramOracle,
  InstagramOracleUnavailable,
  instagramFromEnv,
  shortcodeOf,
} from './instagram';

const OURS = 'CxyzOURS123';
const THEIRS = 'CxyzTHEIRS9';

/** A fetch that answers the two endpoints this oracle uses. */
function fake(options: {
  media?: Array<{ id: string; permalink: string }>;
  views?: number;
  metricErrors?: string[];
  status?: number;
  onCall?: (url: string) => void;
} = {}) {
  const calls: string[] = [];
  const media = options.media ?? [{ id: 'media-1', permalink: `https://www.instagram.com/reel/${OURS}/` }];

  const fetchImpl = (async (url: string | URL) => {
    const href = String(url);
    calls.push(href);
    options.onCall?.(href);

    if (options.status && options.status !== 200) {
      return new Response('{"error":{"code":190}}', { status: options.status });
    }

    if (href.includes('/me/media')) {
      return Response.json({ data: media });
    }

    if (href.includes('/insights')) {
      const metric = new URL(href).searchParams.get('metric')!;
      if (options.metricErrors?.includes(metric)) {
        return new Response('{"error":{"message":"invalid metric"}}', { status: 400 });
      }
      return Response.json({ data: [{ values: [{ value: options.views ?? 1234 }] }] });
    }

    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

const oracle = (fetchImpl: typeof fetch, tokens = ['tok-a']) =>
  new InstagramOracle({ tokens, fetchImpl });

describe('reading a count for media we hold a token for', () => {
  test('resolves the shortcode to a media id and returns its views', async () => {
    const { fetchImpl } = fake({ views: 4_820 });
    expect(await oracle(fetchImpl).count({ platform: 'instagram', postId: OURS })).toBe(4_820n);
  });

  test('a zero from the platform is a real zero, not a failure', async () => {
    // The one case where zero is the honest answer: the API said so.
    const { fetchImpl } = fake({ views: 0 });
    expect(await oracle(fetchImpl).count({ platform: 'instagram', postId: OURS })).toBe(0n);
  });

  test('another platform is not this oracle to answer', async () => {
    const { fetchImpl, calls } = fake();
    expect(await oracle(fetchImpl).count({ platform: 'youtube', postId: OURS })).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe('media nobody authorised us for', () => {
  test('a shortcode outside every authorising account is undefined, not zero', async () => {
    // The anti-fraud property. A creator submitting someone else's reel gets a
    // clip that never accrues, rather than one that accrues against a count we
    // had no right to read.
    const { fetchImpl } = fake();
    expect(await oracle(fetchImpl).count({ platform: 'instagram', postId: THEIRS }))
      .toBeUndefined();
  });

  test('no insights call is made for media we could not place', async () => {
    const { fetchImpl, calls } = fake();
    await oracle(fetchImpl).count({ platform: 'instagram', postId: THEIRS });
    expect(calls.some((c) => c.includes('/insights'))).toBe(false);
  });
});

describe('when the API will not answer', () => {
  test('an expired token reads as undefined rather than zero', async () => {
    const { fetchImpl } = fake({ status: 400 });
    expect(await oracle(fetchImpl).count({ platform: 'instagram', postId: OURS }))
      .toBeUndefined();
  });

  test('a network failure reads as undefined rather than zero', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    expect(await oracle(fetchImpl).count({ platform: 'instagram', postId: OURS }))
      .toBeUndefined();
  });

  test('an empty values array is undefined, not zero', async () => {
    // A metric that exists but is unpopulated returns the envelope and no
    // values. Coercing that to 0 would cap the clip through the dwell minimum.
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).includes('/me/media')) {
        return Response.json({ data: [{ id: 'm1', permalink: `https://www.instagram.com/reel/${OURS}/` }] });
      }
      return Response.json({ data: [{ values: [] }] });
    }) as unknown as typeof fetch;
    expect(await oracle(fetchImpl).count({ platform: 'instagram', postId: OURS }))
      .toBeUndefined();
  });

  test('a transient listing failure does not erase what we could read before', async () => {
    // Every token failing at once is a blip, not every creator deleting every
    // reel. Emptying the index would answer "could not tell" for clips that
    // were readable a moment ago.
    let fail = false;
    const fetchImpl = (async (url: string | URL) => {
      const href = String(url);
      if (fail) throw new Error('ECONNRESET');
      if (href.includes('/me/media')) {
        return Response.json({ data: [{ id: 'm1', permalink: `https://www.instagram.com/reel/${OURS}/` }] });
      }
      return Response.json({ data: [{ values: [{ value: 77 }] }] });
    }) as unknown as typeof fetch;

    const o = new InstagramOracle({ tokens: ['t'], fetchImpl, listingTtlMs: 0 });
    expect(await o.count({ platform: 'instagram', postId: OURS })).toBe(77n);

    fail = true;
    // The listing refresh fails; the index survives, and the insights call is
    // what reports the failure — as undefined.
    expect(await o.count({ platform: 'instagram', postId: OURS })).toBeUndefined();
  });
});

describe('surviving a metric rename', () => {
  test('falls through to a working metric name', async () => {
    // Meta folded `plays` and `video_views` into `views`. An unknown metric is
    // a request error, so a retired name would fail every call and look like a
    // clip nobody watched.
    const { fetchImpl } = fake({ metricErrors: ['views'], views: 900 });
    expect(await oracle(fetchImpl).count({ platform: 'instagram', postId: OURS })).toBe(900n);
  });

  test('the working name is remembered rather than rediscovered', async () => {
    const { fetchImpl, calls } = fake({ metricErrors: ['views'], views: 900 });
    const o = oracle(fetchImpl);
    await o.count({ platform: 'instagram', postId: OURS });
    const first = calls.filter((c) => c.includes('/insights')).length;
    await o.count({ platform: 'instagram', postId: OURS });
    const second = calls.filter((c) => c.includes('/insights')).length - first;
    expect(first).toBe(2);   // views failed, plays worked
    expect(second).toBe(1);  // straight to plays
  });
});

describe('the media listing is not refetched per clip', () => {
  test('two lookups share one listing', async () => {
    // The tick iterates submissions. Re-listing per clip would spend the rate
    // limit relearning the same thing.
    const { fetchImpl, calls } = fake({
      media: [
        { id: 'm1', permalink: `https://www.instagram.com/reel/${OURS}/` },
        { id: 'm2', permalink: 'https://www.instagram.com/reel/CsecondONE/' },
      ],
    });
    const o = oracle(fetchImpl);
    await o.count({ platform: 'instagram', postId: OURS });
    await o.count({ platform: 'instagram', postId: 'CsecondONE' });
    expect(calls.filter((c) => c.includes('/me/media')).length).toBe(1);
  });
});

describe('the flag is the presence of tokens', () => {
  test('unset gives an oracle that answers nothing', async () => {
    const o = instagramFromEnv({});
    expect(o).toBeInstanceOf(InstagramOracleUnavailable);
    expect(await o.count({ platform: 'instagram', postId: OURS })).toBeUndefined();
  });

  test('blank and whitespace-only are unset, not a token', () => {
    // `''.split(',')` is `['']`, which would otherwise configure one empty
    // token and produce an oracle that 400s on every call.
    expect(instagramFromEnv({ INSTAGRAM_TESTER_TOKENS: '' }))
      .toBeInstanceOf(InstagramOracleUnavailable);
    expect(instagramFromEnv({ INSTAGRAM_TESTER_TOKENS: ' , ' }))
      .toBeInstanceOf(InstagramOracleUnavailable);
  });

  test('one or more tokens builds the real oracle', () => {
    expect(instagramFromEnv({ INSTAGRAM_TESTER_TOKENS: 'a,b' }))
      .toBeInstanceOf(InstagramOracle);
  });
});

describe('pulling a shortcode out of a permalink', () => {
  test('reads reel, p and tv forms', () => {
    expect(shortcodeOf('https://www.instagram.com/reel/ABC123/')).toBe('ABC123');
    expect(shortcodeOf('https://www.instagram.com/p/ABC123/')).toBe('ABC123');
    expect(shortcodeOf('https://www.instagram.com/tv/ABC123/')).toBe('ABC123');
  });

  test('ignores a query string and a handle prefix', () => {
    expect(shortcodeOf('https://www.instagram.com/reel/ABC123/?igsh=xyz')).toBe('ABC123');
    expect(shortcodeOf('https://www.instagram.com/thecreator/reel/ABC123/')).toBe('ABC123');
  });

  test('an unrecognised permalink yields nothing rather than a guess', () => {
    expect(shortcodeOf('https://www.instagram.com/thecreator/')).toBeUndefined();
  });
});

/**
 * The flag governs the whole path, not just the oracle.
 *
 * An oracle nobody may submit to is dead weight; a platform open for
 * submissions with nothing able to count it takes a creator's work against a
 * number that will never exist. Both follow from one variable so they cannot
 * drift apart.
 */
describe('one flag, three gates', () => {
  const load = async () => {
    const { enabledPlatforms } = await import('./runtime');
    const { previewClip, MemoryTrackingStore } = await import('./verify');
    const { openCampaign } = await import('./intake');
    return { enabledPlatforms, previewClip, MemoryTrackingStore, openCampaign };
  };

  const REEL = 'https://www.instagram.com/reel/Cabc123/';
  const brief = 'Clip the launch stream and keep it under 60 seconds.';

  test('off: the oracle is unavailable, preview refuses, campaigns refuse', async () => {
    const { enabledPlatforms, previewClip, MemoryTrackingStore, openCampaign } = await load();
    const enabled = enabledPlatforms({});

    expect(enabled.has('instagram')).toBe(false);
    expect(instagramFromEnv({})).toBeInstanceOf(InstagramOracleUnavailable);

    const preview = previewClip({ url: REEL }, { tracking: new MemoryTrackingStore(), enabled });
    expect(preview.supported).toBe(false);

    const campaign = openCampaign(
      { brief, poolUsdc: '100', cpmUsdc: '2', perCreatorCapUsdc: '10',
        dwellHours: 24, platforms: ['instagram'], chain: 'base-sepolia' },
      new Date(),
      enabled,
    );
    expect(campaign.ok).toBe(false);
  });

  test('on: all three open together', async () => {
    const { enabledPlatforms, previewClip, MemoryTrackingStore, openCampaign } = await load();
    const enabled = enabledPlatforms({ INSTAGRAM_TESTER_TOKENS: 'tok' });

    expect(enabled.has('instagram')).toBe(true);
    expect(instagramFromEnv({ INSTAGRAM_TESTER_TOKENS: 'tok' })).toBeInstanceOf(InstagramOracle);

    const preview = previewClip({ url: REEL }, { tracking: new MemoryTrackingStore(), enabled });
    expect(preview.supported).toBe(true);
    expect(preview.platform).toBe('instagram');

    const campaign = openCampaign(
      { brief, poolUsdc: '100', cpmUsdc: '2', perCreatorCapUsdc: '10',
        dwellHours: 24, platforms: ['instagram'], chain: 'base-sepolia' },
      new Date(),
      enabled,
    );
    expect(campaign.ok).toBe(true);
  });

  test('YouTube is unaffected either way', async () => {
    const { enabledPlatforms } = await load();
    expect(enabledPlatforms({}).has('youtube')).toBe(true);
    expect(enabledPlatforms({ INSTAGRAM_TESTER_TOKENS: 'tok' }).has('youtube')).toBe(true);
  });
});
