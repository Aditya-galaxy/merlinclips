import { describe, expect, test } from 'bun:test';
import { CampaignLockManager } from './lock';

describe('CampaignLockManager', () => {
  test('executes operations per campaign sequentially', async () => {
    const lock = new CampaignLockManager();
    const order: number[] = [];

    const p1 = lock.withLock('c1', async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
    });

    const p2 = lock.withLock('c1', async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  test('allows parallel execution across distinct campaigns', async () => {
    const lock = new CampaignLockManager();
    const order: string[] = [];

    const p1 = lock.withLock('c1', async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push('c1');
    });

    const p2 = lock.withLock('c2', async () => {
      order.push('c2');
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual(['c2', 'c1']);
  });
});
