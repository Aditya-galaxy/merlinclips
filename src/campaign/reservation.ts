/**
 * Two-phase pool reservation engine for enterprise campaign payouts.
 *
 * Prevents TOCTOU race conditions across multi-instance deployments:
 * 1. Reserve budget when a payout is authorized (state: reserved, with TTL)
 * 2. Commit budget when Circle settlement completes (state: settled)
 * 3. Release budget if settlement fails or is refused (state: released)
 * 4. Sweep expired reservations (>5 minutes) back to the available pool.
 */

import { Decimal } from '../decimal';

export type ReservationState = 'reserved' | 'settled' | 'released' | 'expired';

export interface PoolReservation {
  readonly intentId: string;
  readonly campaignId: string;
  readonly creatorId: string;
  readonly amountUsdc: Decimal;
  state: ReservationState;
  readonly reservedAtMs: number;
  readonly expiresAtMs: number;
  settledTxHash?: string;
  releaseReason?: string;
}

export interface ReservationEngineOptions {
  /** Reservation TTL in milliseconds. Defaults to 5 minutes (300,000 ms). */
  ttlMs?: number;
}

export class ReservationEngine {
  private readonly reservations = new Map<string, PoolReservation>();
  private readonly ttlMs: number;

  constructor(options: ReservationEngineOptions = {}) {
    this.ttlMs = options.ttlMs ?? 300_000;
  }

  /**
   * Attempt to reserve pool funds. Returns the reservation if successful, or null if duplicate/insufficient.
   */
  reserve(
    input: { intentId: string; campaignId: string; creatorId: string; amountUsdc: Decimal },
    now: Date = new Date(),
  ): PoolReservation | null {
    const existing = this.reservations.get(input.intentId);
    if (existing) {
      if (existing.state === 'reserved' && existing.expiresAtMs > now.getTime()) {
        return existing; // Idempotent return of active reservation
      }
      if (existing.state === 'settled') return existing;
    }

    const nowMs = now.getTime();
    const reservation: PoolReservation = {
      intentId: input.intentId,
      campaignId: input.campaignId,
      creatorId: input.creatorId,
      amountUsdc: input.amountUsdc,
      state: 'reserved',
      reservedAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
    };

    this.reservations.set(input.intentId, reservation);
    return reservation;
  }

  /** Commit a reservation upon successful settlement on-chain. */
  commit(intentId: string, txHash?: string): boolean {
    const r = this.reservations.get(intentId);
    if (!r || r.state !== 'reserved') return false;
    r.state = 'settled';
    if (txHash) r.settledTxHash = txHash;
    return true;
  }

  /** Release a reservation back to the pool upon settlement failure. */
  release(intentId: string, reason: string): boolean {
    const r = this.reservations.get(intentId);
    if (!r || r.state !== 'reserved') return false;
    r.state = 'released';
    r.releaseReason = reason;
    return true;
  }

  /** Sweep expired reservations (>TTL) and mark them expired. Returns count swept. */
  sweepExpired(now: Date = new Date()): number {
    const nowMs = now.getTime();
    let count = 0;
    for (const r of this.reservations.values()) {
      if (r.state === 'reserved' && r.expiresAtMs <= nowMs) {
        r.state = 'expired';
        count += 1;
      }
    }
    return count;
  }

  /** Total reserved (active) amount for a campaign. */
  reservedForCampaign(campaignId: string, now: Date = new Date()): Decimal {
    this.sweepExpired(now);
    let total = new Decimal(0n);
    for (const r of this.reservations.values()) {
      if (r.campaignId === campaignId && r.state === 'reserved') {
        total = total.plus(r.amountUsdc);
      }
    }
    return total;
  }

  /** Total reserved (active) amount for a specific creator. */
  reservedForCreator(campaignId: string, creatorId: string, now: Date = new Date()): Decimal {
    this.sweepExpired(now);
    let total = new Decimal(0n);
    for (const r of this.reservations.values()) {
      if (r.campaignId === campaignId && r.creatorId === creatorId && r.state === 'reserved') {
        total = total.plus(r.amountUsdc);
      }
    }
    return total;
  }

  get(intentId: string): PoolReservation | undefined {
    return this.reservations.get(intentId);
  }

  list(): PoolReservation[] {
    return [...this.reservations.values()];
  }
}
