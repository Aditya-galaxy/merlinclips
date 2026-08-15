/**
 * The paywall was decorative, and these are the reasons it was.
 *
 * `verifyPayment` checked the amount, the network and the recipient — every
 * one of them a field the caller writes — and then served the request, because
 * signature verification was an optional argument nobody passed and the
 * fallback was to accept. A base64 header naming any transaction hash bought a
 * real Gemini call for nothing, and the fictional payment was appended to the
 * ledger as revenue received.
 *
 * Verified against production before the fix: a forged header returned 200 and
 * a full verdict.
 *
 * So these tests are about the one question that matters — did the money
 * actually arrive — and about every way of appearing to have paid without
 * having paid.
 */

import { describe, expect, test } from 'bun:test';

import { Decimal } from './decimal';
import { OnChainPaymentVerifier } from './x402onchain';

const US = '0xf461c5bb7e314670ae5c5eeb9929b15728ab2b6c';
const THEM = '0x0003a59858f44451be2a5b486ee612b4139700f0';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const OTHER_TOKEN = '0x1111111111111111111111111111111111111111';
const TX = '0x' + 'a'.repeat(64);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const topicFor = (address: string) => '0x' + address.slice(2).toLowerCase().padStart(64, '0');

/** An RPC that returns one receipt and a block timestamped `ageMs` ago. */
function rpc(options: {
  logs?: Array<{ address: string; topics: string[]; data: string }>;
  status?: string;
  ageMs?: number;
  receipt?: null;
  blockNumber?: string | null;
}) {
  const ts = Math.floor((Date.now() - (options.ageMs ?? 5_000)) / 1000);
  return (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    if (body.method === 'eth_getTransactionReceipt') {
      if (options.receipt === null) return Response.json({ result: null });
      return Response.json({
        result: {
          status: options.status ?? '0x1',
          blockNumber: options.blockNumber === null ? undefined : (options.blockNumber ?? '0x10'),
          logs: options.logs ?? [],
        },
      });
    }
    if (body.method === 'eth_getBlockByNumber') {
      return Response.json({ result: { timestamp: '0x' + ts.toString(16) } });
    }
    return Response.json({ result: null });
  }) as unknown as typeof fetch;
}

const paymentOf = (micro: number, to = US, token = USDC) => ({
  address: token,
  topics: [TRANSFER, topicFor(THEM), topicFor(to)],
  data: '0x' + micro.toString(16),
});

const verifier = (fetchImpl: typeof fetch, maxAgeMs?: number) =>
  new OnChainPaymentVerifier({ endpoint: 'https://rpc.test', asset: USDC, fetchImpl, maxAgeMs });

const price = new Decimal('0.05');

describe('a payment that really happened', () => {
  test('is accepted, and reports the chain amount rather than the claimed one', async () => {
    const r = await verifier(rpc({ logs: [paymentOf(50_000)] }))
      .verify({ txHash: TX, payTo: US, price });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.amountUsdc.toString()).toBe('0.05');
      expect(r.payer.toLowerCase()).toBe(THEM.toLowerCase());
    }
  });

  test('overpaying is fine — the buyer chose to', async () => {
    const r = await verifier(rpc({ logs: [paymentOf(200_000)] }))
      .verify({ txHash: TX, payTo: US, price });
    expect(r.ok).toBe(true);
  });
});

describe('appearing to have paid', () => {
  test('a transaction that moved nothing to us is refused', async () => {
    // The forged header case. A real hash, even a real transfer — just not to
    // this service.
    const r = await verifier(rpc({ logs: [paymentOf(50_000, THEM)] }))
      .verify({ txHash: TX, payTo: US, price });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('no USDC transfer');
  });

  test('a transfer of some other token is not payment', async () => {
    // Anyone can mint a token, send themselves a billion of it, and point at
    // the transfer. Without the asset check it reads as USDC.
    const r = await verifier(rpc({ logs: [paymentOf(50_000, US, OTHER_TOKEN)] }))
      .verify({ txHash: TX, payTo: US, price });
    expect(r.ok).toBe(false);
  });

  test('underpaying is refused rather than rounded up to goodwill', async () => {
    const r = await verifier(rpc({ logs: [paymentOf(49_999)] }))
      .verify({ txHash: TX, payTo: US, price });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('underpaid');
  });

  test('a reverted transaction is refused', async () => {
    const r = await verifier(rpc({ logs: [paymentOf(50_000)], status: '0x0' }))
      .verify({ txHash: TX, payTo: US, price });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('did not succeed');
  });

  test('a hash that is not on chain at all is refused', async () => {
    const r = await verifier(rpc({ receipt: null })).verify({ txHash: TX, payTo: US, price });
    expect(r.ok).toBe(false);
  });

  test('a made-up hash shape is refused before any RPC call', async () => {
    let called = false;
    const spy = (async () => { called = true; return Response.json({ result: null }); }) as unknown as typeof fetch;
    const r = await verifier(spy).verify({ txHash: '0xnope', payTo: US, price });
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe('spending the same payment twice', () => {
  test('the second redemption is refused', async () => {
    const v = verifier(rpc({ logs: [paymentOf(50_000)] }));
    expect((await v.verify({ txHash: TX, payTo: US, price })).ok).toBe(true);
    const second = await v.verify({ txHash: TX, payTo: US, price });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toContain('already been redeemed');
  });

  test('an old payment is refused even by an instance that never saw it', async () => {
    // Cloud Run recycles instances, so the spent-set alone would let one real
    // payment buy the service forever, one cold start at a time. The freshness
    // window is what bounds that.
    const r = await verifier(rpc({ logs: [paymentOf(50_000)], ageMs: 60 * 60_000 }), 10 * 60_000)
      .verify({ txHash: TX, payTo: US, price });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('old');
  });
});

describe('when the chain cannot be reached', () => {
  test('an unreachable RPC refuses rather than serving', async () => {
    // The behaviour being replaced: could not check, so served anyway.
    const dead = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    const r = await verifier(dead).verify({ txHash: TX, payTo: US, price });
    expect(r.ok).toBe(false);
  });

  test('a pending transaction with no block is refused', async () => {
    const r = await verifier(rpc({ logs: [paymentOf(50_000)], blockNumber: null }))
      .verify({ txHash: TX, payTo: US, price });
    expect(r.ok).toBe(false);
  });
});
