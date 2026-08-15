/**
 * Proving that an x402 payment actually happened.
 *
 * The paywall this backs was decorative. `verifyPayment` checked the amount,
 * network and recipient — all of them fields *the caller writes* — and then
 * accepted the payment, because signature verification was an optional
 * parameter nobody passed and the fallback was to serve anyway. A base64
 * header naming any amount and any transaction hash bought a real Gemini
 * verification for nothing, and the service recorded the fictional payment as
 * revenue received.
 *
 * That last part is the one that mattered most. A revenue figure assembled
 * from strings a stranger supplied is not a weaker number than a real one, it
 * is a different kind of thing, and this system's entire claim is that its
 * numbers can be checked.
 *
 * So: the claimed transaction is read from the chain and the USDC transfer is
 * confirmed to have happened, to us, for at least the price. Nothing the
 * caller says about the payment is trusted — the hash is the only field taken
 * at face value, and taking it at face value is safe because everything that
 * matters is then read from the ledger it points into.
 */

import { Decimal } from './decimal';

/** `Transfer(address,address,uint256)` — the only event that moves USDC. */
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export interface OnChainVerifierOptions {
  /** JSON-RPC endpoint for the settlement network. */
  readonly endpoint: string;
  /** USDC contract on that network. A transfer of anything else is not payment. */
  readonly asset: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /**
   * How recent a payment transaction must be.
   *
   * Replay protection is two things working together. Hashes already spent are
   * remembered, which stops reuse inside one process; this window stops reuse
   * *across* processes, because an instance that restarts forgets what it has
   * seen and Cloud Run recycles instances constantly. Without the window a
   * single genuine payment would buy the service forever, one cold start at a
   * time. With it, the exposure is bounded to one replay per instance within
   * the window rather than being unbounded in time.
   */
  readonly maxAgeMs?: number;
}

export type OnChainResult =
  | { ok: true; payer: string; amountUsdc: Decimal }
  | { ok: false; reason: string };

export class OnChainPaymentVerifier {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAgeMs: number;
  /** Hashes already redeemed. Bounded by the freshness window above. */
  private readonly spent = new Map<string, number>();

  constructor(private readonly options: OnChainVerifierOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 6000;
    this.maxAgeMs = options.maxAgeMs ?? 10 * 60_000;
  }

  /**
   * Confirm `txHash` paid at least `price` in USDC to `payTo`.
   *
   * Every failure is a refusal. There is no path here that serves the request
   * because something could not be checked — an RPC that will not answer means
   * we cannot prove we were paid, and doing the work anyway is the behaviour
   * this replaces.
   */
  async verify(input: {
    txHash: string;
    payTo: string;
    price: Decimal;
  }): Promise<OnChainResult> {
    const { txHash, payTo, price } = input;

    if (!TX_HASH.test(txHash)) return { ok: false, reason: 'txHash is not a transaction hash' };
    if (!ADDRESS.test(payTo)) return { ok: false, reason: 'payTo is not an address' };

    this.forgetStale();
    if (this.spent.has(txHash.toLowerCase())) {
      return { ok: false, reason: 'this payment has already been redeemed' };
    }

    const receipt = await this.rpc('eth_getTransactionReceipt', [txHash]);
    if (!receipt) return { ok: false, reason: 'could not read the transaction' };
    // Pending transactions have no receipt at all; a reverted one has a receipt
    // saying so. Neither moved money.
    if (String(receipt['status']) !== '0x1') {
      return { ok: false, reason: 'the transaction did not succeed on chain' };
    }

    const fresh = await this.isFresh(receipt);
    if (!fresh.ok) return fresh;

    const logs = (receipt['logs'] as Array<Record<string, unknown>>) ?? [];
    let paid = 0n;
    let payer = '';

    for (const log of logs) {
      // The asset check is not optional. Without it, a transfer of any token
      // that happens to implement Transfer — including a worthless one minted
      // for the purpose — reads as a USDC payment.
      if (String(log['address'] ?? '').toLowerCase() !== this.options.asset.toLowerCase()) continue;

      const topics = (log['topics'] as string[]) ?? [];
      if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
      if (topics.length < 3) continue;

      const to = '0x' + topics[2]!.slice(-40);
      if (to.toLowerCase() !== payTo.toLowerCase()) continue;

      try {
        paid += BigInt(String(log['data'] ?? '0x0'));
      } catch {
        continue;
      }
      payer = '0x' + topics[1]!.slice(-40);
    }

    if (paid === 0n) {
      return { ok: false, reason: 'no USDC transfer to this service in that transaction' };
    }
    if (paid < price.micro) {
      return {
        ok: false,
        reason: `underpaid: ${Decimal.fromMicro(paid)} USDC against a price of ${price} USDC`,
      };
    }

    this.spent.set(txHash.toLowerCase(), Date.now());
    return { ok: true, payer, amountUsdc: Decimal.fromMicro(paid) };
  }

  /** Reject a payment older than the window, so a spent hash cannot be reused. */
  private async isFresh(receipt: Record<string, unknown>): Promise<OnChainResult | { ok: true }> {
    const blockNumber = receipt['blockNumber'];
    if (typeof blockNumber !== 'string') {
      return { ok: false, reason: 'the transaction is not in a block yet' } as OnChainResult;
    }
    const block = await this.rpc('eth_getBlockByNumber', [blockNumber, false]);
    const ts = block?.['timestamp'];
    if (typeof ts !== 'string') {
      return { ok: false, reason: 'could not establish when the payment happened' } as OnChainResult;
    }
    const age = Date.now() - Number(BigInt(ts)) * 1000;
    if (age > this.maxAgeMs) {
      return {
        ok: false,
        reason: `payment is ${Math.round(age / 60_000)} minutes old — pay again`,
      } as OnChainResult;
    }
    return { ok: true };
  }

  private forgetStale(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    for (const [hash, at] of this.spent) if (at < cutoff) this.spent.delete(hash);
  }

  private async rpc(method: string, params: unknown[]): Promise<Record<string, unknown> | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.options.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { result?: Record<string, unknown> | null };
      return body.result ?? undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
