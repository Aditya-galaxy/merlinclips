import { describe, expect, it } from 'bun:test';
import { RpcBalanceReader, usdcAddress } from './balances';

const WALLET = '0x840175F5106eb2FAa7408c0B38002e09f80D5Da2';

/** Encodes a uint256 the way an eth_call result carries one. */
function word(micro: bigint): string {
  return `0x${micro.toString(16).padStart(64, '0')}`;
}

function reader(handler: (req: Request) => Response | Promise<Response>, timeoutMs = 4000) {
  return new RpcBalanceReader({
    timeoutMs,
    fetchImpl: (input, init) =>
      Promise.resolve(handler(new Request(input, init as RequestInit))),
  });
}

const ok = (result: string) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });

describe('reading a balance', () => {
  it('converts micro-units to a decimal', async () => {
    const got = await reader(() => ok(word(1_204_660_000n))).usdcBalance(WALLET, 'base-sepolia');
    expect(got?.toString()).toBe('1204.66');
  });

  it('reads a genuine zero as zero, not as unknown', async () => {
    const got = await reader(() => ok(word(0n))).usdcBalance(WALLET, 'base');
    expect(got).toBeDefined();
    expect(got?.toString()).toBe('0');
  });

  it('calls balanceOf on the canonical USDC contract with the address padded', async () => {
    let seen: { to?: string; data?: string } = {};
    await reader(async (req) => {
      const body = (await req.json()) as { params: [{ to: string; data: string }, string] };
      seen = body.params[0];
      return ok(word(5_000_000n));
    }).usdcBalance(WALLET, 'base');

    expect(seen.to).toBe(usdcAddress('base'));
    expect(seen.data?.slice(0, 10)).toBe('0x70a08231');
    expect(seen.data?.slice(10)).toBe(WALLET.slice(2).toLowerCase().padStart(64, '0'));
    expect(seen.data).toHaveLength(74);
  });
});

// Everything below is the same assertion: a failure must be undefined, never
// zero. `fundingFor` reports "we could not check" and "there is nothing there"
// differently, and that distinction only survives if this never guesses.
describe('failure is never mistaken for an empty wallet', () => {
  const cases: Array<[string, () => Response | Promise<Response>]> = [
    ['a JSON-RPC error carried inside a 200', () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'x' } }),
        { status: 200 })],
    ['an HTTP error', () => new Response('gateway timeout', { status: 504 })],
    ['a body that is not JSON', () => new Response('<html>rate limited</html>', { status: 200 })],
    ['a result that is not a hex string', () => ok('not-hex' as string)],
    ['an empty result, which is what a call to a non-contract returns', () => ok('0x')],
    ['a result member that is missing entirely', () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1 }), { status: 200 })],
    ['the network throwing', () => { throw new Error('ECONNREFUSED'); }],
  ];

  for (const [name, handler] of cases) {
    it(`returns undefined for ${name}`, async () => {
      expect(await reader(handler).usdcBalance(WALLET, 'base')).toBeUndefined();
    });
  }

  // Modelled on what fetch actually does: a request that outlives its signal
  // rejects, it does not hang. A fake that ignored the signal would have the
  // test hang rather than prove the timeout.
  it('returns undefined when the request outlives its timeout', async () => {
    const slow = new RpcBalanceReader({
      timeoutMs: 25,
      fetchImpl: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    });
    expect(await slow.usdcBalance(WALLET, 'base')).toBeUndefined();
  });
});

describe('inputs it refuses to look up', () => {
  it('does not call out for an unsupported chain', async () => {
    let called = false;
    const r = reader(() => { called = true; return ok(word(1n)); });
    expect(await r.usdcBalance(WALLET, 'solana')).toBeUndefined();
    expect(called).toBe(false);
  });

  it('does not call out for a malformed address', async () => {
    let called = false;
    const r = reader(() => { called = true; return ok(word(1n)); });
    for (const bad of ['', 'not-an-address', '0x123', `${WALLET}00`]) {
      expect(await r.usdcBalance(bad, 'base')).toBeUndefined();
    }
    expect(called).toBe(false);
  });
});

describe('token addresses', () => {
  it('knows every settlement chain', () => {
    for (const chain of ['base', 'base-sepolia', 'ethereum', 'eth-sepolia',
      'polygon', 'polygon-amoy'] as const) {
      expect(usdcAddress(chain)).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it('does not use the same contract for mainnet and its testnet', () => {
    expect(usdcAddress('base')).not.toBe(usdcAddress('base-sepolia'));
  });
});
