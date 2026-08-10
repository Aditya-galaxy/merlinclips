/**
 * Token Bucket Rate Limiter for public HTTP endpoints.
 *
 * Enterprise protection against DoS, brute-force requests, and memory exhaustion.
 * Thread-safe for single-instance Node/Bun, expandable to Redis for cluster deployments.
 */

export interface RateLimiterOptions {
  /** Maximum tokens allowed in the bucket. */
  capacity: number;
  /** Tokens added per second. */
  refillRate: number;
  /** Cleanup interval for stale buckets in milliseconds. */
  ttlMs?: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillRate: number;
  private readonly ttlMs: number;

  constructor(options: RateLimiterOptions) {
    this.capacity = options.capacity;
    this.refillRate = options.refillRate;
    this.ttlMs = options.ttlMs ?? 3_600_000; // 1 hour default TTL
  }

  /**
   * Consume tokens for a given key (e.g. IP address or client ID).
   * Returns true if allowed, false if rate limited.
   */
  consume(key: string, tokens = 1, now: Date = new Date()): boolean {
    const nowMs = now.getTime();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefillMs: nowMs };
      this.buckets.set(key, bucket);
    } else {
      // Refill tokens based on elapsed time
      const elapsedSeconds = (nowMs - bucket.lastRefillMs) / 1000;
      if (elapsedSeconds > 0) {
        bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillRate);
        bucket.lastRefillMs = nowMs;
      }
    }

    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      return true;
    }

    return false;
  }

  /** Clear stale buckets that have not been refilled recently. */
  cleanup(now: Date = new Date()): void {
    const nowMs = now.getTime();
    for (const [key, bucket] of this.buckets.entries()) {
      if (nowMs - bucket.lastRefillMs > this.ttlMs) {
        this.buckets.delete(key);
      }
    }
  }

  size(): number {
    return this.buckets.size;
  }
}
