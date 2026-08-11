import { describe, expect, test } from 'bun:test';
import { WebhookNotifier, webhookFromEnv } from './webhooks';

const mockFetch = (status = 200) =>
  (async () => ({
    ok: status >= 200 && status < 300,
    status,
  })) as unknown as typeof fetch;

describe('WebhookNotifier', () => {
  test('unconfigured when no URLs provided', () => {
    const notifier = new WebhookNotifier({});
    expect(notifier.isConfigured).toBe(false);
  });

  test('configured when Slack or Discord URL provided', () => {
    const notifier = new WebhookNotifier({ slackUrl: 'https://hooks.slack.com/services/xxx' });
    expect(notifier.isConfigured).toBe(true);
  });

  test('sends alert payloads to Slack and Discord without throwing', async () => {
    let slackBody = '';
    let discordBody = '';

    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.includes('slack')) slackBody = String(init?.body);
      if (url.includes('discord')) discordBody = String(init?.body);
      return { ok: true, status: 200 };
    }) as unknown as typeof fetch;

    const notifier = new WebhookNotifier({
      slackUrl: 'https://hooks.slack.com/services/test',
      discordUrl: 'https://discord.com/api/webhooks/test',
      fetchImpl,
    });

    await notifier.alert({
      event: 'campaign_depleted',
      title: 'Campaign Budget Depleted',
      message: 'Campaign camp-123 has zero remaining balance.',
      details: { campaignId: 'camp-123' },
    });

    expect(slackBody).toContain('MERLIN CLIPS');
    expect(slackBody).toContain('camp-123');
    expect(discordBody).toContain('Campaign Budget Depleted');
  });

  test('webhookFromEnv reads SLACK_WEBHOOK_URL and DISCORD_WEBHOOK_URL', () => {
    const notifier = webhookFromEnv({
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/abc',
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/xyz',
    });
    expect(notifier.isConfigured).toBe(true);
  });
});
