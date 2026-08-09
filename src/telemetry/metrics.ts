/**
 * Production Telemetry and OpenTelemetry/Prometheus compatible metrics collector.
 *
 * Tracks disposition counters, payout volumes, latency histograms, and oracle health.
 */

export interface MetricSnapshot {
  readonly counters: Record<string, number>;
  readonly gauges: Record<string, number>;
}

export class TelemetryCollector {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  inc(metric: string, value = 1): void {
    const current = this.counters.get(metric) ?? 0;
    this.counters.set(metric, current + value);
  }

  gauge(metric: string, value: number): void {
    this.gauges.set(metric, value);
  }

  recordPayout(disposition: string, control: string, amountMicroUsdc: bigint): void {
    this.inc(`merlin_payouts_total{disposition="${disposition}",control="${control}"}`);
    if (disposition === 'auto_pay') {
      this.inc('merlin_payout_amount_micro_usdc_total', Number(amountMicroUsdc));
    }
  }

  recordHttpRequest(endpoint: string, status: number): void {
    this.inc(`merlin_http_requests_total{endpoint="${endpoint}",status="${status}"}`);
  }

  snapshot(): MetricSnapshot {
    return {
      counters: Object.fromEntries(this.counters.entries()),
      gauges: Object.fromEntries(this.gauges.entries()),
    };
  }

  toPrometheusFormat(): string {
    const lines: string[] = [];
    for (const [key, val] of this.counters.entries()) {
      const name = key.split('{')[0]!;
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${key} ${val}`);
    }
    for (const [key, val] of this.gauges.entries()) {
      const name = key.split('{')[0]!;
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${key} ${val}`);
    }
    return lines.join('\n');
  }
}

export const telemetry = new TelemetryCollector();
