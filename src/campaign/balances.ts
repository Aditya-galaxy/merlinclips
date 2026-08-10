/**
 * Reading the USDC actually sitting behind a campaign.
 *
 * `fundingFor` has always taken an injected `BalanceReader`, and the runtime
 * has always had a field to hold one. Nothing ever assigned it. Every campaign
 * therefore fell through to the fallback branch and published
 * `coverage: 'unknown'` with "Budget not checked on this deployment" — on
 * every deployment, because there was no deployment where it could have been.
 *
 * A field typed as optional and never set is indistinguishable from a feature
 * that is merely unconfigured, which is why this went unnoticed: the output
 * was a plausible sentence rather than a crash.
 *
 * ## No dependency
 *
 * One `eth_call` against `balanceOf(address)`. Pulling in a chain library to
 * hex-encode 32 bytes and parse one integer back would add a dependency to the
 * critical path of a page that loads nothing, in exchange for saving about
 * fifteen lines.
 *
 * ## Failure is `undefined`, never zero
 *
 * `fundingFor` distinguishes "we could not check" from "there is nothing
 * there", and that distinction only survives if this never guesses. An RPC
 * timeout must not tell a creator a funded campaign is empty, and it must not
 * tell them an empty one is funded either.
 */

import { Decimal } from '../decimal';
import type { Chain } from '../schemas';
import type { BalanceReader } from './funding';

/** `balanceOf(address)`, the first four bytes of its keccak hash. */
const BALANCE_OF = '0x70a08231';

/**
 * Canonical USDC, per chain. Hard-coded rather than configurable: an
 * environment variable naming the token contract is an environment variable
 * that can point the balance check at a token somebody minted themselves.
 */
const USDC: Partial<Record<Chain, string>> = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  'eth-sepolia': '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  'polygon-amoy': '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
};

const RPC: Partial<Record<Chain, string>> = {
  base: 'https://mainnet.base.org',
  'base-sepolia': 'https://sepolia.base.org',
  ethereum: 'https://eth.llamarpc.com',
  'eth-sepolia': 'https://ethereum-sepolia-rpc.publicnode.com',
  polygon: 'https://polygon-rpc.com',
  'polygon-amoy': 'https://rpc-amoy.polygon.technology',
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Only the call signature, not the whole of `typeof fetch`. Bun's fetch also
 * carries `preconnect`, and requiring it would mean every test double had to
 * stub a method this code never calls.
 */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;

export interface RpcBalanceOptions {
  /** Overrides per chain, so a deployment can use its own node. */
  readonly endpoints?: Partial<Record<Chain, string>>;
  readonly fetchImpl?: FetchLike;
  /** A funding badge is not worth holding a page open for. */
  readonly timeoutMs?: number;
}

export class RpcBalanceReader implements BalanceReader {
  private readonly endpoints: Partial<Record<Chain, string>>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: RpcBalanceOptions = {}) {
    this.endpoints = { ...RPC, ...(options.endpoints ?? {}) };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 4000;
  }

  async usdcBalance(address: string, chain: string): Promise<Decimal | undefined> {
    const key = chain as Chain;
    const token = USDC[key];
    const endpoint = this.endpoints[key];
    // An unknown chain is a thing we cannot check, not a thing that is empty.
    if (!token || !endpoint) return undefined;
    if (!ADDRESS.test(address)) return undefined;

    // The single argument, left-padded to 32 bytes.
    const data = BALANCE_OF + address.slice(2).toLowerCase().padStart(64, '0');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [{ to: token, data }, 'latest'],
        }),
      });
      if (!res.ok) return undefined;

      const body = (await res.json()) as { result?: unknown; error?: unknown };
      // A JSON-RPC error is a 200 with an `error` member, so checking the
      // status alone would read a node's complaint as a balance.
      if (body.error || typeof body.result !== 'string') return undefined;

      const hex = body.result.trim();
      if (!/^0x[0-9a-fA-F]*$/.test(hex)) return undefined;
      // '0x' with nothing after it is what a call to a non-contract returns.
      if (hex.length <= 2) return undefined;

      // USDC is 6 decimals, and the value is micro-units all the way down.
      return Decimal.fromMicro(BigInt(hex));
    } catch {
      // Abort, network failure, malformed JSON. All the same answer: we did
      // not find out. Saying zero here would libel a funded campaign.
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Exposed for tests and for anyone auditing which token is being read. */
export function usdcAddress(chain: Chain): string | undefined {
  return USDC[chain];
}
