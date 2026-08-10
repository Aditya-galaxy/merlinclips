/**
 * Is everything actually connected?
 *
 * Four times in this codebase a module has been written, tested, documented,
 * and then called by nothing: the agent loop, `acceptSubmission`, the clip
 * verifier, and the reservation engine. Every one of them had passing unit
 * tests. Unit tests structurally cannot catch this — a module in isolation
 * behaves identically whether or not production ever calls it.
 *
 * The last of those was the worst: nothing judged a submitted clip, so the
 * gate refused every payout forever with `no_verdict` while every individual
 * piece worked perfectly. It was found by driving the HTTP API end to end,
 * not by reading code or running the suite.
 *
 * So reachability is asserted mechanically here, from the real entry point.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';

const SRC = resolve(import.meta.dir);
const ENTRY = resolve(SRC, 'server.ts');

/**
 * Deliberately not part of the served application. Each needs a reason, so
 * that adding to this list is a decision rather than a way to silence a test.
 */
const NOT_SERVED: Record<string, string> = {
  'simulation.ts': 'deterministic simulation harness — run by tests and `bun run sweep`',
  'sweep.ts': 'CLI entry point for the simulation sweep',
  'agent.ts': 'the marketplace purchasing agent, used by the demo console flow',
  'business/discovery.ts': 'Circle marketplace discovery, used by the business loop',
};

function sourceFiles(): string[] {
  const out: string[] = [];
  (function walk(d: string) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.ts') && !e.endsWith('.test.ts')) out.push(p);
    }
  })(SRC);
  return out;
}

function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  (function visit(file: string) {
    const f = resolve(file);
    if (seen.has(f)) return;
    seen.add(f);
    let src = '';
    try { src = readFileSync(f, 'utf8'); } catch { return; }
    for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
      for (const cand of [m[1]! + '.ts', join(m[1]!, 'index.ts')]) {
        const p = resolve(dirname(f), cand);
        try { statSync(p); visit(p); break; } catch { /* not this one */ }
      }
    }
  })(entry);
  return seen;
}

describe('nothing is built and then left unconnected', () => {
  test('every source file is reachable from the server, or explicitly excused', () => {
    const reachable = reachableFrom(ENTRY);
    const orphans = sourceFiles()
      .filter((f) => !reachable.has(resolve(f)))
      .map((f) => relative(SRC, f))
      .filter((f) => !(f in NOT_SERVED));

    expect(
      orphans,
      `Unreachable from server.ts. Either wire it in, or add it to NOT_SERVED with a reason:\n  ${orphans.join('\n  ')}`,
    ).toEqual([]);
  });

  test('the excuse list stays honest — no stale entries', () => {
    // An excused file that no longer exists means the list is drifting, and a
    // drifting allowlist eventually excuses something real.
    const present = new Set(sourceFiles().map((f) => relative(SRC, f)));
    for (const f of Object.keys(NOT_SERVED)) expect(present.has(f), `${f} is excused but gone`).toBe(true);
  });
});

describe('the payout path receives everything it needs', () => {
  const runtime = readFileSync(resolve(SRC, 'campaign/runtime.ts'), 'utf8');
  const tickCall = runtime.slice(runtime.indexOf('runTick('), runtime.indexOf('runTick(') + 900);

  // Each of these, if dropped, degrades the system silently rather than
  // loudly: no verifier means every clip blocks on `no_verdict`; no oracle
  // means no view ever confirms; no log means state dies with the instance.
  for (const dep of ['store:', 'gate:', 'oracle:', 'executor:', 'log:', 'agent:', 'verifier:']) {
    test(`runTick is given ${dep.replace(':', '')}`, () => {
      expect(tickCall).toContain(dep);
    });
  }
});

describe('the public door is defended', () => {
  const runtime = readFileSync(resolve(SRC, 'campaign/runtime.ts'), 'utf8');
  const submit = runtime.slice(runtime.indexOf('async handleSubmit('), runtime.indexOf('async handleSubmissionStatus('));

  test('submissions are rate limited — it is the one unauthenticated write', () => {
    expect(submit).toContain('rateLimiter');
  });

  test('submission acceptance is serialised per campaign', () => {
    expect(submit).toContain('withLock');
  });
});
