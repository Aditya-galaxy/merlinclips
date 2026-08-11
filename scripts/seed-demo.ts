/**
 * A campaign that can actually settle.
 *
 * The campaign sitting in production could never pay anything. Its single
 * submission was a video with 1.8 billion views against a 50 USDC pool, so
 * every hourly pass correctly refused a payout 36,000 times the entire budget,
 * and the demo had nothing to show but a refusal.
 *
 * This seeds one that works: a small pool, a real rate, a real clip, and a
 * brief the clip genuinely satisfies. Nothing here is faked — the verifier
 * still watches the video and can still say no.
 *
 * ## The hold is real, which is the point
 *
 * A payout cannot settle until the hold has elapsed. That is the product, so
 * the seed does not sidestep it: it opens the campaign with the shortest hold
 * the engine permits (one hour, MIN_DWELL_HOURS) rather than pretending a
 * 24-hour window has passed. Run it, wait an hour, tick, and a real settlement
 * appears. Backdating snapshots would have produced a settlement in seconds
 * and proved nothing.
 *
 *   bun run scripts/seed-demo.ts                      # against localhost
 *   BASE=https://merlinclips.com bun run scripts/seed-demo.ts
 *
 * Needs OPERATOR_SECRET. Reads TICK_SECRET only if you pass --tick.
 */

const BASE = Bun.env.BASE ?? 'http://localhost:8080';
const OPERATOR = Bun.env.OPERATOR_SECRET ?? '';
const TICK = Bun.env.TICK_SECRET ?? '';
const DWELL = Number(Bun.env.DWELL_HOURS ?? 1);

/** A real clip, and a brief describing what it actually contains. */
const CLIP = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const BRIEF =
  'Show the animation itself: outdoor scenery, character movement, and the ' +
  'title of the film. Sound on. No voiceover needed.';

const PAYOUT_ADDRESS = Bun.env.DEMO_WALLET ?? '0x0003a59858f44451be2a5b486ee612b4139700f0';

function line(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(22)} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json as Record<string, unknown> };
}

if (!OPERATOR) {
  console.error('OPERATOR_SECRET is unset. Campaign creation is operator-gated, deliberately.');
  process.exit(1);
}

console.log(`\nSeeding a settleable campaign on ${BASE}\n`);

const campaign = await post('/api/campaigns', {
  brief: BRIEF,
  poolUsdc: '250',
  cpmUsdc: '1.00',
  minCpmUsdc: '0.50',
  maxCpmUsdc: '2.00',
  perCreatorCapUsdc: '25',
  dwellHours: DWELL,
  settlementDays: 14,
  platforms: ['youtube'],
  chain: 'base-sepolia',
  fundingWallet: Bun.env.CAMPAIGN_WALLET ?? undefined,
}, { 'x-operator-secret': OPERATOR });

if (campaign.status >= 300) {
  console.error('Campaign was refused:', campaign.body);
  process.exit(1);
}
const campaignId = String(campaign.body.campaignId);
console.log('Campaign');
line('id', campaignId);
line('pool', `${campaign.body.poolUsdc} USDC at ${campaign.body.cpmUsdc} per 1k views`);
line('per-creator cap', `${campaign.body.perCreatorCapUsdc} USDC`);
line('hold', `${campaign.body.dwellHours}h`);

const submission = await post('/api/submissions', {
  campaignId,
  url: CLIP,
  payoutAddress: PAYOUT_ADDRESS,
});

console.log('\nSubmission');
if (submission.status >= 300) {
  console.error('  refused:', submission.body.error);
  process.exit(1);
}
line('id', String(submission.body.submissionId));
line('clip', CLIP);

console.log('\nThe hold is real. Nothing settles until it closes.');
line('settles after', new Date(Date.now() + DWELL * 3_600_000).toISOString());

if (process.argv.includes('--tick') && TICK) {
  console.log('\nRunning one pass now — expect a hold, not a payment.');
  const tick = await post('/api/tick', {}, { 'x-tick-secret': TICK });
  const decisions = (tick.body.decisions ?? []) as Array<Record<string, unknown>>;
  line('paid', tick.body.paid);
  line('held', tick.body.held);
  for (const d of decisions) {
    console.log(`  → ${d.disposition} (${d.control}) ${String(d.reason).slice(0, 96)}`);
  }
}

console.log(`\nWatch it: ${BASE}/app\n`);
