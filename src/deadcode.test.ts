/**
 * Nothing is constructed and then left uncalled.
 *
 * `wiring.test.ts` catches a *file* nothing imports, which is how the X oracle
 * was stopped before it shipped unconnected. It cannot see the smaller version
 * of the same mistake: an engine assigned to a field, wired into no path, and
 * described in a document as though it ran.
 *
 * That is exactly how MultiAgentClusterManager sat on the runtime for weeks —
 * constructed, exported, documented, and used zero times, while a design
 * document described the guarantee it was supposed to provide. The cost was
 * not the wasted code. It was that the guarantee was written down as real.
 *
 * Two checks, both deliberately narrow. A broad "is this symbol used" sweep
 * over a TypeScript codebase produces false positives faster than anyone will
 * keep triaging them, and a test people learn to ignore is worse than no test.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(import.meta.dir);

/**
 * Fields allowed to exist without a caller, and why.
 *
 * Empty on purpose. An entry here is a promise that something is coming; if
 * one lingers, that is the signal to delete the field rather than extend the
 * excuse.
 */
const UNCALLED_IS_FINE: Record<string, string> = {};

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) out.push(path);
    }
  };
  walk(SRC);
  return out;
}

const production = sourceFiles();
const allSource = production.map((f) => readFileSync(f, 'utf8')).join('\n');

describe('nothing is built and then left uncalled', () => {
  test('every engine assigned to a field is actually used somewhere', () => {
    // `public readonly x = new Thing()` promises x does something. If nothing
    // ever reads `this.x.` or `runtime.x.`, the promise is unkept.
    const dead: string[] = [];

    for (const file of production) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(
        /^\s*(?:public\s+)?readonly\s+([a-zA-Z_$][\w$]*)\s*=\s*new\s+([A-Z][\w$]*)/gm,
      )) {
        const field = m[1]!;
        const cls = m[2]!;
        if (field in UNCALLED_IS_FINE) continue;

        // A call through the instance, from anywhere including tests — a field
        // exercised only by tests is still a field nothing in production runs,
        // but it is a different conversation, so both count here.
        const used = new RegExp(`\\.${field}\\.[a-zA-Z_$]`).test(allSource);
        if (!used) dead.push(`${field} (${cls}) — constructed, never called`);
      }
    }

    expect(dead).toEqual([]);
  });

  test('the excuse list stays honest — no entry for a field that does not exist', () => {
    const declared = new Set<string>();
    for (const file of production) {
      for (const m of readFileSync(file, 'utf8').matchAll(
        /^\s*(?:public\s+)?readonly\s+([a-zA-Z_$][\w$]*)\s*=\s*new\s+[A-Z]/gm,
      )) {
        declared.add(m[1]!);
      }
    }
    const stale = Object.keys(UNCALLED_IS_FINE).filter((f) => !declared.has(f));
    expect(stale).toEqual([]);
  });

  test('an exported class is referenced somewhere other than its own declaration', () => {
    // Counting references rather than cross-file imports, because a class used
    // by a factory in its own module is not dead — CircleDeveloperSdkExecutor
    // is exactly that, reached only through createPayoutExecutor beside it.
    // Anything appearing exactly once is appearing only where it is declared.
    const everything = sourceFilesIncludingTests()
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const dead: string[] = [];

    for (const file of production) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/^export\s+(?:abstract\s+)?class\s+([A-Z][\w$]*)/gm)) {
        const name = m[1]!;
        const references = everything.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0;
        if (references <= 1) {
          dead.push(`${name} in ${file.slice(SRC.length + 1)} — declared and never referenced`);
        }
      }
    }

    expect(dead).toEqual([]);
  });
});

function sourceFilesIncludingTests(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts')) out.push(path);
    }
  };
  walk(SRC);
  return out;
}
