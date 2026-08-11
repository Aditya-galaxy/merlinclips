/**
 * Checks the shape of your Circle credentials before you try to register.
 *
 * Never prints a secret. Reports lengths and patterns only, because the two
 * things that go wrong most often — a key from the wrong environment and a
 * secret that is not 32 bytes of hex — are both visible from shape alone.
 *
 *   CIRCLE_API_KEY=... ENTITY_SECRET=... bun run scripts/check-entity-secret.ts
 */

const key = Bun.env.CIRCLE_API_KEY?.trim() ?? '';
const secret = Bun.env.ENTITY_SECRET?.trim() ?? '';
const problems: string[] = [];
const notes: string[] = [];

console.log('\nCircle credentials\n');

// ── API key ──────────────────────────────────────────────────────────────
if (!key) {
  problems.push('CIRCLE_API_KEY is not set');
} else {
  const parts = key.split(':');
  console.log(`  api key       ${parts.length} parts, ${key.length} chars`);
  if (parts.length !== 3) {
    problems.push('CIRCLE_API_KEY should be three colon-separated parts: PREFIX:ID:SECRET');
  } else {
    const env = parts[0]!.toUpperCase();
    console.log(`  environment   ${env}`);
    if (env !== 'TEST_API_KEY' && env !== 'LIVE_API_KEY') {
      notes.push(`prefix reads "${parts[0]}" — expected TEST_API_KEY or LIVE_API_KEY`);
    }
    if (env === 'LIVE_API_KEY') {
      notes.push('this is a LIVE key. Register on testnet first — a mainnet ' +
                 'entity secret is not something to rehearse with');
    }
  }
}

// ── entity secret ────────────────────────────────────────────────────────
if (!secret) {
  problems.push('ENTITY_SECRET is not set');
} else {
  console.log(`  entity secret ${secret.length} chars`);
  if (!/^[0-9a-fA-F]+$/.test(secret)) {
    problems.push('ENTITY_SECRET must be hex — no 0x prefix, no quotes, no whitespace');
  } else if (secret.length !== 64) {
    problems.push(
      `ENTITY_SECRET is ${secret.length} hex characters; it must be 64 (32 bytes). ` +
      (secret.length === 66 ? 'That looks like a 0x prefix was left on.' : ''),
    );
  } else {
    console.log('  shape         64 hex characters — correct');
  }
}

// ── the recovery file has to land somewhere writable ─────────────────────
const home = Bun.env.HOME ?? '';
const dir = `${home}/.circle`;
try {
  await Bun.write(`${dir}/.writable-probe`, 'x');
  console.log(`  recovery path ${dir} is writable`);
} catch {
  problems.push(`${dir} is not writable — registration writes a recovery file there`);
}

console.log('');
if (problems.length) {
  console.log('Problems');
  for (const p of problems) console.log(`  ✗ ${p}`);
} else {
  console.log('  Shape looks right. If registration still fails, the message matters:');
  console.log('    "already registered"  → an entity secret exists for this key; do not');
  console.log('                            re-register, reuse it, or rotate in the console');
  console.log('    401 / unauthorized    → key is for the other environment, or revoked');
  console.log('    "invalid ciphertext"  → the secret does not match the registered one');
}
for (const n of notes) console.log(`  ! ${n}`);
console.log('');
