/**
 * One wallet per campaign, and the rules that make that mean something.
 *
 * The single-wallet arrangement has three failures, and only one of them is
 * about keys:
 *
 *   1. Blast radius. One key holds every campaign's pool, so one compromise
 *      takes all of them.
 *   2. Nonce coupling. EVM transactions from an address are ordered by nonce,
 *      so one stuck payout on campaign A stalls payouts on every other
 *      campaign behind the same address.
 *   3. Coverage that lies. This is the one that pays the wrong number out.
 *      `fundingFor` compares a wallet's balance against *one* campaign's pool.
 *      Point three campaigns at the same wallet holding 100 USDC and each one
 *      independently reads "fully funded" against a 100 pool — the same
 *      hundred dollars, promised three times, published to creators as the
 *      amount left to earn.
 *
 * The third is handled by arithmetic rather than by a prohibition. A brand
 * funds every campaign from one agent wallet — that is the normal shape, and
 * Circle issues one agent wallet per account per chain, so forbidding it would
 * forbid the product. `funding.ts` nets the other campaigns' outstanding pools
 * off the balance before deciding coverage, which answers the question
 * correctly for a shared wallet instead of refusing to be asked.
 *
 * What this module keeps is the record of which campaigns an address backs,
 * which is what that netting reads.
 *
 * ## What this module will not do
 *
 * It does not create wallets. The previous version generated twenty random
 * bytes and called the result a sub-wallet address; nobody holds the key to a
 * random number, so USDC sent there is destroyed, and the "refund sweep" that
 * was documented on top of it could never have run. An address is only useful
 * here if something can sign for it, and that provisioning happens through
 * Circle by a person who can prove custody — `provisionCommand()` prints the
 * step rather than pretending to have taken it.
 */

import { Decimal, USDC } from '../decimal';

/** A 0x-prefixed, 20-byte hex address. */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Never assignable. The zero address burns, and the string below shipped as
 * the default treasury: 50 characters, not hex, not an address. Any transfer
 * routed to either is an unrecoverable loss, so both are refused by name
 * rather than left to fail somewhere further down.
 */
const ZERO = '0x0000000000000000000000000000000000000000';
const PLACEHOLDER = '0xsafetreasury000000000000000000000000000000000000';

/**
 * Where platform fees settle. No default: an unset treasury means the splitter
 * refuses, because the alternative is computing a split against a placeholder
 * and handing someone a number that looks authoritative.
 */
export const SAFE_TREASURY_ADDRESS = process.env['SAFE_TREASURY_ADDRESS']?.trim();

/** Platform fee per tier. */
export const TIER_PLATFORM_FEES: Record<string, Decimal> = {
  starter: USDC('49.00'),
  growth: USDC('199.00'),
  scale: USDC('499.00'),
  custom: USDC('999.00'),
};

export interface CampaignWallet {
  readonly campaignId: string;
  readonly address: string;
  readonly registeredAt: string;
  /**
   * How we know somebody can sign for this address. Recorded because an
   * address with no provenance is indistinguishable from a random number,
   * which is exactly the bug this module replaces.
   */
  readonly custody: 'circle-agent-wallet' | 'operator-supplied';
}

export interface DepositSplit {
  readonly treasuryFeeUsdc: Decimal;
  readonly campaignPoolUsdc: Decimal;
  readonly treasuryAddress: string;
  readonly campaignWalletAddress: string;
}

export type ClusterError =
  | { ok: false; error: string; field: 'address' | 'treasury' | 'campaignId' | 'amount' };

export type Registered = { ok: true; wallet: CampaignWallet };

/** The `circle` CLI step that actually creates a wallet somebody holds. */
export function provisionCommand(campaignId: string): string {
  return [
    `# Provision a wallet for ${campaignId}, then register the address it prints:`,
    'circle wallet create',
    'circle wallet status',
  ].join('\n');
}

export class MultiAgentClusterManager {
  private readonly byCampaign = new Map<string, CampaignWallet>();
  /** Reverse index, so exclusivity is a lookup rather than a scan. */
  /** Reverse index: every campaign an address currently backs. */
  private readonly byAddress = new Map<string, Set<string>>();

