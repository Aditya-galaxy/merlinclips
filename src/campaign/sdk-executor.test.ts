import { describe, expect, it } from 'bun:test';
import { Decimal } from '../decimal';
import { SdkPayoutExecutor, type WalletsTransferClient } from './sdk-executor';

/**
 * The CLI executor could not be deployed: its auth is an email-OTP session on
 * somebody's laptop. This one takes an API key and an entity secret from the
 * environment, which is what lets the agent settle without a person.
 *
 * Every case injects a client and touches no network.
 */
const send = (ex: SdkPayoutExecutor) => ex.send({
  decision: { submissionId: 's1', confirmedViews: 1000n, amountUsdc: new Decimal('1.25') } as never,
  creator: { payoutAddress: '0x0000000000000000000000000000000000000001' } as never,
  campaign: { chain: 'base-sepolia' } as never,
});

function client(states: string[], txHash = '0xabc') {
  const calls: Record<string, unknown>[] = [];
  let i = 0;
  const c: WalletsTransferClient = {
    async createTransaction(input) { calls.push(input); return { data: { id: 'tx-1' } }; },
    async getTransaction() {
      const state = states[Math.min(i, states.length - 1)];
      i += 1;
      return { data: { transaction: { state, txHash: state === 'COMPLETE' ? txHash : undefined } } };
    },
  };
  return { c, calls };
}

const now = { sleep: async () => {} };

describe('the two gates, again', () => {
  it('does not send on the constructor flag alone', async () => {
    const { c, calls } = client(['COMPLETE']);
    const out = await send(new SdkPayoutExecutor({
      walletId: 'w1', client: c, dryRun: false, env: {}, ...now,
    }));
    expect(out.dryRun).toBe(true);
    expect(out.executed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('does not send on the environment alone', async () => {
    const { c, calls } = client(['COMPLETE']);
    const out = await send(new SdkPayoutExecutor({
      walletId: 'w1', client: c, env: { BROADCAST: 'true' }, ...now,
    }));
    expect(out.dryRun).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('sends only when both agree', async () => {
    const { c, calls } = client(['COMPLETE']);
    const out = await send(new SdkPayoutExecutor({
      walletId: 'w1', client: c, dryRun: false, env: { BROADCAST: 'true' }, ...now,
    }));
    expect(out.executed).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('a settled transfer', () => {
  const live = { dryRun: false, env: { BROADCAST: 'true' }, ...now };

  it('reports the hash and an explorer link', async () => {
    const { c } = client(['SENT', 'CONFIRMED', 'COMPLETE'], '0xfeed');
    const out = await send(new SdkPayoutExecutor({ walletId: 'w1', client: c, ...live }));
    expect(out.executed).toBe(true);
    expect(out.txHash).toBe('0xfeed');
    expect(out.explorerUrl).toContain('0xfeed');
  });

  it('carries an idempotency key, so a replayed pass cannot pay twice', async () => {
    const { c, calls } = client(['COMPLETE']);
    await send(new SdkPayoutExecutor({ walletId: 'w1', client: c, ...live }));
    expect(String(calls[0]!.idempotencyKey)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('pays the decided amount, not a rounded one', async () => {
    const { c, calls } = client(['COMPLETE']);
    await send(new SdkPayoutExecutor({ walletId: 'w1', client: c, ...live }));
    expect(calls[0]!.amounts).toEqual(['1.25']);
  });
});

// "Probably sent" is not something to write down as settled.
describe('what it refuses to call settled', () => {
  const live = { dryRun: false, env: { BROADCAST: 'true' }, ...now };

  for (const state of ['FAILED', 'DENIED', 'CANCELLED']) {
    it(`reports ${state} as not executed`, async () => {
      const { c } = client([state]);
      const out = await send(new SdkPayoutExecutor({ walletId: 'w1', client: c, ...live }));
      expect(out.executed).toBe(false);
      expect(out.detail).toContain(state);
    });
  }

  it('reports a transfer still in flight rather than assuming it landed', async () => {
    const { c } = client(['SENT']);
    const out = await send(new SdkPayoutExecutor({
      walletId: 'w1', client: c, timeoutMs: 5, ...live,
    }));
    expect(out.executed).toBe(false);
    expect(out.error).toContain('SENT');
  });

  it('survives a poll that throws', async () => {
    let n = 0;
    const c: WalletsTransferClient = {
      async createTransaction() { return { data: { id: 'tx-1' } }; },
      async getTransaction() {
        n += 1;
        if (n === 1) throw new Error('gateway timeout');
        return { data: { transaction: { state: 'COMPLETE', txHash: '0x1' } } };
      },
    };
    const out = await send(new SdkPayoutExecutor({ walletId: 'w1', client: c, ...live }));
    expect(out.executed).toBe(true);
  });

  it('reports a refused submission rather than throwing', async () => {
    const c: WalletsTransferClient = {
      async createTransaction() { throw new Error('insufficient funds'); },
      async getTransaction() { return {}; },
    };
    const out = await send(new SdkPayoutExecutor({ walletId: 'w1', client: c, ...live }));
    expect(out.executed).toBe(false);
    expect(out.error).toContain('insufficient');
  });

  it('refuses a chain with no USDC contract', async () => {
    const { c } = client(['COMPLETE']);
    const out = await new SdkPayoutExecutor({ walletId: 'w1', client: c, ...live }).send({
      decision: { submissionId: 's', confirmedViews: 1n, amountUsdc: new Decimal('1') } as never,
      creator: { payoutAddress: '0x1' } as never,
      campaign: { chain: 'solana' } as never,
    });
    expect(out.executed).toBe(false);
  });
});
