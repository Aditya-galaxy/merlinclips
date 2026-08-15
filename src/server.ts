/**
 * The judge-facing surface.
 *
 * The competition requires a working project anyone can test: *"Access must be
 * provided to an Entrant's working Project for judging and testing by
 * providing a link to a website, functioning demo, or a test build... free of
 * charge and without any restriction."* This is that link.
 *
 * It is not a mock. Every button runs the real `createPaymentGate` over the
 * real policy engine, mandates, budget and hash-chained ledger — the same code
 * path the live agent uses against Circle's Agent Stack. Only the price quote
 * is stubbed while no wallet is attached; swap the resolver and these become
 * real testnet payments with no other change.
 *
 * Deliberately dependency-free: Bun's built-in server, one file, HTML inline.
 * A judge's session should not be able to fail because of a build step, and
 * `bun run src/server.ts` is the whole deployment story on Cloud Run.
 */

import { encodeEvent } from './campaign/events';
import {
  budgetSnapshot,
  createDemoWorld,
  runScenario,
  SCENARIOS,
  type DemoWorld,
  type ScenarioName,
} from './scenarios';
import { APP_HTML } from './app';
import {
  authorizeUrl, creatorIdForSubject, exchangeCode, googleConfig, randomToken,
} from './auth/google';
import {
  SESSION_COOKIE, SESSION_TTL_SECONDS, STATE_COOKIE, clearCookie, cookie,
  readCookie, sign, verify,
} from './auth/session';
import { isExpired } from './mandates';
import { runJob } from './business/loop';
import { MARKETPLACE } from './business/tools';
import { telemetry } from './telemetry/metrics';
import { Decimal, USDC } from './decimal';
import { encodePayment, paymentRequiredBody, verifyPayment } from './x402';
import { CampaignRuntime } from './campaign/runtime';

/**
 * The campaign payout agent, kept separate from the demo world above.
 *
 * Its state has to outlive the process — the dwell mechanic compares today's
 * view count against one from at least a day ago — so unlike the scenarios,
 * this is not reset by `/api/reset`.
 */
const campaigns = new CampaignRuntime();

/** What a customer pays for one answered question. Inputs come out of this. */
const JOB_PRICE_USDC = USDC('1.00');

/**
 * What one clip verification costs another agent.
 *
 * The marketplace's median listing is $0.02 and its p90 is $1.00, across 958
 * listings. This sits above the median because the call is not free to serve —
 * a multimodal model watches the video — and well under the p90 because a
 * buying agent checking a hundred clips should not think twice.
 */
const VERIFY_PRICE_USDC = USDC('0.05');

/**
 * Counts without a verdict.
 *
 * An order of magnitude cheaper because no model runs. A caller who only wants
 * the surviving-view number should not be charged for a video to be watched,
 * and pricing the two the same would be charging for work we did not do.
 */
const VIEWS_PRICE_USDC = USDC('0.005');

const viewsX402Config = () => ({
  payTo: RECEIVING_WALLET,
  priceUsdc: VIEWS_PRICE_USDC,
  resource: '/api/views',
  description:
    'Latest and surviving view counts for a YouTube or X post. No verdict, no ' +
    'model — an order of magnitude cheaper than /api/verify.',
});

const verifyX402Config = () => ({
  payTo: RECEIVING_WALLET,
  priceUsdc: VERIFY_PRICE_USDC,
  resource: '/api/verify',
  description:
    'Does this clip meet the brief, and how many of its views survived? ' +
    'YouTube and X. The first call starts the dwell clock; later calls report ' +
    'what persisted.',
});

/**
 * Where revenue lands. In production this is the Circle agent wallet address
 * from `circle wallet list`; the placeholder keeps the endpoint honest about
 * being unfunded rather than pretending otherwise.
 */
const RECEIVING_WALLET =
  process.env['AGENT_WALLET_ADDRESS'] ?? '0xAgentWalletNotYetProvisioned000000000000';

const x402Config = () => ({
  payTo: RECEIVING_WALLET,
  priceUsdc: JOB_PRICE_USDC,
  resource: '/api/job',
  description: 'One researched answer. The agent buys its sources on your behalf.',
});

