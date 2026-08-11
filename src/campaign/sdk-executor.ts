/**
 * Settling payouts through Circle's Wallets SDK instead of the CLI.
 *
 * The CLI executor works, and it cannot be deployed. Its authentication is an
 * email-OTP session that expires in about a month and lives on the machine
 * somebody logged in from. A Cloud Run container has no such session, and
 * `circle wallet login` needs a code emailed to a person — so the payout path
 * ran perfectly on a laptop and could never have run where the agent actually
 * runs.
 *
 * That is not a small deployment detail. "The agent executes transactions on
 * its own, without human intervention" is the claim this product is built on,
 * and a path that requires a human to have logged in does not meet it.
 *
 * This authenticates with an API key and an entity secret from the
 * environment. No session, no expiry, no person.
 *
 * ## What it does not change
 *
 * The gate still decides. This only carries out a decision already made, and
 * it inherits the same two-gate broadcast rule: a constructor flag alone
 * cannot send money, the environment has to agree as well.
 */

import type { PaymentOutcome } from '../schemas';
import type { Campaign, Creator } from './types';
import type { PayoutDecision } from './payout';
import type { PayoutExecutor } from './tick';
import { idempotencyUuid, USDC_TOKEN, EXPLORER } from './executor';

/** Terminal states. Anything else is still in flight. */
const DONE = new Set(['COMPLETE', 'FAILED', 'DENIED', 'CANCELLED']);
const GOOD = 'COMPLETE';

/** Only the SDK surface used, so this is testable without a network. */
export interface WalletsTransferClient {
  createTransaction(input: {
    walletId: string;
    tokenAddress: string;
    destinationAddress: string;
    amounts: string[];
    idempotencyKey?: string;
    fee: { type: string; config: { feeLevel: string } };
  }): Promise<{ data?: { id?: string; state?: string } }>;
  getTransaction(input: { id: string }): Promise<{
    data?: { transaction?: { state?: string; txHash?: string } };
  }>;
}

export interface SdkExecutorOptions {
  /** The developer-controlled wallet the campaign pays from. */
  readonly walletId: string;
  readonly client: WalletsTransferClient;
  readonly dryRun?: boolean;
  readonly env?: Record<string, string | undefined>;
  /** How long to wait for a terminal state before reporting in flight. */
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class SdkPayoutExecutor implements PayoutExecutor {
  private readonly dryRun: boolean;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: SdkExecutorOptions) {
    // The same two gates as the CLI executor, for the same reason: a flag
    // passed while testing something else must not be able to move money.
    const envAllows = (options.env ?? Bun.env).BROADCAST === 'true';
    this.dryRun = (options.dryRun ?? true) || !envAllows;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async send(input: {
    decision: PayoutDecision; creator: Creator; campaign: Campaign;
  }): Promise<PaymentOutcome> {
    const { decision, creator, campaign } = input;
    const intentId = `pay-${decision.submissionId}-${decision.confirmedViews}`;
    const settledAt = new Date().toISOString();
    const amount = decision.amountUsdc.toString();

    if (this.dryRun) {
      return {
        intentId, executed: false, dryRun: true, settledAt,
        detail: `would send ${amount} USDC to ${creator.payoutAddress} on ${campaign.chain}`,
      };
    }

    const token = USDC_TOKEN[campaign.chain];
    if (!token) {
      return {
        intentId, executed: false, dryRun: false, settledAt,
        detail: 'no USDC contract for this chain', error: `unsupported chain ${campaign.chain}`,
      };
    }

    let transactionId: string | undefined;
    try {
      const created = await this.options.client.createTransaction({
        walletId: this.options.walletId,
        tokenAddress: token,
        destinationAddress: creator.payoutAddress,
        amounts: [amount],
        // Derived from the submission and the view count, so a replayed pass
        // reaches the same transaction rather than paying twice.
        idempotencyKey: idempotencyUuid(intentId),
        fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      });
      transactionId = created.data?.id;
      if (!transactionId) {
        return {
          intentId, executed: false, dryRun: false, settledAt,
          detail: 'Circle accepted no transaction', error: 'no transaction id returned',
        };
      }
    } catch (error) {
      return {
        intentId, executed: false, dryRun: false, settledAt,
        detail: 'could not submit the transfer',
        error: (error as Error).message?.slice(0, 300),
      };
    }

    // Poll to a terminal state. An in-flight transfer is reported as not
    // executed rather than assumed good — the ledger records what we know,
    // and "probably sent" is not something to write down as settled.
    const deadline = Date.now() + this.timeoutMs;
    let state = 'INITIATED';
    let txHash: string | undefined;

    while (Date.now() < deadline) {
      try {
        const got = await this.options.client.getTransaction({ id: transactionId });
        state = got.data?.transaction?.state ?? state;
        txHash = got.data?.transaction?.txHash ?? txHash;
      } catch {
        // A failed poll is not a failed payment; keep asking until the deadline.
      }
      if (DONE.has(state)) break;
      await this.sleep(2_000);
    }

    const executed = state === GOOD;
    return {
      intentId,
      executed,
      dryRun: false,
      settledAt,
      txHash,
      explorerUrl: txHash ? `${EXPLORER[campaign.chain] ?? ''}${txHash}` : undefined,
      detail: executed
        ? `sent ${amount} USDC to ${creator.payoutAddress} on ${campaign.chain}`
        : `transfer ended in ${state}`,
      error: executed ? undefined : `transaction ${transactionId} is ${state}`,
    };
  }
}
