/**
 * The HTTP gates, which nothing was testing.
 *
 * Changing which secret guards campaign creation — and which header carries
 * it — broke no test, because no test reached these handlers. That is the
 * shape of the gap: the engine behind them is covered by property tests and a
 * 600,000-decision simulation, and the doorway itself was taken on faith.
 *
 * The service is public by competition requirement, so these three handlers
 * are the entire boundary between the open internet and a system that pays
 * out money.
 */

import { describe, expect, test } from 'bun:test';

import { MemoryBlobStore } from './persistence';
import { CampaignRuntime } from './runtime';

const OPERATOR = 'operator-secret-value';
const TICK = 'tick-secret-value';

const runtime = (env: Record<string, string | undefined> = {}) =>
  new CampaignRuntime({ blobs: new MemoryBlobStore(), env });

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/campaigns', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const campaign = {
  brief: 'Clip the podcast and show the product in the first five seconds.',
  poolUsdc: '100',
  cpmUsdc: '1',
  perCreatorCapUsdc: '20',
};

describe('opening a campaign is gated, and fails closed', () => {
  test('no OPERATOR_SECRET configured means the endpoint is off, not open', () => {
    // An operator endpoint that is public because nobody set a variable is
    // worse than one that is switched off.
    return runtime({ TICK_SECRET: TICK }).handleOpenCampaign(post(campaign)).then((r) => {
      expect(r.status).toBe(503);
    });
  });

  test('no secret presented is refused', async () => {
    const r = await runtime({ OPERATOR_SECRET: OPERATOR }).handleOpenCampaign(post(campaign));
    expect(r.status).toBe(401);
  });

  test('a wrong secret is refused', async () => {
    const r = await runtime({ OPERATOR_SECRET: OPERATOR }).handleOpenCampaign(
      post(campaign, { 'x-operator-secret': 'wrong' }),
    );
    expect(r.status).toBe(401);
  });

  test('the TICK secret does NOT open a campaign', async () => {
    // The separation, as a test. Cloud Scheduler holds the tick secret: it
    // lives in a job definition, it was typed into a shell, and it rides on
    // every scheduled request. Whatever can trigger a tick must not be able to
    // commit money.
    const r = await runtime({ OPERATOR_SECRET: OPERATOR, TICK_SECRET: TICK }).handleOpenCampaign(
      post(campaign, { 'x-tick-secret': TICK }),
    );
    expect(r.status).toBe(401);
  });

  test('the operator secret opens a campaign', async () => {
    const r = await runtime({ OPERATOR_SECRET: OPERATOR }).handleOpenCampaign(
      post(campaign, { 'x-operator-secret': OPERATOR }),
    );
    expect(r.status).toBe(201); // Created, not OK — a campaign is a new resource
    expect((await r.json()).poolUsdc).toBe('100');
  });

  test('an authorised but invalid campaign is a 400, not a 500', async () => {
    const r = await runtime({ OPERATOR_SECRET: OPERATOR }).handleOpenCampaign(
      post({ ...campaign, dwellHours: 0 }, { 'x-operator-secret': OPERATOR }),
    );
    expect(r.status).toBe(400);
    expect((await r.json()).field).toBe('dwellHours');
  });

  test('a malformed body is refused rather than throwing', async () => {
    const bad = new Request('http://localhost/api/campaigns', {
      method: 'POST',
      headers: { 'x-operator-secret': OPERATOR },
      body: 'not json',
    });
    const r = await runtime({ OPERATOR_SECRET: OPERATOR }).handleOpenCampaign(bad);
    expect(r.status).toBe(400);
  });
});

describe('the tick is gated by its own secret', () => {
  const tickReq = (headers: Record<string, string> = {}) =>
    new Request('http://localhost/api/tick', { method: 'POST', headers });

  test('unconfigured returns 503 rather than running', async () => {
    expect((await runtime({}).handleTick(tickReq())).status).toBe(503);
  });

  test('a wrong secret is refused', async () => {
    const r = await runtime({ TICK_SECRET: TICK }).handleTick(tickReq({ 'x-tick-secret': 'no' }));
    expect(r.status).toBe(401);
  });

  test('the OPERATOR secret does not run a tick either — the split cuts both ways', async () => {
    const r = await runtime({ TICK_SECRET: TICK, OPERATOR_SECRET: OPERATOR }).handleTick(
      tickReq({ 'x-operator-secret': OPERATOR }),
    );
    expect(r.status).toBe(401);
  });

  test('the right secret runs it', async () => {
    const r = await runtime({ TICK_SECRET: TICK }).handleTick(tickReq({ 'x-tick-secret': TICK }));
    expect(r.status).toBe(200);
  });
});

describe('submitting stays public, because that is the point', () => {
  test('a creator needs no secret to be paid', async () => {
    const rt = runtime({ OPERATOR_SECRET: OPERATOR });
    const opened = await rt.handleOpenCampaign(post(campaign, { 'x-operator-secret': OPERATOR }));
    const { campaignId } = (await opened.json()) as { campaignId: string };

    const submit = new Request('http://localhost/api/submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        campaignId,
        payoutAddress: '0x' + 'a'.repeat(40),
        url: 'https://www.youtube.com/shorts/abc123XYZ_1',
      }),
    });
    const r = await rt.handleSubmit(submit);
    expect(r.status).toBe(201);
  });

  test('a submission naming an unknown campaign is refused, not invented', async () => {
    const submit = new Request('http://localhost/api/submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        campaignId: 'does-not-exist',
        payoutAddress: '0x' + 'a'.repeat(40),
        url: 'https://www.youtube.com/shorts/abc123XYZ_1',
      }),
    });
    const r = await runtime({}).handleSubmit(submit);
    expect(r.status).toBe(400);
  });
});
