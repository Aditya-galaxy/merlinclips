/**
 * The published contract, which nothing was checking.
 *
 * `openapi.json` is served at `/openapi.json` and Circle's marketplace requires
 * it so a *buying* agent can read our inputs and outputs itself rather than
 * being told about them by a human. It is the one artifact in this repo whose
 * audience is a machine that has never met us.
 *
 * It was committed broken — a closing brace lost while splicing in the campaign
 * endpoints — and the full suite stayed green, because a JSON file nobody parses
 * is a JSON file nobody validates. A marketplace listing would have failed
 * against a contract that could not be read at all.
 */

import { describe, expect, test } from 'bun:test';

const spec = await Bun.file(new URL('../../openapi.json', import.meta.url)).text();

describe('openapi.json is readable by the machines it is for', () => {
  test('it parses', () => {
    // The whole reason this file exists. It has been broken once.
    expect(() => JSON.parse(spec)).not.toThrow();
  });

  test('it is recognisably OpenAPI', () => {
    const doc = JSON.parse(spec);
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info?.title).toBeTruthy();
    expect(doc.info?.version).toBeTruthy();
    expect(Object.keys(doc.paths ?? {}).length).toBeGreaterThan(0);
  });

  test('every path declares at least one operation with an operationId', () => {
    // An agent picks a call by operationId. A path without one is undiscoverable.
    const doc = JSON.parse(spec);
    for (const [route, item] of Object.entries<Record<string, any>>(doc.paths)) {
      const ops = Object.entries(item).filter(([m]) =>
        ['get', 'post', 'put', 'patch', 'delete'].includes(m),
      );
      expect(ops.length).toBeGreaterThan(0);
      for (const [method, op] of ops) {
        expect(op.operationId, `${method.toUpperCase()} ${route}`).toBeTruthy();
        expect(op.responses, `${method.toUpperCase()} ${route}`).toBeTruthy();
      }
    }
  });

  test('operationIds are unique, or an agent cannot address them', () => {
    const doc = JSON.parse(spec);
    const ids: string[] = [];
    for (const item of Object.values<Record<string, any>>(doc.paths)) {
      for (const [m, op] of Object.entries<any>(item)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(m)) ids.push(op.operationId);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('the paid routes require payment and the free one does not', () => {
    // The pricing story is part of the contract: a buying agent decides whether
    // to call us from this document, so a paid route advertised as free is a
    // promise we would have to break at the 402.
    const doc = JSON.parse(spec);
    const sec = (route: string, method = 'post') =>
      doc.paths[route]?.[method]?.security ?? doc.security;

    expect(JSON.stringify(sec('/api/verify'))).toContain('x402');
    expect(JSON.stringify(sec('/api/views'))).toContain('x402');
    expect(sec('/api/verify/preview', 'get')).toEqual([]);
  });

  test('the money-moving routes are documented as protected', () => {
    const doc = JSON.parse(spec);
    for (const route of ['/api/campaigns', '/api/tick']) {
      expect(doc.paths[route], `${route} should be documented`).toBeTruthy();
    }
  });
});