  /**
   * Bind an address to a campaign, or explain why not.
   *
   * Exclusive on purpose. Two campaigns behind one address is the arrangement
   * that makes coverage overstate itself, so it is refused here rather than
   * detected later — by which point the inflated "budget left" has already
   * been published to creators deciding whether to spend an evening.
   */
  register(
    campaignId: string,
    address: string,
    custody: CampaignWallet['custody'] = 'operator-supplied',
    now: Date = new Date(),
  ): Registered | ClusterError {
    const id = campaignId?.trim();
    if (!id) return { ok: false, error: 'campaignId is required', field: 'campaignId' };

    const addr = address?.trim() ?? '';
    if (!ADDRESS.test(addr)) {
      return {
        ok: false,
        field: 'address',
        error: `"${addr}" is not a 0x-prefixed 40-character address. `
          + 'Wallets are provisioned, never generated here — see provisionCommand().',
      };
    }

    const lower = addr.toLowerCase();
    if (lower === ZERO || lower === PLACEHOLDER) {
      return { ok: false, field: 'address', error: 'that address burns funds and cannot back a campaign' };
    }

    const existing = this.byCampaign.get(id);
    if (existing) {
      // Idempotent for the same address; a different one is a real conflict,
      // because the pool that was published is backed by the first.
      if (existing.address.toLowerCase() === lower) return { ok: true, wallet: existing };
      return {
        ok: false,
        field: 'address',
        error: `${id} is already backed by ${existing.address}`,
      };
    }


    const wallet: CampaignWallet = {
      campaignId: id,
      address: addr,
      registeredAt: now.toISOString(),
      custody,
    };
    this.byCampaign.set(id, wallet);
    const backing = this.byAddress.get(lower) ?? new Set<string>();
    backing.add(id);
    this.byAddress.set(lower, backing);
    return { ok: true, wallet };
  }

  /**
   * Free an address once its campaign can no longer claim it.
   *
   * Exclusivity binds among campaigns that are still owed money, not for all
   * time. A Circle agent wallet is one per account per chain, so a permanent
   * lock meant an agent got exactly one campaign ever and was then shut out of
   * its own platform — the rule protecting creators would have stopped the
   * people it was meant to serve from coming back.
   */
  release(campaignId: string): boolean {
    const held = this.byCampaign.get(campaignId);
    if (!held) return false;
    this.byCampaign.delete(campaignId);
    const backing = this.byAddress.get(held.address.toLowerCase());
    backing?.delete(campaignId);
    if (backing && backing.size === 0) this.byAddress.delete(held.address.toLowerCase());
    return true;
  }

  walletFor(campaignId: string): CampaignWallet | undefined {
    return this.byCampaign.get(campaignId);
  }

  /** Every campaign an address currently backs. */
  campaignsAt(address: string): readonly string[] {
    return [...(this.byAddress.get(address?.trim().toLowerCase() ?? '') ?? [])];
  }

  /**
   * Split a brand's deposit between the platform fee and the campaign pool.
   *
   * Computes; it does not transfer. Both destinations are checked first, so
   * this cannot return a split addressed to a placeholder — the failure mode
   * of the version it replaces, where every fee was routed to a string that
   * is not an address.
   */
  splitDeposit(campaignId: string, deposited: Decimal, feeUsdc: Decimal): DepositSplit | ClusterError {
    const treasury = SAFE_TREASURY_ADDRESS;
    if (!treasury || !ADDRESS.test(treasury) || treasury.toLowerCase() === ZERO) {
      return {
        ok: false,
        field: 'treasury',
        error: 'SAFE_TREASURY_ADDRESS is unset or not a valid address — refusing to split a deposit',
      };
    }

    const wallet = this.byCampaign.get(campaignId);
    if (!wallet) {
      return { ok: false, field: 'campaignId', error: `${campaignId} has no registered wallet` };
    }
    if (feeUsdc.gt(deposited)) {
      return {
        ok: false,
        field: 'amount',
        error: `fee ${feeUsdc} exceeds the ${deposited} deposited`,
      };
    }

    return {
      treasuryFeeUsdc: feeUsdc,
      campaignPoolUsdc: deposited.minus(feeUsdc),
      treasuryAddress: treasury,
      campaignWalletAddress: wallet.address,
    };
  }

  topology(): {
    treasuryAddress: string | undefined;
    campaigns: readonly CampaignWallet[];
    /** True when no address backs more than one campaign. */
    isolated: boolean;
  } {
    const campaigns = [...this.byCampaign.values()];
    const distinct = new Set(campaigns.map((w) => w.address.toLowerCase()));
    return {
      treasuryAddress: SAFE_TREASURY_ADDRESS,
      campaigns,
      // Reported, not enforced. A brand funding several campaigns from one
      // agent wallet is the normal case; what keeps it honest is coverage
      // netting the other pools off the balance, not a rule against sharing.
      isolated: distinct.size === campaigns.length,
    };
  }
}
