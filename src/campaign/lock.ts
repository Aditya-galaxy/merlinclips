/**
 * Per-campaign lock manager for enterprise execution.
 *
 * Provides mutual exclusion per `campaignId` across concurrent operations
 * (intake, tick passes, rate revisions). Serializing per campaign prevents TOCTOU
 * budget allocation races while allowing complete parallelism across distinct campaigns.
 */

export class CampaignLockManager {
  private readonly locks = new Map<string, Promise<void>>();

  /**
   * Acquire a lock for a given campaignId and run the callback exclusively.
   */
  async withLock<T>(campaignId: string, fn: () => Promise<T>): Promise<T> {
    const previousLock = this.locks.get(campaignId) ?? Promise.resolve();

    let releaseLock: () => void = () => {};
    const nextLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    // Register our lock in the chain
    this.locks.set(campaignId, previousLock.then(() => nextLock));

    try {
      await previousLock;
      return await fn();
    } finally {
      releaseLock();
      if (this.locks.get(campaignId) === nextLock) {
        this.locks.delete(campaignId);
      }
    }
  }

  isLocked(campaignId: string): boolean {
    return this.locks.has(campaignId);
  }
}