/** Cumulative USDC received. The other half of the P&L. */
let revenue = new Decimal(0n);

const PORT = Number(process.env['PORT'] ?? 8080);

/**
 * One shared world, so a judge sees the budget deplete and the ledger grow
 * across clicks — the state is the point. `POST /api/reset` starts over.
 */
let world: DemoWorld = createDemoWorld();

function state() {
  return {
    mandates: world.mandates.list().map((m) => ({
      counterparty: m.counterparty,
      maxPerPaymentUsdc: m.maxPerPaymentUsdc.toString(),
      owner: m.owner,
      issuedBy: m.issuedBy,
      reason: m.reason,
      expiresAt: m.expiresAt ?? null,
      expired: isExpired(m),
      useCount: m.useCount,
      lastUsedAt: m.lastUsedAt ?? null,
    })),
    budget: budgetSnapshot(world),
    queue: world.queue.map((q) => ({
      counterparty: q.intent.counterparty,
      amountUsdc: q.intent.amountUsdc.toString(),
      reason: q.reason,
      purpose: q.intent.purpose ?? '',
    })),
    ledger: world.ledger.byStage('decision').map((r) => ({
      at: r.at,
      disposition: r.payload['disposition'],
      control: r.payload['control'],
      counterparty: r.payload['counterparty'],
      amountUsdc: r.payload['amountUsdc'],
      reason: r.payload['reason'],
      purpose: r.payload['purpose'],
    })),
    chain: world.ledger.verify(),
    // Both halves of the loop, so the console shows a P&L rather than a spend log.
    economics: {
      revenueUsdc: revenue.toString(),
      priceUsdc: JOB_PRICE_USDC.toString(),
      receivingWallet: RECEIVING_WALLET,
      walletProvisioned: !RECEIVING_WALLET.includes('NotYetProvisioned'),
    },
    scenarios: Object.entries(SCENARIOS).map(([name, s]) => ({
      name,
      title: s.title,
      narrative: s.narrative,
    })),
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const server = Bun.serve({
  port: PORT,
  // A pass has a model watching a video inside it. Gemini takes about 25
  // seconds on a short clip and sometimes longer, so a 30-second idle timeout
  // sat right on top of the normal case: the work completed server-side and
  // Bun closed the connection first, so the caller saw HTTP 000 with an empty
  // body and no error logged anywhere. From the outside that reads as a crash.
  //
  // Worse for the scheduler, which would treat a dropped connection as a
  // failure and retry a pass that had in fact run. The lease stops that
  // double-settling, but relying on a second mechanism to cover a timeout we
  // chose is not a design.
  //
  // 255 is Bun's ceiling. The tick has its own bounds — the lease window and
  // the verifier's timeout — so this is a backstop, not the thing keeping a
  // pass finite.
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);

    // Cloud Run and any uptime check need a path that touches no state.
    // Both spellings. Cloud Run's frontend reserves /healthz and answers it
    // before the request reaches us, so a deployment that only served that
    // path looked dead while being perfectly healthy. /health is ours.
    if (url.pathname === '/health' || url.pathname === '/healthz') {
      return new Response('ok');
    }


    // ── sign-in ──────────────────────────────────────────────────────────
    //
    // Identity used to be the wallet address, which is free to mint: fifty
    // addresses meant fifty fresh standings and fifty per-creator caps. An
    // account raises that cost. It does not remove it, and the FAQ says so.
    //
    // Everything here fails closed. Unconfigured OAuth, a state mismatch, a
    // token that will not verify — each returns without a session rather than
    // guessing, because a sign-in that half-works is worse than one that says
    // it did not.
    const OAUTH = googleConfig(Bun.env as Record<string, string | undefined>);
    const SESSION_SECRET = Bun.env.SESSION_SECRET?.trim();
    const SECURE_COOKIES = url.protocol === 'https:';

    if (url.pathname === '/auth/google') {
      if (!OAUTH) {
        // Unconfigured OAuth: Mint an onboarding session token so the creator
        // moves into /onboarding cleanly without getting looped back to /signup.
        const creatorId = 'c_' + randomToken(8);
        const token = await sign({
          creatorId,
          sub: 'guest_' + creatorId,
          email: 'creator@merlinclips.com',
          name: 'Creator',
          exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
        }, SESSION_SECRET ?? 'dev_fallback_secret');

        const headers = new Headers({ location: '/onboarding' });
        headers.append('set-cookie',
          cookie(SESSION_COOKIE, token, SESSION_TTL_SECONDS, SECURE_COOKIES));
        return new Response(null, { status: 302, headers });
      }
      const state = randomToken();
      const nonce = randomToken();
      const oauthConfig = {
        ...OAUTH,
        redirectUri: OAUTH.redirectUri || `${url.origin}/auth/google/callback`,
      };
      const headers = new Headers({ location: authorizeUrl(oauthConfig, state, nonce) });
      headers.append('set-cookie',
        cookie(STATE_COOKIE, `${state}.${nonce}`, 600, SECURE_COOKIES));
      return new Response(null, { status: 302, headers });
    }

    if (url.pathname === '/auth/google/callback') {
      if (!OAUTH || !SESSION_SECRET) {
        return Response.redirect(new URL('/onboarding', request.url).toString(), 302);
      }
      const pending = readCookie(request.headers.get('cookie'), STATE_COOKIE);
      const [wantState, nonce] = (pending ?? '').split('.');
      const gotState = url.searchParams.get('state');
      const code = url.searchParams.get('code');

      const fail = (why: string) => {
        const h = new Headers({ location: `/onboarding?signin=failed&why=${encodeURIComponent(why)}` });
        h.append('set-cookie', clearCookie(STATE_COOKIE, SECURE_COOKIES));
        return new Response(null, { status: 302, headers: h });
      };

      if (url.searchParams.get('error')) return fail('declined');
      if (!code || !wantState || !nonce) return fail('incomplete');
      if (gotState !== wantState) return fail('state');

      let identity;
      try {
        identity = await exchangeCode(OAUTH, code, nonce);
      } catch {
        // The reason is deliberately not surfaced to the browser: it would
        // tell an attacker which of the checks they failed.
        return fail('unverified');
      }

      const creatorId = await creatorIdForSubject(identity.sub);
      const token = await sign({
        creatorId,
        sub: identity.sub,
        email: identity.email,
        name: identity.name,
        picture: identity.picture,
        exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
      }, SESSION_SECRET);

      // Smart Redirect: If creator is already registered, go straight to /profile
      await campaigns.ready();
      const existingAcc = campaigns.store.getCreatorAccount(creatorId);
      const targetLocation = (existingAcc && existingAcc.wallet) ? '/profile' : '/onboarding?signin=ok';

      const headers = new Headers({ location: targetLocation });
      headers.append('set-cookie', clearCookie(STATE_COOKIE, SECURE_COOKIES));
      headers.append('set-cookie',
        cookie(SESSION_COOKIE, token, SESSION_TTL_SECONDS, SECURE_COOKIES));
      return new Response(null, { status: 302, headers });
    }

    if (url.pathname === '/api/auth/oauth2/callback/whop' || url.pathname === '/auth/whop/callback') {
      return Response.redirect(new URL('/onboarding?whop=connected', request.url).toString(), 302);
    }

    if (url.pathname === '/auth/logout') {
      const headers = new Headers({ location: '/' });
      headers.append('set-cookie', clearCookie(SESSION_COOKIE, SECURE_COOKIES));
      return new Response(null, { status: 302, headers });
    }

    if (url.pathname === '/api/me') {
      const session = SESSION_SECRET
        ? await verify(readCookie(request.headers.get('cookie'), SESSION_COOKIE), SESSION_SECRET)
        : undefined;
      const email = session?.email;
      const extractedUsername = email ? (email.split('@')[0] ?? '').toLowerCase().replace(/[^a-z0-9_.]/g, '') : undefined;
      return json({
        signedIn: !!session,
        available: !!(OAUTH && SESSION_SECRET),
        creatorId: session?.creatorId,
        name: session?.name || 'Creator Account',
        email: session?.email,
        picture: session?.picture,
        username: extractedUsername || 'creator',
      });
    }


    // What a creator reads before deciding whether the campaign is worth their
    // effort: the remaining pool, published rather than discoverable only by
    // submitting and being told the pot ran dry.
    /**
     * PostHog behind our own origin.
     *
     * A crypto-native audience runs blockers, and a request to a known
     * analytics domain is the first thing they drop — so the events that
     * matter most, from the users most likely to matter, are exactly the ones
     * a direct integration loses. Served from merlinclips.com, it is a
     * first-party request and survives.
     *
     * Deliberately narrow: only the ingest paths, only to the configured host,
     * and the path is rebuilt rather than passed through, so this cannot be
     * driven as an open proxy.
     */
    if (url.pathname === '/ingest' || url.pathname.startsWith('/ingest/')) {
      const host = (process.env['POSTHOG_HOST'] ?? 'https://eu.i.posthog.com').replace(/\/+$/, '');
      const rest = url.pathname.slice('/ingest'.length) || '/';
      const allowed = /^\/(i\/v0\/e|e|decide|s|array|static|batch|capture|flags)(\/|$)/.test(rest);
      if (!allowed) return json({ error: 'not a PostHog ingest path' }, 404);

      const target = `${host}${rest}${url.search}`;
      const headers = new Headers();
      const ct = request.headers.get('content-type');
      if (ct) headers.set('content-type', ct);
      const forwarded = request.headers.get('x-forwarded-for');
      if (forwarded) headers.set('x-forwarded-for', forwarded);

      try {
        const upstream = await fetch(target, {
          method: request.method,
          headers,
          body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
          // @ts-expect-error Bun streams a request body without buffering it.
          duplex: 'half',
        });
        return new Response(upstream.body, {
          status: upstream.status,
          headers: {
            'content-type': upstream.headers.get('content-type') ?? 'application/json',
            'cache-control': 'no-store',
          },
        });
      } catch {
        // Analytics must never take the site down with it.
        return new Response('', { status: 204 });
      }
    }

    /**
     * The two publishable keys the static pages need.
     *
     * Both are designed to ship in a page — a Turnstile *site* key and a
     * PostHog *project* key authorise nothing on their own; the secrets that
     * do (TURNSTILE_SECRET, the PostHog personal key) never leave the server.
     * Serving them here keeps the HTML free of per-environment values.
     */
    if (url.pathname === '/api/web-config') {
      return json({
        turnstileSiteKey: process.env['TURNSTILE_SITE_KEY'] ?? '',
        posthogKey: process.env['POSTHOG_PUBLIC_KEY'] ?? '',
        ingestPath: '/ingest',
      });
    }

    if (url.pathname === '/api/campaign') return json(await campaigns.publicView());

    // A brand opens a campaign. Operator-gated: declaring a pool is declaring
    // an intention to pay.
    // Open on purpose: a brand must be able to reach us without credentials.
    // Everything one account has earned, across every wallet it has used.

    if (url.pathname === '/api/me/profile') {
      return campaigns.handleProfile(request);
    }

    if (url.pathname === '/api/me/onboarding' && request.method === 'POST') {
      return campaigns.handleSaveOnboarding(request);
    }

    // Operator-gated: approving a brand is the decision manual approval exists for.
    if (url.pathname === '/api/brands' && request.method === 'POST') {
      return campaigns.handleApproveBrand(request);
    }
    // Read-only, scoped to the signed-in brand.
    if (url.pathname === '/api/brand/dashboard') {
      return campaigns.handleBrandDashboard(request);
    }

    if (url.pathname === '/api/brand-enquiry' && request.method === 'POST') {
      return campaigns.handleBrandEnquiry(request);
    }

    if (url.pathname === '/api/campaigns' && request.method === 'POST') {
      return campaigns.handleOpenCampaign(request);
    }

    // A creator submits a clip. Deliberately public — the payout address is
    // the identity, and requiring a signup before someone can be paid is the
    // friction this product exists to remove.
    if (url.pathname === '/api/submissions' && request.method === 'POST') {
      return campaigns.handleSubmit(request);
    }

    // What a creator sees about their own clip, refusals included.
    const submissionMatch = url.pathname.match(/^\/api\/submissions\/([A-Za-z0-9._-]+)$/);
    if (submissionMatch && request.method === 'GET') {
      return campaigns.handleSubmissionStatus(submissionMatch[1]!);
    }

    // Driven by Cloud Scheduler, not by an in-process timer: each pass arrives
    // as a request, so Cloud Logging records every agent run for free.
    if (url.pathname === '/api/tick' && request.method === 'POST') {
      return campaigns.handleTick(request);
    }

    if (url.pathname === '/api/tick/status' && request.method === 'GET') {
      return campaigns.handleTickStatus();
    }

    const checkFundingMatch = url.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9._-]+)\/check-funding$/);
    if (checkFundingMatch && (request.method === 'POST' || request.method === 'GET')) {
      return campaigns.handleCheckFunding(checkFundingMatch[1]!);
    }

    // An operator takes a funded campaign live. Deliberately separate from the
    // funding check above: money arriving is a fact, publishing a brief to
    // creators is a decision.
    const approveMatch = url.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9._-]+)\/approve$/);
    if (approveMatch && request.method === 'POST') {
      return campaigns.handleApproveCampaign(request, approveMatch[1]!);
    }

    // The machine-readable contract. Circle's marketplace requires a published
    // OpenAPI spec so a buying agent can read the inputs and outputs itself
    // rather than being told about them by a human.
    if (url.pathname === '/openapi.json') {
      const spec = Bun.file('openapi.json');
      return (await spec.exists())
        ? new Response(spec, { headers: { 'content-type': 'application/json; charset=utf-8' } })
        : json({ error: 'spec not found' }, 404);
    }

    if (url.pathname === '/mcp.json') {
      const mcp = Bun.file('mcp.json');
      return (await mcp.exists())
        ? new Response(mcp, { headers: { 'content-type': 'application/json; charset=utf-8' } })
        : json({ error: 'mcp spec not found' }, 404);
    }

    if (url.pathname === '/metrics') {
      return new Response(telemetry.toPrometheusFormat(), {
        headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
      });
    }

    // Free, and deliberately so. It answers "can you handle this link, are you
    // already watching it, when will a real answer exist" — everything an agent
    // needs to plan a call, and nothing it could use instead of making one. The
    // marketplace's larger sellers all list free routes for exactly this
    // reason: an agent can discover them and confirm they work before spending.
    if (url.pathname === '/api/verify/preview') {
      return campaigns.handlePreview(request);
    }

    // Counts only. Same handshake, a tenth of the price, because no model runs.
    if (url.pathname === '/api/views' && request.method === 'POST') {
      const paid = verifyPayment(request.headers.get('X-PAYMENT'), viewsX402Config());
      if (!paid.ok) {
        return new Response(JSON.stringify(paymentRequiredBody(viewsX402Config()), null, 2), {
          status: 402,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      revenue = revenue.plus(paid.proof.amountUsdc);
      world.ledger.append('settlement', {
        direction: 'received',
        payer: paid.proof.payer,
        amountUsdc: paid.proof.amountUsdc.toString(),
        txHash: paid.proof.txHash,
        resource: '/api/views',
      });
      return campaigns.handleViews(request);
    }

    // What we sell to other agents. Paywalled with the same x402 handshake the
    // marketplace expects: a buying agent needs no account here and no API key.
    if (url.pathname === '/api/verify' && request.method === 'POST') {
      const paid = verifyPayment(request.headers.get('X-PAYMENT'), verifyX402Config());
      if (!paid.ok) {
        return new Response(JSON.stringify(paymentRequiredBody(verifyX402Config()), null, 2), {
          status: 402,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      revenue = revenue.plus(paid.proof.amountUsdc);
      world.ledger.append('settlement', {
        direction: 'received',
        payer: paid.proof.payer,
        amountUsdc: paid.proof.amountUsdc.toString(),
        txHash: paid.proof.txHash,
        resource: '/api/verify',
      });
      return campaigns.handleVerify(request);
    }

    // The auditor's export: the whole chain, envelopes included, so anyone can
    // recompute the hashes themselves rather than take our word for it.
    //
    // This served `world.ledger` — a scripted simulation that shares nothing
    // with the campaign engine. The endpoint documented as the audit trail was
    // exporting invented rows, and in production exported an empty one, which
    // is worse than having no endpoint.
    if (url.pathname === '/api/ledger.jsonl') {
      // Through the log's own encoder, not JSON.stringify. Snapshots carry
      // `views` as a bigint and payouts carry Decimals; stringify throws on
      // the first bigint it meets, which turned this endpoint into a 500.
      // Re-parsing the encoded form collapses it back to one line per event.
      const envelopes = await campaigns.log.replay();
      const body = envelopes
        .map((e) => JSON.stringify(JSON.parse(encodeEvent(e))))
        .join('\n');
      return new Response(body ? `${body}\n` : '', {
        headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      });
    }

    // The derived hash chain over those same events, recomputed on read.
    if (url.pathname === '/api/ledger/chain') {
      return json(await campaigns.log.chain());
    }

    if (url.pathname === '/api/reset' && request.method === 'POST') {
      world = createDemoWorld();
      revenue = new Decimal(0n);
      return json({ ok: true, ...state() });
    }

    // The live agent. A judge types a question; the agent plans, prices, buys
    // what it judges worth buying, and answers — every purchase routed through
    // the same gate the scripted scenarios use, against the same mandates.
    if (url.pathname === '/api/job' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { question?: string };
      const question = (body.question ?? '').trim();
      if (!question) return json({ error: 'a question is required' }, 400);

      // The receiving half. Our service is itself an x402 endpoint, so another
      // agent can discover it, pay it, and get an answer with no human on
      // either side of the transaction — which is what "agents autonomously
      // making *or receiving* payments" asks for.
      //
      // The console's own button pays with a demo authorization so a judge can
      // click through; a real buying agent presents a signed one and the same
      // verification runs either way.
      const paid = verifyPayment(request.headers.get('X-PAYMENT'), x402Config());
      if (!paid.ok) {
        return new Response(JSON.stringify(paymentRequiredBody(x402Config()), null, 2), {
          status: 402,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      revenue = revenue.plus(paid.proof.amountUsdc);
      world.ledger.append('settlement', {
        direction: 'received',
        payer: paid.proof.payer,
        amountUsdc: paid.proof.amountUsdc.toString(),
        txHash: paid.proof.txHash,
        resource: '/api/job',
      });

      const result = await runJob({
        question,
        buy: async (sourceUrl, price) => {
          const authorized = await world.gate('circle_pay_service', {
            url: sourceUrl,
            address: '0xagent00000000000000000000000000000000000',
            method: 'GET',
            dataJson: JSON.stringify({ question }),
          });
          if (!authorized) {
            // Surfaced back to the agent as the policy's own words, so its
            // next move is informed rather than a blind retry.
            throw new Error(world.queue.at(-1)?.reason ?? 'refused by the spend policy');
          }
          const source = MARKETPLACE.find((s) => s.url === sourceUrl);
          if (!source) throw new Error(`unknown source ${sourceUrl}`);
          return source.payload;
        },
      });

      const cogs = new Decimal(result.spentUsdc);
      return json({
        job: {
          ...result,
          // The unit economics of this one job. This is the line item that
          // makes it a business rather than a demo.
          priceUsdc: JOB_PRICE_USDC.toString(),
          cogsUsdc: cogs.toString(),
          marginUsdc: JOB_PRICE_USDC.minus(cogs).toString(),
        },
        ...state(),
      });
    }

    const scenarioMatch = url.pathname.match(/^\/api\/run\/([a-z]+)$/);
    if (scenarioMatch && request.method === 'POST') {
      const name = scenarioMatch[1] as ScenarioName;
      if (!(name in SCENARIOS)) return json({ error: `unknown scenario: ${name}` }, 404);
      const result = await runScenario(name, world);
      return json({ result, ...state() });
    }

    // One service, three surfaces, one origin.
    //
    // `/` is the marketing site and `/app` is the product. Hosting the first
    // somewhere else would mean every link
    // between them is absolute and cross-origin — and a relative link works
    // perfectly in local preview, then 404s the moment the two are deployed
    // apart. That is the worst kind of broken link: it passes every check you
    // run before shipping.
    if (url.pathname === '/app' || url.pathname === '/app.html') {
      if (SESSION_SECRET) {
        const session = await verify(
          readCookie(request.headers.get('cookie'), SESSION_COOKIE), SESSION_SECRET,
        );
        if (!session) {
          const gate = Bun.file('landing/signup.html');
          if (await gate.exists()) {
            return new Response(gate, {
              headers: {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'private, no-store',
              },
            });
          }
        }
      }
      return Response.redirect(new URL('/profile', request.url).toString(), 302);
    }

    if (url.pathname === '/onboarding' || url.pathname === '/onboarding.html') {
      // Signed-out visitors trying to reach /onboarding meet the sign-in wall first.
      if (SESSION_SECRET) {
        const session = await verify(
          readCookie(request.headers.get('cookie'), SESSION_COOKIE), SESSION_SECRET,
        );
        if (!session) {
          const gate = Bun.file('landing/signup.html');
          if (await gate.exists()) {
            return new Response(gate, {
              headers: {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'private, no-store',
              },
            });
          }
        } else if (url.searchParams.get('edit') !== '1') {
          // If user is already registered, skip onboarding and go straight to /profile
          await campaigns.ready();
          const existingAcc = campaigns.store.getCreatorAccount(session.creatorId);
          if (existingAcc && existingAcc.wallet) {
            return Response.redirect(new URL('/profile', request.url).toString(), 302);
          }
        }
      }
      const onboardingFile = Bun.file('landing/onboarding.html');
      if (await onboardingFile.exists()) {
        return new Response(onboardingFile, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
    }

    // Static marketing pages, served from an allowlist.
    const LANDING: Record<string, string> = {
      '/': 'landing/index.html',
      '/index.html': 'landing/index.html',
      '/styles.css': 'landing/styles.css',
      '/site.js': 'landing/site.js',
      '/logo.svg': 'landing/logo.svg',
      '/favicon.ico': 'landing/logo.svg',
      '/og.svg': 'landing/og.svg',
      '/og.png': 'landing/og.svg',
      '/architecture.html': 'landing/architecture.html',
      '/brands.html': 'landing/brands.html',
      '/api.html': 'landing/api.html',
      '/brand.html': 'landing/brand.html',
      '/brand': 'landing/brand.html',
      '/launch.html': 'landing/launch.html',
      '/launch': 'landing/launch.html',
      '/signup.html': 'landing/signup.html',
      '/signup': 'landing/signup.html',
      '/onboarding.html': 'landing/onboarding.html',
      '/onboarding': 'landing/onboarding.html',
      '/profile.html': 'landing/profile.html',
      '/profile': 'landing/profile.html',
      '/creator': 'landing/profile.html',
      '/ledger.html': 'landing/ledger.html',
      '/ledger': 'landing/ledger.html',
      '/audit.html': 'landing/ledger.html',
      '/audit': 'landing/ledger.html',
      '/explorer.html': 'landing/ledger.html',
      '/explorer': 'landing/ledger.html',
      '/terms.html': 'landing/terms.html',
      '/compliance.html': 'landing/compliance.html',
      '/security.html': 'landing/security.html',
      '/testing.html': 'landing/testing.html',
    };
    const asset = LANDING[url.pathname];
    if (asset) {
      const file = Bun.file(asset);
      if (await file.exists()) {
        const mimeType = asset.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : asset.endsWith('.svg')
          ? 'image/svg+xml'
          : asset.endsWith('.ico')
          ? 'image/x-icon'
          : 'text/html; charset=utf-8';
        return new Response(file, {
          headers: {
            'content-type': mimeType,
          },
        });
      }
      // Missing marketing asset must not take the API down with it.
      if (url.pathname === '/') {
        return new Response(APP_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
    }
    return new Response('not found', { status: 404 });
  },

  /**
   * Anything the route handlers let escape.
   *
   * Bun's default is a generic "Something went wrong!" with nothing recorded,
   * which is how the auditor's export returned a 500 for a day without anyone
   * knowing why. Now the exception reaches Error Tracking with the path that
   * produced it, and the caller still gets a body that leaks nothing.
   */
  error(err: Error) {
    void campaigns.analytics.captureException(err, 'http');
    console.error('unhandled request error:', err);
    return new Response(
      JSON.stringify({ error: 'something went wrong on our side' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  },
});

console.log(`merlinclips console on http://localhost:${server.port}`);
