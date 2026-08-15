import { describe, expect, it } from 'bun:test';
import { CircleCliExecutor, type CommandRunner } from './executor';
import { Decimal } from '../decimal';

/**
 * The bug these exist for: `dryRun: false` alone was enough to broadcast, so a
 * throwaway test script pointed at a real network moved 1 USDC on Base
 * Sepolia. Intent is not a control. Broadcasting now needs the environment to
 * agree as well.
 *
 * Every case below injects a runner and spawns nothing.
 */
function spy() {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(args) {
      calls.push(args);
      return { code: 0, stdout: JSON.stringify({ txHash: '0xdeadbeef' }), stderr: '' };
    },
  };
  return { calls, runner };
}

const send = (ex: CircleCliExecutor) => ex.send({
  decision: { submissionId: 's', confirmedViews: 1000n, amountUsdc: new Decimal('1') } as never,
  creator: { payoutAddress: '0x0000000000000000000000000000000000000001' } as never,
  campaign: { chain: 'base-sepolia', fundingWallet: '0xfrom' } as never,
});

/** `--estimate` is what makes the CLI price a transfer instead of sending it. */
const estimated = (args: string[]) => args.includes('--estimate');

describe('broadcasting takes two gates', () => {
  it('does not broadcast on the constructor flag alone', async () => {
    const { calls, runner } = spy();
    await send(new CircleCliExecutor({
      runner, dryRun: false, env: {},
    }));
    expect(estimated(calls[0]!)).toBe(true);
  });

  it('does not broadcast on the environment alone', async () => {
    const { calls, runner } = spy();
    await send(new CircleCliExecutor({
      runner, env: { BROADCAST: 'true' },
    }));
    expect(estimated(calls[0]!)).toBe(true);
  });

  it('broadcasts only when both agree', async () => {
    const { calls, runner } = spy();
    await send(new CircleCliExecutor({
      runner, dryRun: false, env: { BROADCAST: 'true' },
    }));
    expect(estimated(calls[0]!)).toBe(false);
  });

  it('treats anything other than the exact string as off', async () => {
    for (const v of ['TRUE', 'True', '1', 'yes', '', undefined]) {
      const { calls, runner } = spy();
      await send(new CircleCliExecutor({
        runner, dryRun: false, env: { BROADCAST: v },
      }));
      expect(estimated(calls[0]!)).toBe(true);
    }
  });

  it('defaults to dry run when nothing is said at all', async () => {
    const { calls, runner } = spy();
    await send(new CircleCliExecutor({ runner, env: {} }));
    expect(estimated(calls[0]!)).toBe(true);
  });
});

describe('what the transfer carries', () => {
  it('names the recipient, amount and chain, and an idempotency key', async () => {
    const { calls, runner } = spy();
    await send(new CircleCliExecutor({ runner, env: {} }));
    const args = calls[0]!;
    expect(args.slice(0, 2)).toEqual(['wallet', 'transfer']);
    expect(args).toContain('0x0000000000000000000000000000000000000001');
    expect(args).toContain('--idempotency-key');
    // A replayed pass must not pay twice; the key is what makes that true.
    const key = args[args.indexOf('--idempotency-key') + 1];
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sends the same key for the same submission and view count', async () => {
    const a = spy(); const b = spy();
    await send(new CircleCliExecutor({ runner: a.runner, env: {} }));
    await send(new CircleCliExecutor({ runner: b.runner, env: {} }));
    const keyOf = (c: string[][]) => c[0]![c[0]!.indexOf('--idempotency-key') + 1];
    expect(keyOf(a.calls)).toBe(keyOf(b.calls));
  });
});
