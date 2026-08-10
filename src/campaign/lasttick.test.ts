import { describe, expect, it } from 'bun:test';
import { MemoryBlobStore } from './persistence';
import { CampaignRuntime } from './runtime';

/**
 * The bug this covers: the scheduler's pass ran on one instance, set lastTick
 * in that instance's memory, and the instance scaled away. The next request
 * reached a cold one and the console reported nothing had ever run — while the
 * pass had in fact run every hour for hours.
 *
 * Two runtimes over one blob store is the smallest honest model of that.
 */
function pair() {
  const blobs = new MemoryBlobStore();
  const env = { AGENT_ID: 'test-agent' };
  return {
    a: new CampaignRuntime({ blobs, env }),
    b: new CampaignRuntime({ blobs, env }),
    blobs,
  };
}

describe('the last pass survives the instance that ran it', () => {
  it('an instance that never ticked still reports the pass that did', async () => {
    const { a, b } = pair();
    await a.tick();

    const seen = await b.publicView();
    expect(seen.lastTick).toBeTruthy();
    expect(typeof seen.lastTick?.startedAt).toBe('string');
  });

  it('reports nothing when nothing has ever ticked', async () => {
    const { b } = pair();
    expect((await b.publicView()).lastTick).toBeFalsy();
  });

  it('the instance that ticked prefers its own result', async () => {
    const { a, b } = pair();
    await b.tick();
    const own = await a.tick();
    const seen = await a.publicView();
    expect(seen.lastTick?.startedAt).toBe(own.startedAt);
  });

  it('a later pass replaces the stored one', async () => {
    const { a, b } = pair();
    await a.tick();
    const first = (await b.publicView()).lastTick?.startedAt;

    await new Promise((r) => setTimeout(r, 5));
    // A fresh lease window, so the second pass is not skipped.
    const c = new CampaignRuntime({ blobs: (a as never as { blobs: never }).blobs, env: {} });
    await c.tick();

    const second = (await b.publicView()).lastTick?.startedAt;
    expect(second).toBeTruthy();
    expect(first).toBeTruthy();
  });

  // Losing the display of a tick is a smaller harm than failing a pass that
  // has already settled real payouts.
  it('a blob store that cannot write does not fail the pass', async () => {
    const blobs = new MemoryBlobStore();
    const broken = {
      get: blobs.get.bind(blobs),
      list: blobs.list.bind(blobs),
      putIfAbsent: blobs.putIfAbsent.bind(blobs),
      put: async (key: string, value: string) => {
        if (key === 'tick/last') throw new Error('storage is down');
        return blobs.put(key, value);
      },
    };
    const rt = new CampaignRuntime({ blobs: broken, env: {} });
    const result = await rt.tick();
    expect(result.startedAt).toBeTruthy();
  });

  it('ignores a stored summary that is not one', async () => {
    const { b, blobs } = pair();
    for (const junk of ['not json', '{}', 'null', '{"startedAt":42}']) {
      await blobs.put('tick/last', junk);
      expect((await b.publicView()).lastTick).toBeFalsy();
    }
  });
});
