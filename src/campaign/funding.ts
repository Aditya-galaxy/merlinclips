/**
 * Whether the money behind a campaign actually exists.
 *
 * A pool was a number. A brand could open a campaign advertising $85,000,
 * fund nothing, and we would publish that figure to creators as the amount
 * left to earn — which is precisely the complaint this product was built to
 * answer. *"Generating genuine views and never being paid"* does not require
 * anyone to act in bad faith; it only requires a promise nobody checked.
 *
 * The remaining pool is the one number a creator uses to decide whether an
 * evening of editing is worth it. Publishing it unbacked makes it a claim
 * dressed as a guarantee.
 *
 * ## Disclosure, not enforcement
 *
 * This reports; it does not block. That is the same choice made everywhere
 * else here: we cannot conjure money, so the honest control is to say plainly
 * what is covered and what is not, before a creator spends effort rather than
 * after. A campaign funded for a tenth of its pool is not fraud — it is a
 * campaign that can pay a tenth of its pool, and a creator is entitled to
 * know that while it is still their decision.
 *
 * The balance is fetched through an injected reader so this stays testable
 * without a chain, and so a lookup failing is *reported* rather than being
 * silently read as zero. "We could not check" and "there is nothing there"
 * are different sentences and a creator deserves the right one.
 */

import { Decimal } from '../decimal';
import type { Campaign } from './types';

export type Coverage = 'covered' | 'partial' | 'empty' | 'unknown' | 'no_wallet';

export interface FundingStatus {
  readonly campaignId: string;
  /** On-chain USDC behind the campaign, or null when it could not be read. */
  readonly fundedUsdc: string | null;
  readonly poolUsdc: string;
  /** Still owed to creators from work already accepted. */
  readonly committedUsdc: string;
  readonly coverage: Coverage;
  /** Written for a creator deciding whether to spend an evening on this. */
  readonly summary: string;
}

/** Reads the USDC balance of an address on a chain. Injected so this is testable. */
export interface BalanceReader {
  usdcBalance(address: string, chain: string): Promise<Decimal | undefined>;
}

export async function fundingFor(
  campaign: Campaign & { fundingWallet?: string },
  committed: Decimal,
  reader: BalanceReader,
): Promise<FundingStatus> {
  const pool = campaign.poolUsdc;
  const base = {
    campaignId: campaign.campaignId,
    poolUsdc: pool.toString(),
    committedUsdc: committed.toString(),
  };

  if (!campaign.fundingWallet) {
    return {
      ...base,
      fundedUsdc: null,
      coverage: 'no_wallet',
      summary: 'This campaign has not named a wallet, so nothing backs its budget yet.',
    };
  }

  let balance: Decimal | undefined;
  try {
    balance = await reader.usdcBalance(campaign.fundingWallet, campaign.chain);
  } catch {
    balance = undefined;
  }

  if (balance === undefined) {
    // Not zero. A failed lookup that reads as "empty" would libel a brand that
    // funded correctly, and would do it at the exact moment the creator is
    // deciding whether to trust them.
    return {
      ...base,
      fundedUsdc: null,
      coverage: 'unknown',
      summary: 'We could not check this budget just now. Try again shortly.',
    };
  }

  const funded = balance.toString();
  if (balance.micro === 0n) {
    return { ...base, fundedUsdc: funded, coverage: 'empty',
      summary: 'Nothing is funded yet. Do not start on this one.' };
  }
  if (balance.micro >= pool.micro) {
    return { ...base, fundedUsdc: funded, coverage: 'covered',
      summary: `Fully funded. ${funded} USDC is on-chain behind a ${pool} budget.` };
  }
  return {
    ...base,
    fundedUsdc: funded,
    coverage: 'partial',
    summary:
      `Partly funded — ${funded} USDC on-chain against a ${pool} budget. ` +
      'Only what is funded can be paid.',
  };
}
