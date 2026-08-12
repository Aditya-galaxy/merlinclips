import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SAFE_TREASURY_ADDRESS,
  MultiAgentClusterManager,
  TIER_PLATFORM_FEES,
} from './cluster';
import { Decimal } from '../decimal';

describe('Hierarchical Multi-Agent Cluster & Safe Treasury', () => {
  test('provisions an isolated sub-wallet per campaign', () => {
    const cluster = new MultiAgentClusterManager();
    const w1 = cluster.getOrCreateCampaignWallet('camp-1');
    const w2 = cluster.getOrCreateCampaignWallet('camp-2');

    expect(w1.campaignId).toBe('camp-1');
    expect(w2.campaignId).toBe('camp-2');
    expect(w1.walletAddress).not.toBe(w2.walletAddress);
    expect(w1.walletAddress).toMatch(/^0x[a-f0-9]{40}$/i);
    expect(w2.walletAddress).toMatch(/^0x[a-f0-9]{40}$/i);
  });

  test('returns existing sub-wallet if fetched again for same campaign', () => {
    const cluster = new MultiAgentClusterManager();
    const w1 = cluster.getOrCreateCampaignWallet('camp-alpha');
    const w2 = cluster.getOrCreateCampaignWallet('camp-alpha');

    expect(w1).toBe(w2);
    expect(w1.walletAddress).toBe(w2.walletAddress);
  });

  test('splits deposit accurately between Gnosis Safe Treasury and Campaign Wallet', () => {
    const cluster = new MultiAgentClusterManager('0xSafeTreasury123456789012345678901234567890123456');
    const subWallet = cluster.getOrCreateCampaignWallet('camp-beta');

    const totalDeposit = new Decimal('549.00'); // $500 pool + $49 starter fee
    const split = cluster.calculateDepositSplit(totalDeposit, subWallet.walletAddress, 'starter');

    expect(split.treasuryFeeUsdc.toString()).toBe('49');
    expect(split.campaignPoolUsdc.toString()).toBe('500');
    expect(split.treasuryAddress).toBe('0xSafeTreasury123456789012345678901234567890123456');
    expect(split.campaignWalletAddress).toBe(subWallet.walletAddress);
  });

  test('throws if deposit is less than platform fee', () => {
    const cluster = new MultiAgentClusterManager();
    const subWallet = cluster.getOrCreateCampaignWallet('camp-gamma');

    const invalidDeposit = new Decimal('20.00'); // less than $49 fee
    expect(() => {
      cluster.calculateDepositSplit(invalidDeposit, subWallet.walletAddress, 'starter');
    }).toThrow(/must cover the platform fee/);
  });

  test('reports active cluster topology for telemetry', () => {
    const cluster = new MultiAgentClusterManager();
    cluster.getOrCreateCampaignWallet('camp-100');
    cluster.getOrCreateCampaignWallet('camp-200');

    const topology = cluster.getClusterTopology();
    expect(topology.activeSubWalletsCount).toBe(2);
    expect(topology.safeTreasuryAddress).toBe(DEFAULT_SAFE_TREASURY_ADDRESS);
    expect(topology.subWallets.length).toBe(2);
  });
});
