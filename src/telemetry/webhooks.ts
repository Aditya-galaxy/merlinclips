/**
 * Operations Webhook Notifier for critical events.
 *
 * Sends non-blocking alerts to Slack and Discord webhooks when:
 * 1. `campaign_depleted`: Campaign pool budget is exhausted.
 * 2. `payout_failed`: On-chain USDC settlement fails or errors.
 * 3. `lease_contention`: Multi-instance Cloud Run lease acquisition is contention-blocked.
 */

export type AlertEvent = 'campaign_depleted' | 'payout_failed' | 'lease_contention' | 'enquiry_received';

export interface WebhookAlertPayload {
  readonly event: AlertEvent;
  readonly title: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly timestamp?: string;
}

export interface WebhookOptions {
  readonly slackUrl?: string;
  readonly discordUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string) => void;
}

export class WebhookNotifier {
  private readonly slackUrl?: string;
  private readonly discordUrl?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;

  constructor(options: WebhookOptions = {}) {
    this.slackUrl = options.slackUrl?.trim() || Bun.env.SLACK_WEBHOOK_URL?.trim();
    this.discordUrl = options.discordUrl?.trim() || Bun.env.DISCORD_WEBHOOK_URL?.trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? (() => {});
  }

  get isConfigured(): boolean {
    return Boolean(this.slackUrl || this.discordUrl);
  }

  async alert(payload: WebhookAlertPayload): Promise<void> {
    if (!this.isConfigured) return;

    const ts = payload.timestamp ?? new Date().toISOString();
    const formattedTitle = `🚨 [MERLIN CLIPS] ${payload.title}`;

    const tasks: Promise<void>[] = [];

    if (this.slackUrl) {
      tasks.push(this.sendSlack(formattedTitle, payload, ts));
    }
    if (this.discordUrl) {
      tasks.push(this.sendDiscord(formattedTitle, payload, ts));
    }

    try {
      await Promise.allSettled(tasks);
    } catch {
      /* non-blocking */
    }
  }

  private async sendSlack(title: string, payload: WebhookAlertPayload, ts: string): Promise<void> {
    const text = `*${title}*\n>${payload.message}\n\`\`\`${JSON.stringify(payload.details ?? {}, null, 2)}\`\`\`\n_Time: ${ts}_`;
    try {
      const res = await this.fetchImpl(this.slackUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) this.log(`webhook slack HTTP ${res.status}`);
    } catch (err) {
      this.log(`webhook slack error: ${(err as Error).message}`);
    }
  }

  private async sendDiscord(title: string, payload: WebhookAlertPayload, ts: string): Promise<void> {
    const color = payload.event === 'payout_failed' ? 0xEF4444 : payload.event === 'campaign_depleted' ? 0xF59E0B : 0x7C3AED;
    const body = {
      content: title,
      embeds: [
        {
          title: payload.title,
          description: payload.message,
          color,
          fields: Object.entries(payload.details ?? {}).map(([key, val]) => ({
            name: key,
            value: String(val),
            inline: true,
          })),
          timestamp: ts,
        },
      ],
    };
    try {
      const res = await this.fetchImpl(this.discordUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) this.log(`webhook discord HTTP ${res.status}`);
    } catch (err) {
      this.log(`webhook discord error: ${(err as Error).message}`);
    }
  }
}

export function webhookFromEnv(env: Record<string, string | undefined> = Bun.env): WebhookNotifier {
  return new WebhookNotifier({
    slackUrl: env.SLACK_WEBHOOK_URL,
    discordUrl: env.DISCORD_WEBHOOK_URL,
  });
}
