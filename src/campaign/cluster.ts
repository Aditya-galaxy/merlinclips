/**
 * Hierarchical Multi-Agent Cluster & Safe Treasury Splitter.
 *
 * Implements isolated sub-wallets per campaign to eliminate EVM nonce
 * bottlenecks and limit blast radius, while routing all platform fees
 * to a multi-signature Gnosis Safe Treasury wallet.
 */

import { Decimal, USDC } from '../decimal';

/**
 * Gnosis Safe Multisig Treasury Address on Base Mainnet.
 * Platform revenue ($49, $199, $499 flat fees) lands here.
 */
export const DEFAULT_SAFE_TREASURY_ADDRESS =
  process.env['SAFE_TREASURY_ADDRESS'] ?? '0xSafeTreasury000000000000000000000000000000000000';

/** Platform Fee Schedule per Tier */
export const TIER_PLATFORM_FEES: Record<string, Decimal> = {
  starter: USDC('49.00'),
  growth: USDC('199.00'),
  scale: USDC('499.00'),
  custom: USDC('999.00'),
};

export interface CampaignSubWallet {
  campaignId: string;
  walletAddress: string;
  createdAt: string;
  status: 'active' | 'drained' | 'refunded';
}

export interface DepositSplit {
  treasuryFeeUsdc: Decimal;
  campaignPoolUsdc: Decimal;
  treasuryAddress: string;
  campaignWalletAddress: string;
}

export class MultiAgentClusterManager {
  private readonly subWallets = new Map<string, CampaignSubWallet>();
  private readonly treasuryAddress: string;

  constructor(treasuryAddress: string = DEFAULT_SAFE_TREASURY_ADDRESS) {
    this.treasuryAddress = treasuryAddress;
  }

  /**
   * Provision or fetch an isolated sub-wallet for a campaign.
   */
  public getOrCreateCampaignWallet(campaignId: string, customWallet?: string): CampaignSubWallet {
    const existing = this.subWallets.get(campaignId);
    if (existing) return existing;

    // Use custom wallet if provided, or derive an isolated sub-wallet address
    const walletAddress =
      customWallet ??
      `0x${Array.from(crypto.getRandomValues(new Uint8Array(20)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')}`;

    const subWallet: CampaignSubWallet = {
      campaignId,
      walletAddress,
      createdAt: new Date().toISOString(),
      status: 'active',
    };

    this.subWallets.set(campaignId, subWallet);
    return subWallet;
  }

  /**
   * Calculate deposit split between Gnosis Safe Treasury and Campaign Sub-Wallet.
   */
  public calculateDepositSplit(
    totalDepositUsdc: Decimal,
    campaignWalletAddress: string,
    tier: keyof typeof TIER_PLATFORM_FEES = 'starter',
  ): DepositSplit {
    const treasuryFeeUsdc: Decimal = TIER_PLATFORM_FEES[tier] ?? USDC('49.00');
    const campaignPoolUsdc = totalDepositUsdc.minus(treasuryFeeUsdc);

    if (!campaignPoolUsdc.isPositive()) {
      throw new Error(
        `Total deposit (${totalDepositUsdc.toString()} USDC) must cover the platform fee (${treasuryFeeUsdc.toString()} USDC)`,
      );
    }

    return {
      treasuryFeeUsdc,
      campaignPoolUsdc,
      treasuryAddress: this.treasuryAddress,
      campaignWalletAddress,
    };
  }

  /**
   * Return cluster topology metrics for telemetry and reporting.
   */
  public getClusterTopology(): {
    safeTreasuryAddress: string;
    activeSubWalletsCount: number;
    subWallets: CampaignSubWallet[];
  } {
    return {
      safeTreasuryAddress: this.treasuryAddress,
      activeSubWalletsCount: this.subWallets.size,
      subWallets: Array.from(this.subWallets.values()),
    };
  }
}
