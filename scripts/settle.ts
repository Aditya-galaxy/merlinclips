/**
 * Run one settlement pass from a machine that can sign.
 *
 * Circle Agent Stack authenticates with an emailed OTP and keeps a session
 * that expires in about twenty days. There is nothing to bake into a container
 * image and no token to inject, so Cloud Run cannot broadcast a payout — the
 * deployed service reaches the executor and fails with `Executable not found
 * in $PATH: "circle"`.
 *
 * Everything else the pass does works there: campaigns, verification, view
 * observation, the gate. Only the final signature needs a logged-in machine.
 * This runs the identical code against the identical state, so the pass is the
 * same pass — it simply executes where the key is.
 *
 *   gcloud auth login                       # once
 *   circle wallet status                    # confirm the session is VALID
 *   bun run settle                          # dry run, decides nothing
 *   BROADCAST=true bun run settle           # actually pays
 *
 * Dry run is the default. Broadcasting is opt-in on every invocation rather
 * than a state the script can be left in.
 */

import { CampaignRuntime } from '../src/campaign/runtime';
import { GcsBlobStore } from '../src/campaign/persistence';

const BUCKET = process.env['GCS_BUCKET'] ?? 'merlinclips-state';
const broadcasting = process.env['BROADCAST'] === 'true';

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

if (!process.env['GCS_ACCESS_TOKEN']) {
  fail(
    'No GCS_ACCESS_TOKEN. This runs off Cloud Run, so it needs your own token:\n\n'
    + '    export GCS_ACCESS_TOKEN=$(gcloud auth print-access-token)\n',
  );
}

console.log(`\n  bucket        ${BUCKET}`);
console.log(`  mode          ${broadcasting ? 'BROADCASTING — this moves USDC' : 'dry run (estimate only)'}`);

if (broadcasting) {
  // A deliberate pause. The difference between the two modes is money leaving,
  // and a typo in a shell should not be the only thing between them.
  console.log('\n  Broadcasting in 5 seconds. Ctrl-C to stop.');
  await new Promise((r) => setTimeout(r, 5000));
}

const runtime = new CampaignRuntime({ blobs: new GcsBlobStore(BUCKET) });
await runtime.ready();

const state = runtime.store.exportState();
console.log(`\n  campaigns     ${state.campaigns.length}`);
console.log(`  submissions   ${state.submissions.length}`);
console.log(`  payouts so far${' '.repeat(0)} ${state.payouts.length}`);

const result = await runtime.tick();

if (result.skipped) {
  console.log(`\n  skipped: ${result.skipped}`);
  console.log('  Another instance holds this five-minute window. Try again shortly.\n');
  process.exit(0);
}

console.log(`\n  paid          ${result.paid}`);
console.log(`  held          ${result.held}`);
console.log(`  blocked       ${result.blocked}`);
console.log(`  needsApproval ${result.needsApproval}`);
console.log(`  totalPaid     ${result.totalPaidUsdc} USDC`);

for (const v of result.verdictsRecorded) console.log(`  verdict       ${v}`);
for (const e of result.errors) console.log(`  error         ${e}`);

// The decisions are the interesting part of a pass that paid nobody: each one
// names which gate refused and why, rather than leaving a silent zero.
for (const d of result.decisions) {
  if (d.disposition !== 'auto_pay') {
    console.log(`  ${d.disposition.padEnd(13)} ${d.reason}`);
  }
}

const settled = runtime.store.exportState().payouts;
if (settled.length) {
  console.log('\n  settlements:');
  for (const p of settled) {
    // The chain decides the explorer, not the campaign id. Testing the id for
    // "sepolia" printed a mainnet link for a testnet settlement.
    const chain = runtime.store.campaign(p.campaignId)?.chain ?? '';
    const host = chain.includes('sepolia') ? 'sepolia.basescan.org' : 'basescan.org';
    const tx = p.txHash ? `https://${host}/tx/${p.txHash}` : 'recorded, not broadcast';
    console.log(`    ${p.amountUsdc} USDC · ${p.viewsPaidTo} views · ${tx}`);
  }
}
console.log('');
