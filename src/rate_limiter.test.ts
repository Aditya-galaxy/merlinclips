import { describe, expect, test } from 'bun:test';
import { TokenBucketRateLimiter } from './rate_limiter';

describe('TokenBucketRateLimiter', () => {
  test('allows requests within capacity', () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 5, refillRate: 1 });
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.consume('client-1')).toBe(true);
    }
    // 6th request exceeds capacity
    expect(limiter.consume('client-1')).toBe(false);
  });

  test('refills tokens over time', () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 2, refillRate: 1 });
    const start = new Date('2026-08-09T10:00:00Z');

    expect(limiter.consume('client-2', 1, start)).toBe(true);
    expect(limiter.consume('client-2', 1, start)).toBe(true);
    expect(limiter.consume('client-2', 1, start)).toBe(false);

    // Advance clock by 2 seconds
    const later = new Date('2026-08-09T10:00:02Z');
    expect(limiter.consume('client-2', 1, later)).toBe(true);
  });

  test('cleans up stale buckets', () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 2, refillRate: 1, ttlMs: 1000 });
    const start = new Date('2026-08-09T10:00:00Z');

    limiter.consume('client-stale', 1, start);
    expect(limiter.size()).toBe(1);

    const later = new Date('2026-08-09T10:00:05Z');
    limiter.cleanup(later);
    expect(limiter.size()).toBe(0);
  });
});
