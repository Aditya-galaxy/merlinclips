import { describe, expect, test } from 'bun:test';
import { CampaignStore } from './store';
import { AccountService } from './accounts';

describe('AccountService — Account to Wallet Linkage', () => {
  test('creates a new account and links an EVM wallet address', () => {
    const store = new CampaignStore();
    const service = new AccountService(store);

    const acc = service.getOrCreateAccount({
      accountId: 'acc-123',
      name: 'Alice',
      email: 'alice@example.com',
    });

    expect(acc.accountId).toBe('acc-123');
    expect(acc.email).toBe('alice@example.com');
    expect(acc.linkedWallets).toHaveLength(0);

    const updated = service.linkWallet('acc-123', '0x0003a59858f44451be2a5b486ee612b4139700f0', 'base');
    expect(updated.linkedWallets).toHaveLength(1);
    expect(updated.linkedWallets[0]!.address).toBe('0x0003a59858f44451be2a5b486ee612b4139700f0');
  });

  test('does not duplicate an already linked wallet', () => {
    const store = new CampaignStore();
    const service = new AccountService(store);

    service.linkWallet('acc-123', '0x0003a59858f44451be2a5b486ee612b4139700f0', 'base');
    const again = service.linkWallet('acc-123', '0x0003A59858F44451BE2A5B486EE612B4139700F0', 'base');

    expect(again.linkedWallets).toHaveLength(1);
  });
});
