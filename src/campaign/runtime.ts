/**
 * The campaign agent as a long-lived service.
 *
 * Holds the store, the gate and the storage choice, so the HTTP layer stays a
 * router and nothing about scheduling leaks into the payout logic.
 *
 * **The tick endpoint is authenticated even though the service is not.** The
 * competition requires the deployment be reachable "free of charge and without
 * any restriction", so the console is deliberately public — but a public
 * endpoint that disburses USDC on request is an invitation, and rate limiting
 * would only slow it down. Cloud Scheduler sends a shared secret; nothing else
 * can start a pass.
 *
 * If no secret is configured the endpoint refuses to run at all rather than
 * running open. An unconfigured deployment that quietly accepts anonymous
 * payout triggers is a worse outcome than one that visibly does not tick.
 */

import { RollingWindowBudget } from '../budget';
import { Decimal } from '../decimal';
import { MandateStore } from '../mandates';
import { PaymentPolicyEngine } from '../policy';
import { PayoutGate } from './payout';
import {
  FileBlobStore,
  GcsBlobStore,
  MemoryBlobStore,
  type BlobStore,
} from './persistence';
import { EventLog } from './eventlog';
import { MultiAgentClusterManager } from './cluster';
import { CampaignStore } from './store';
import { apply as applyEvent } from './eventlog';
import { MemoryTrackingStore, previewClip, verifyClip } from './verify';
import type { ClipVerifier, CountOracle } from './verify';
import { CircleCliExecutor } from './executor';
import { webhookFromEnv } from '../telemetry/webhooks';
import { openCampaign, submitClip } from './intake';
import { standingFor, type Standing } from './standing';
import { SESSION_COOKIE as SESSION_COOKIE_NAME, readCookie as readSessionCookie,
  verify as verifySession } from '../auth/session';
import { fundingFor, type BalanceReader } from './funding';
import { RpcBalanceReader } from './balances';
import { enquiryKey, parseEnquiry } from './enquiry';
import { meets } from './eligibility';
import { creatorIdsFor, linkWallet, walletsFor } from './accounts';
import { approveBrand, brandFor } from './brands';
import { oracleFromEnv } from './oracle';
import { verifierFromEnv } from './verifier';
import { agentFromEnv, type FraudInvestigator, type RateProposer } from './agent';
import { acquireTickLease, DEFAULT_LEASE_WINDOW_MS } from './lease';
import { DryRunExecutor, runTick, skippedTick, type PayoutExecutor, type TickResult, type ViewOracle } from './tick';
import { ReservationEngine } from './reservation';
import { CampaignLockManager } from './lock';
import { TokenBucketRateLimiter } from '../rate_limiter';
import { telemetry } from '../telemetry/metrics';

/** No oracle configured yet: report "cannot tell", never a fabricated count. */
export const NULL_ORACLE: ViewOracle = { fetch: async () => undefined };

/** Where the last pass's summary lives. Outside the event log on purpose. */
const LAST_TICK_KEY = 'tick/last';

/** The display summary as stored — money already stringified. */
interface PersistedTick {
  readonly startedAt: string;
  readonly paid: number;
  readonly held: number;
  readonly blocked: number;
  readonly needsApproval: number;
  readonly totalPaidUsdc: string;
  readonly errors: readonly string[];
}

export function chooseBlobStore(env: Record<string, string | undefined> = Bun.env): BlobStore {
  if (env.GCS_BUCKET) return new GcsBlobStore(env.GCS_BUCKET);
  if (env.STATE_DIR) return new FileBlobStore(env.STATE_DIR);
  // Explicitly ephemeral. Fine for tests; on Cloud Run it means the dwell
  // window can never be satisfied, which `/api/campaign` reports rather than
  // hides.
  return new MemoryBlobStore();
}

/**
 * Compare without leaking length or position through timing.
 *
 * The payoff is small — an attacker guessing a secret over the internet has
 * bigger problems than timing — but the cost is four lines.
 */
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export interface CampaignRuntimeOptions {
  blobs?: BlobStore;
  counts?: CountOracle;
  verifier?: ClipVerifier;
  oracle?: ViewOracle;
  executor?: PayoutExecutor;
  mandates?: MandateStore;
  webhooks?: import('../telemetry/webhooks').WebhookNotifier;
  /** Injectable so a test can run the loop without a network. */
  agent?: { rate?: RateProposer; investigator?: FraudInvestigator };
  /** Lease window. Two passes inside one window: the second is refused. */
  leaseWindowMs?: number;
  env?: Record<string, string | undefined>;
}

export class CampaignRuntime {
  readonly store = new CampaignStore();
  readonly gate: PayoutGate;
  readonly mandates: MandateStore;
  public readonly webhooks: import('../telemetry/webhooks').WebhookNotifier;
  private readonly blobs: BlobStore;
  private readonly log: EventLog;
  private readonly oracle: ViewOracle;
  private readonly executor: PayoutExecutor;
  private readonly env: Record<string, string | undefined>;
  /** History for the public verification service, separate from campaigns. */
  private readonly tracking = new MemoryTrackingStore();
  private readonly counts?: CountOracle;
  private readonly verifier?: ClipVerifier;
  /** Empty without credentials, and empty is a working configuration: the
   *  tick stays purely deterministic rather than falling back to a stub. */
  private readonly agent: { rate?: RateProposer; investigator?: FraudInvestigator };
  private loaded = false;
  private readyPromise?: Promise<void>;
  private lastTick?: TickResult;

  /**
   * Reads on-chain USDC so a published budget can be checked against money
   * that exists. Absent in tests and offline, where funding reports `unknown`
   * rather than pretending a campaign is empty.
   *
   * Defaulted rather than left optional-and-unset. As an unassigned field it
   * was indistinguishable from a deployment that had chosen not to configure
   * one, so every campaign published "Budget not checked on this deployment"
   * and nobody could tell that no deployment could ever have checked it.
   * Opt out with CAMPAIGN_BALANCE_READER=off.
   */
  public balances?: BalanceReader =
    Bun.env.CAMPAIGN_BALANCE_READER === 'off' ? undefined : new RpcBalanceReader();

  /** Two-phase budget reservation engine for enterprise campaign payouts. */
  public readonly reservations = new ReservationEngine();
  /** Per-campaign distributed lock manager for mutual exclusion. */
  public readonly locks = new CampaignLockManager();
  /** Hierarchical multi-agent cluster manager & Safe Treasury splitter. */
  public readonly cluster = new MultiAgentClusterManager();
  /** Token bucket rate limiter for public API doors. */
  public readonly rateLimiter = new TokenBucketRateLimiter({ capacity: 60, refillRate: 10 });

  constructor(options: CampaignRuntimeOptions = {}) {
    this.env = options.env ?? Bun.env;
    this.webhooks = options.webhooks ?? webhookFromEnv(this.env);
    this.blobs = options.blobs ?? chooseBlobStore(this.env);
    this.log = new EventLog(this.blobs);
    // The tick's view source is the same YouTube oracle the paid endpoint
    // uses; NULL_ORACLE only when no key is configured.
    this.oracle = options.oracle ?? oracleFromEnv(this.env) ?? NULL_ORACLE;
    // With a wallet configured, settlement goes through the real CLI — in
    // estimate mode unless mainnet is explicitly armed, so the path is
    // exercised end to end before it can move anything.
    //
    // The wallet is chosen *by* the network rather than configured beside it.
    // A Circle agent wallet exists on one network: the testnet wallet cannot
    // send on BASE and the mainnet wallet cannot send on BASE-SEPOLIA. Two
    // independent settings would make the dangerous mistake expressible —
    // arming mainnet while still pointing at the testnet wallet, or the
    // reverse — and neither fails in an obvious way. Selecting one from the
    // other means the mismatch cannot be configured at all.
    this.executor = options.executor ?? this.buildExecutor();
    this.mandates = options.mandates ?? new MandateStore();
    // Real when the keys are present, absent otherwise — never a stub that
    // answers zero or always passes. Every consumer reports the absence.
    this.counts = options.counts ?? oracleFromEnv(this.env);
    this.verifier = options.verifier ?? verifierFromEnv(this.env);
    this.agent = options.agent ?? agentFromEnv(this.env);
    this.leaseWindowMs =
      options.leaseWindowMs ??
      (this.env.LEASE_WINDOW_MS ? Number(this.env.LEASE_WINDOW_MS) : DEFAULT_LEASE_WINDOW_MS);

    this.gate = new PayoutGate(
      this.store,
      new PaymentPolicyEngine(
        {
          dryRun: this.env.ALLOW_MAINNET !== 'true',
          killSwitch: this.env.KILL_SWITCH === 'true',
          absoluteMaxPerPaymentUsdc: new Decimal(this.env.MAX_PER_PAYMENT_USDC ?? '5.00'),
          allowMainnet: this.env.ALLOW_MAINNET === 'true',
        },
        this.mandates,
        new RollingWindowBudget({ defaultCapUsdc: this.env.WINDOW_BUDGET_USDC ?? '25.00' }),
      ),
    );
  }

  /**
   * The executor, with the sending wallet chosen by the network.
   *
   * Two separate flags, because they are two separate questions and the old
   * single flag conflated them. `ALLOW_MAINNET` answers *which network is this
   * deployment on* — it selects the wallet and unlocks mainnet chains in the
   * policy engine. `BROADCAST` answers *should a decision actually move money*
   * — without it the CLI runs with `--estimate`, exercising the real wallet
   * and the real chain but stopping short of broadcasting.
   *
   * Conflated, the only way to broadcast a testnet payout was to set the flag
   * that also unlocked mainnet. Separated, testnet can settle for real while
   * mainnet stays refused, which is the combination we actually want.
   *
   * Fails closed at construction rather than at the first payout, because the
   * first payout is the one carrying money.
   */
  private buildExecutor(): PayoutExecutor {
    const onMainnet = this.env.ALLOW_MAINNET === 'true';

    // Circle's Agent Stack, which is what this settles through: the wallet
    // below is an agent wallet created by `circle wallet login`, and the CLI
    // is the Agent Stack component that moves USDC out of it.
    const wallet = (
      onMainnet ? this.env.MAINNET_CAMPAIGN_WALLET : this.env.CAMPAIGN_WALLET
    )?.trim();

    if (onMainnet && !wallet) {
      throw new Error(
        'ALLOW_MAINNET=true but MAINNET_CAMPAIGN_WALLET is unset. Refusing to start: ' +
          'settling on mainnet from the testnet wallet is not a recoverable mistake.',
      );
    }
    if (!wallet) return new DryRunExecutor();

    return new CircleCliExecutor({
      fromAddress: wallet,
      dryRun: this.env.BROADCAST !== 'true',
      // The runtime's own env, not the process's. Without this the executor
      // read `Bun.env` for its broadcast gate while the runtime read the
      // injected object for everything else — so a runtime told BROADCAST=true
      // would still have estimated, and a test could not express the case at
      // all. Two sources of truth for one decision is one too many.
      env: this.env as Record<string, string | undefined>,
    });
  }

  /** Replay the log into the store. Idempotent, so every route may call it. */
  async ready(): Promise<void> {
    if (this.loaded) return;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.log.hydrate(this.store).then(() => {
      this.loaded = true;
    }).finally(() => {
      this.readyPromise = undefined;
    });
    return this.readyPromise;
  }

  /**
   * Record a fact and apply it.
   *
   * The only supported way to change campaign state: the log is the source of
   * truth, and an in-memory mutation nobody wrote down dies with the instance.
   */
  async record(event: Parameters<EventLog['append']>[0], at: Date = new Date()): Promise<boolean> {
    const written = await this.log.append(event, at);
    if (written) applyEvent(this.store, event);
    return written;
  }

  /** The chain, recomputed from the events. Anyone can check this. */
  async chain() {
    return this.log.chain();
  }

  /**
   * One pass, and never two at once in this process.
   *
   * `/api/tick` is an HTTP endpoint driven by Cloud Scheduler, which retries.
   * A retry arriving while the first pass is still working — or a human
   * curling it impatiently — starts a second pass that reads the same
   * `viewsPaidTo` and calls the executor for payouts the first pass has
   * already sent. The ledger no longer double-counts those, but the send
   * itself still happens, and the only thing preventing real duplicate money
   * at that point is Circle's idempotency key.
   *
   * That key does work — a replay returns the same transaction hash — but
   * "we called the payments API twice and something downstream saved us" is a
   * poor place for the guarantee to live. Overlapping callers share the
   * in-flight pass instead, so each caller gets the same honest result and
   * the executor is called once.
   *
   * This is per-instance. Two Cloud Run instances ticking simultaneously
   * still reach the executor twice, and there the idempotency key genuinely
   * is the defence. Bounding it properly needs a lease in the blob store,
   * which is worth doing before this runs at more than demo scale.
   */
  async tick(now?: Date): Promise<TickResult> {
    if (this.inFlightTick) return this.inFlightTick;
    this.inFlightTick = this.runOneTick(now).finally(() => {
      this.inFlightTick = undefined;
    });
    return this.inFlightTick;
  }

  private inFlightTick?: Promise<TickResult>;
  private readonly leaseWindowMs: number;

  private async runOneTick(now?: Date): Promise<TickResult> {
    const at = now ?? new Date();

    // Across instances, not just within one. Claimed before `ready()` so a
    // losing instance does no work at all, not merely no settlement.
    const lease = await acquireTickLease(this.blobs, {
      now: at,
      windowMs: this.leaseWindowMs,
      holder: this.env.AGENT_ID ?? 'campaign-agent',
    });
    if (!lease.acquired) {
      this.lastTick = skippedTick(at, lease.reason ?? 'lease not acquired');
      webhookFromEnv(this.env).alert({
        event: 'lease_contention',
        title: 'Tick Pass Skipped (Lease Contention)',
        message: lease.reason ?? 'Another instance holds the tick lease lock.',
        details: { holder: this.env.AGENT_ID ?? 'campaign-agent', windowMs: this.leaseWindowMs },
      });
      return this.lastTick;
    }

    await this.ready();
    this.lastTick = await runTick(
      {
        store: this.store,
        gate: this.gate,
        oracle: this.oracle,
        executor: this.executor,
        log: this.log,
        agent: this.agent,
        verifier: this.verifier,
      },
      { agentId: this.env.AGENT_ID ?? 'campaign-agent', now: at },
    );
    await this.rememberLastTick(this.lastTick);

    // Check for payout failures or depleted campaigns and alert
    const notifier = webhookFromEnv(this.env);
    if (notifier.isConfigured) {
      for (const d of this.lastTick.decisions) {
        if (d.disposition === 'blocked' && d.reason.includes('failed')) {
          notifier.alert({
            event: 'payout_failed',
            title: 'Payout Execution Failed',
            message: `Submission ${d.submissionId} failed settlement: ${d.reason}`,
            details: { submissionId: d.submissionId, campaignId: d.campaignId, reason: d.reason },
          });
        }
      }

      for (const c of this.store.exportState().campaigns) {
        const remaining = c.poolUsdc.minus(this.store.spentOnCampaign(c.campaignId));
        if (remaining.micro <= 0n) {
          notifier.alert({
            event: 'campaign_depleted',
            title: 'Campaign Budget Depleted',
            message: `Campaign ${c.campaignId} ("${c.brief.slice(0, 40)}...") budget is fully exhausted.`,
            details: { campaignId: c.campaignId, poolUsdc: c.poolUsdc.toString() },
          });
        }
      }
    }

    return this.lastTick;
  }

  /**
   * When the last pass ran, durably.
   *
   * `lastTick` was a private field and nothing else. The scheduler's pass ran
   * on one instance, set it in that instance's memory, and the instance
   * scaled away; the next request reached a cold one and the console reported
   * that nothing had ever run. The pass had run every hour for hours.
   *
   * Its own blob key, deliberately not an event. The log is the record of
   * money moving, and a hash chain over payouts is worth exactly as much as
   * the discipline about what is allowed into it — "when did the pass last
   * run" is a fact about the operator's dashboard, not about anyone's money.
   *
   * A failed write is swallowed. Losing the display of a tick is a smaller
   * harm than failing a pass that has already settled real payouts, and by
   * this point it has.
   */
  private async rememberLastTick(result: TickResult): Promise<void> {
    try {
      await this.blobs.put(LAST_TICK_KEY, JSON.stringify({
        startedAt: result.startedAt,
        paid: result.paid,
        held: result.held,
        blocked: result.blocked,
        needsApproval: result.needsApproval,
        totalPaidUsdc: result.totalPaidUsdc.toString(),
        errors: result.errors,
      }));
    } catch {
      /* display only — never fail a settled pass over it */
    }
  }

  /** The stored summary, for an instance that has not ticked itself. */
  private async recallLastTick(): Promise<PersistedTick | undefined> {
    try {
      const raw = await this.blobs.get(LAST_TICK_KEY);
      if (!raw) return undefined;
      const v = JSON.parse(raw) as PersistedTick;
      return typeof v?.startedAt === 'string' ? v : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * What a creator sees before deciding whether to invest the effort.
   *
   * Publishing the remaining pool is the point: the loudest complaint in this
   * market is doing real work against a budget that had already emptied, and
   * a visible pot is the one thing a fiat rail structurally cannot offer.
   */
  async publicView() {
    await this.ready();
    const state = this.store.exportState();
    return {
      persistence: this.blobs.constructor.name,
      ephemeral: this.blobs instanceof MemoryBlobStore,
      // Stated rather than discovered: a campaign with no verifier holds every
      // clip on `no_verdict`, and one with no oracle never confirms a view.
      verifier: this.verifier ? 'gemini' : 'not configured (set GOOGLE_GENAI_USE_VERTEXAI + GOOGLE_CLOUD_PROJECT, or GOOGLE_API_KEY)',
      viewOracle: this.counts ? 'youtube' : 'not configured (YOUTUBE_API_KEY)',
      campaigns: await Promise.all(state.campaigns.map(async (c) => {
        // What a creator wants before committing an evening: is anyone else
        // here, is this campaign actually paying, and how much is left. All
        // three are already in the store; publishing them is what turns a
        // listing into something someone can judge.
        const subs = state.submissions.filter((s) => s.campaignId === c.campaignId);
        const creators = new Set(subs.map((s) => s.creatorId));
        let views = 0n;
        for (const s of subs) views += this.store.viewsPaidTo(s.submissionId);
        const spent = this.store.spentOnCampaign(c.campaignId);
        return {
          campaignId: c.campaignId,
          brief: c.brief,
          status: c.status,
          cpmUsdc: c.cpmUsdc.toString(),
          poolUsdc: c.poolUsdc.toString(),
          spentUsdc: spent.toString(),
          remainingUsdc: this.store.remainingPool(c.campaignId).toString(),
          perCreatorCapUsdc: c.perCreatorCapUsdc.toString(),
          dwellHours: Math.round(c.dwellMs / 3_600_000),
          platforms: c.platforms,
          startsAt: c.startsAt,
          endsAt: c.endsAt,
          submissions: subs.length,
          creators: creators.size,
          paidViews: views.toString(),
          paidOut: this.store.payoutsFor(c.campaignId).length,
          // What actually backs the budget. A creator decides whether to spend
          // an evening on this number, so it is checked rather than asserted.
          funding: this.balances
            ? await fundingFor(c, spent, this.balances)
            : {
                campaignId: c.campaignId,
                fundedUsdc: null,
                poolUsdc: c.poolUsdc.toString(),
                committedUsdc: spent.toString(),
                coverage: c.fundingWallet ? ('unknown' as const) : ('no_wallet' as const),
                summary: c.fundingWallet
                  ? 'Budget not checked on this deployment.'
                  : 'This campaign has not named a wallet, so nothing backs its budget yet.',
              },
        };
      })),
      // This instance's own pass if it ran one, otherwise whichever instance
      // last did. Without the fallback a cold instance reports null and the
      // console says nothing has ever run.
      lastTick: (this.lastTick && {
        startedAt: this.lastTick.startedAt,
        paid: this.lastTick.paid,
        held: this.lastTick.held,
        blocked: this.lastTick.blocked,
        needsApproval: this.lastTick.needsApproval,
        totalPaidUsdc: this.lastTick.totalPaidUsdc.toString(),
        errors: this.lastTick.errors,
      }) ?? (await this.recallLastTick()),
    };
  }

  /**
   * Free. Can we handle this link, are we already watching it, and when will a
   * real answer exist? No platform call and no model, so it costs us nothing —
   * and it deliberately omits the numbers, which are the thing being sold.
   */
  async handlePreview(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const target =
      url.searchParams.get('url') ??
      ((await request.json().catch(() => ({}))) as { url?: string }).url;
    if (!target) return Response.json({ error: 'url is required' }, { status: 400 });
    const dwell = Number(url.searchParams.get('dwellHours'));
    return Response.json(
      previewClip(
        { url: target, dwellHours: Number.isFinite(dwell) && dwell > 0 ? dwell : undefined },
        { tracking: this.tracking },
      ),
    );
  }

  /**
   * Counts only: latest and surviving views, no verdict.
   *
   * Priced well below `/api/verify` because no model runs. A caller who only
   * wants the surviving number should not pay for a video to be watched.
   */
  async handleViews(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      url?: string;
      brief?: string;
      dwellHours?: number;
    };
    if (!body.url) return Response.json({ error: 'url is required' }, { status: 400 });
    const result = await verifyClip(
      { url: body.url, dwellHours: body.dwellHours },
      { tracking: this.tracking, oracle: this.counts },
    );
    // Say so rather than silently dropping it — the caller paid the cheaper
    // price and would otherwise wonder where their verdict went.
    if (body.brief) {
      result.errors.push(
        'a brief was supplied but /api/views does not judge it — no model runs at ' +
          'this price. Use /api/verify for a verdict.',
      );
    }
    return Response.json(result);
  }

  /**
   * The service we sell to other agents: does this clip qualify, and how many
   * of its views survived?
   *
   * Payment is checked by the caller (`server.ts`) via x402 before this runs —
   * the same 402 handshake Circle's marketplace expects, so a buying agent
   * needs no account with us and no API key.
   */
  async handleVerify(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      url?: string;
      brief?: string;
      dwellHours?: number;
    };
    if (!body.url) {
      return Response.json({ error: 'url is required' }, { status: 400 });
    }
    const result = await verifyClip(
      { url: body.url, brief: body.brief, dwellHours: body.dwellHours },
      { tracking: this.tracking, oracle: this.counts, verifier: this.verifier },
    );
    return Response.json(result);
  }

  /**
   * `POST /api/campaigns` — a brand opens a campaign.
   *
   * Operator-gated with the same secret as the tick, because declaring a pool
   * is declaring an intention to pay. Anyone who can call this can commit the
   * operator's money.
   */
  /**
   * A brand asking whether this is real.
   *
   * Open, unlike campaign creation. The point is that a brand can reach us
   * without credentials — gating the first conversation behind an operator
   * secret is how you end up with no conversations.
   *
   * That openness is why it is rate limited on the same limiter as
   * submissions, and why every field is validated here rather than trusted
   * from the form.
   */
  /**
   * A creator's record, and how many places on this campaign have already gone
   * to creators without one.
   *
   * Counted from accepted submissions rather than tracked as a running total:
   * a counter is a thing that drifts, and the submissions are already the
   * record of what was accepted.
   */
  /**
   * A creator's record, and how many places on this campaign have already gone
   * to creators without one.
   *
   * Counted from accepted submissions rather than kept as a running total: a
   * counter is a thing that drifts, and the submissions already are the record
   * of what was accepted.
   */
  private eligibilityFor(creatorId: string, campaignId: string): {
    standing: Standing; acceptedBelowFloor: number;
  } {
    const state = this.store.exportState();
    const mine = state.submissions.filter((x) => x.creatorId === creatorId);
    const standing = standingFor(creatorId, mine, this.store).standing;

    const floor = this.store.campaign(campaignId)?.minStanding;
    if (!floor) return { standing, acceptedBelowFloor: 0 };

    // One creator occupies one place however many clips they sent.
    const below = new Set<string>();
    for (const sub of state.submissions) {
      if (sub.campaignId !== campaignId) continue;
      if (below.has(sub.creatorId)) continue;
      const theirs = state.submissions.filter((x) => x.creatorId === sub.creatorId);
      if (!meets(standingFor(sub.creatorId, theirs, this.store).standing, floor)) {
        below.add(sub.creatorId);
      }
    }
    return { standing, acceptedBelowFloor: below.size };
  }

  /** The signed-in account, or undefined. Never trusted from the body. */
  /** The signed-in email, which is what a brand account is keyed by. */
  private async emailFor(request: Request): Promise<string | undefined> {
    const secret = this.env.SESSION_SECRET?.trim();
    if (!secret) return undefined;
    const session = await verifySession(
      readSessionCookie(request.headers.get('cookie'), SESSION_COOKIE_NAME), secret,
    );
    return session?.email;
  }

  private async accountFor(request: Request): Promise<string | undefined> {
    const secret = this.env.SESSION_SECRET?.trim();
    if (!secret) return undefined;
    const session = await verifySession(
      readSessionCookie(request.headers.get('cookie'), SESSION_COOKIE_NAME), secret,
    );
    return session?.creatorId;
  }

  /**
   * Everything an account has earned, across every wallet it has used.
   *
   * Aggregated on read rather than kept as a stored summary. A stored total is
   * a number that can disagree with the payouts it claims to add up, and the
   * payouts are the record a creator would dispute against.
   */
  async handleProfile(request: Request): Promise<Response> {
    const accountId = await this.accountFor(request);
    if (!accountId) {
      return Response.json({ error: 'not signed in' }, { status: 401 });
    }
    await this.ready();

    const acc = this.store.getCreatorAccount(accountId);
    const wallets = acc ? walletsFor(acc) : [];
    const ids = new Set(wallets);
    const state = this.store.exportState();
    const mine = state.submissions.filter((x) => ids.has(x.creatorId));

    let earnedMicro = 0n;
    let viewsPaid = 0n;
    const payouts = [];
    for (const p of state.payouts) {
      if (!ids.has(p.creatorId)) continue;
      earnedMicro += p.amountUsdc.micro;
      viewsPaid += p.viewsPaidTo;
      payouts.push({
        submissionId: p.submissionId,
        campaignId: p.campaignId,
        amountUsdc: p.amountUsdc.toString(),
        viewsPaidTo: p.viewsPaidTo.toString(),
        settledAt: p.at,
        txHash: p.txHash,
      });
    }

    const record = standingFor(accountId, mine, this.store);

    return Response.json({
      accountId,
      wallets,
      standing: {
        level: record.standing,
        survivalRate: record.survivalRate,
        clipsJudged: record.judged,
        says: record.summary,
      },
      totals: {
        earnedUsdc: (Number(earnedMicro) / 1_000_000).toFixed(6),
        viewsPaid: viewsPaid.toString(),
        submissions: mine.length,
        payouts: payouts.length,
      },
      submissions: mine.map((x) => ({
        submissionId: x.submissionId,
        campaignId: x.campaignId,
        url: x.url,
        submittedAt: x.submittedAt,
        cpmUsdc: x.acceptedTerms.cpmUsdc.toString(),
        dwellHours: Math.round(x.acceptedTerms.dwellMs / 3_600_000),
      })),
      payouts,
    });
  }

  /**
   * Turn an approved enquiry into a brand. Operator-gated, because approving
   * is the decision, and the whole point of manual approval is that a person
   * makes it.
   */
  async handleApproveBrand(request: Request): Promise<Response> {
    const guard = this.requireOperator(request);
    if (guard) return guard;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await approveBrand(this.blobs, body);
    if (!result.ok) {
      return Response.json({ error: result.error, field: result.field }, { status: 400 });
    }
    return Response.json(
      { brand: result.brand, created: result.created },
      { status: result.created ? 201 : 200 },
    );
  }

  /**
   * What a brand sees: their campaigns, and nothing else.
   *
   * Scoped by ownerId against the signed-in brand, never by anything the
   * caller supplies. A dashboard that takes a brand id from a query parameter
   * is a dashboard that shows anybody anybody else's spend.
   *
   * Read-only. Campaign creation stays operator-gated, so this reports on
   * money rather than committing it — and the one endpoint that can commit it
   * is unreachable from here.
   */
  async handleBrandDashboard(request: Request): Promise<Response> {
    const email = await this.emailFor(request);
    if (!email) return Response.json({ error: 'not signed in' }, { status: 401 });

    const brand = await brandFor(this.blobs, email);
    if (!brand) {
      // Deliberately not a 403. Somebody signed in with a personal address is
      // not forbidden, they simply have no brand account yet — and the answer
      // that helps them is where to ask for one.
      return Response.json(
        { brand: null, next: 'No brand account for this address yet — tell us about your campaign at /launch.html' },
        { status: 200 },
      );
    }

    await this.ready();
    const state = this.store.exportState();
    const mine = state.campaigns.filter((c) => c.ownerId === brand.brandId);

    const campaigns = await Promise.all(mine.map(async (c) => {
      const subs = state.submissions.filter((x) => x.campaignId === c.campaignId);
      const paid = state.payouts.filter((x) => x.campaignId === c.campaignId);
      let spentMicro = 0n;
      let viewsPaid = 0n;
      for (const p of paid) { spentMicro += p.amountUsdc.micro; viewsPaid += p.viewsPaidTo; }
      const funding = this.balances
        ? await fundingFor(c, new Decimal(Number(spentMicro) / 1_000_000), this.balances)
        : undefined;

      // Submissions received, with the creator's standing and the verdict.
      // A brand asking "who is clipping for me and did it meet the brief" is
      // asking about these three things together; separately they answer
      // nothing.
      const received = subs.map((x) => {
        const theirs = state.submissions.filter((y) => y.creatorId === x.creatorId);
        const verdict = state.verdicts.find((v) => v.submissionId === x.submissionId);
        const paidFor = paid.find((pp) => pp.submissionId === x.submissionId);
        return {
          submissionId: x.submissionId,
          url: x.url,
          submittedAt: x.submittedAt,
          creatorStanding: standingFor(x.creatorId, theirs, this.store).standing,
          verdict: verdict ? (verdict.pass ? 'pass' : 'fail') : 'not judged yet',
          verdictReason: verdict?.reasons?.[0],
          state: paidFor ? 'paid' : verdict && !verdict.pass ? 'refused' : 'waiting',
          paidUsdc: paidFor?.amountUsdc.toString(),
        };
      });

      return {
        campaignId: c.campaignId,
        brief: c.brief,
        status: c.status,
        rateBand: { minUsdc: c.rateBand.minUsdc.toString(), maxUsdc: c.rateBand.maxUsdc.toString() },
        fundingWallet: c.fundingWallet,
        received,
        poolUsdc: c.poolUsdc.toString(),
        spentUsdc: (Number(spentMicro) / 1_000_000).toFixed(6),
        remainingUsdc: c.poolUsdc.minus(new Decimal(Number(spentMicro) / 1_000_000)).toString(),
        cpmUsdc: c.cpmUsdc.toString(),
        perCreatorCapUsdc: c.perCreatorCapUsdc.toString(),
        dwellHours: Math.round(c.dwellMs / 3_600_000),
        minStanding: c.minStanding,
        submissions: subs.length,
        creators: new Set(subs.map((x) => x.creatorId)).size,
        payouts: paid.length,
        viewsPaid: viewsPaid.toString(),
        funding: funding && { coverage: funding.coverage, fundedUsdc: funding.fundedUsdc,
                              summary: funding.summary },
        endsAt: c.endsAt,
      };
    }));

    return Response.json({
      brand: { brandId: brand.brandId, company: brand.company, email: brand.email,
               approvedAt: brand.approvedAt },
      campaigns,
      totals: {
        campaigns: campaigns.length,
        spentUsdc: campaigns
          .reduce((a, c) => a + Number(c.spentUsdc), 0).toFixed(6),
        creators: campaigns.reduce((a, c) => a + c.creators, 0),
        submissions: campaigns.reduce((a, c) => a + c.submissions, 0),
      },
    });
  }

  async handleBrandEnquiry(request: Request): Promise<Response> {
    const clientIp = request.headers.get('x-forwarded-for') ?? 'anonymous';
    if (!this.rateLimiter.consume(clientIp)) {
      return Response.json({ error: 'Too many submissions — try again shortly.' }, { status: 429 });
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const result = parseEnquiry(body);
    if (!result.ok) {
      return Response.json({ error: result.error, field: result.field }, { status: 400 });
    }

    // putIfAbsent, so a double-submitted form is one enquiry rather than two.
    // The id is derived from the address and the minute, so a genuine second
    // enquiry later still lands.
    const stored = await this.blobs.putIfAbsent(
      enquiryKey(result.value), JSON.stringify(result.value, null, 2),
    );

    if (stored) {
      const enquiry = result.value;
      const notifyEmail = process.env.ENQUIRY_NOTIFY_EMAIL ?? process.env.OPERATOR_EMAIL ?? 'aditya@merlinclips.com';
      await this.webhooks.alert({
        event: 'enquiry_received',
        title: `New Brand Enquiry from ${enquiry.name} (${enquiry.email})`,
        message: `New brand enquiry ready for operator response (Forwarded to ${notifyEmail}):\nCompany Website: ${enquiry.website}\nBudget Range: ${enquiry.budget}\nAgency Managed: ${enquiry.wantsAgency ? 'YES' : 'NO'}\nGoals: ${enquiry.goals}`,
        details: {
          enquiryId: enquiry.enquiryId,
          name: enquiry.name,
          email: enquiry.email,
          website: enquiry.website,
          budget: enquiry.budget,
          wantsAgency: enquiry.wantsAgency,
          forwardToEmail: notifyEmail,
        },
      });
    }

    return Response.json(
      {
        received: true,
        enquiryId: result.value.enquiryId,
        duplicate: !stored,
        // Said plainly: there is no automated onboarding behind this yet, and
        // implying one would be the first thing we got wrong with a brand.
        next: 'A person reads these. Expect a reply to the address you gave, not a drip sequence.',
      },
      { status: stored ? 201 : 200 },
    );
  }

  async handleOpenCampaign(request: Request): Promise<Response> {
    const guard = this.requireOperator(request);
    if (guard) return guard;
    await this.ready();

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const result = openCampaign(body);
    if (!result.ok) {
      return Response.json({ error: result.error, field: result.field }, { status: 400 });
    }

    await this.record({ type: 'campaign_upserted', campaign: result.value });
    const c = result.value;
    return Response.json(
      {
        campaignId: c.campaignId,
        brief: c.brief,
        poolUsdc: c.poolUsdc.toString(),
        cpmUsdc: c.cpmUsdc.toString(),
        perCreatorCapUsdc: c.perCreatorCapUsdc.toString(),
        dwellHours: Math.round(c.dwellMs / 3_600_000),
        settlementDays: Math.round(c.settlementWindowMs / 86_400_000),
        platforms: c.platforms,
        chain: c.chain,
        endsAt: c.endsAt,
        submitTo: `/api/submissions`,
      },
      { status: 201 },
    );
  }

  /**
   * `POST /api/submissions` — a creator submits a clip.
   *
   * Deliberately public. The payout address is the identity, because it is the
   * thing that receives money; requiring a signup before someone can be paid
   * is the friction this product exists to remove.
   */
  async handleSubmit(request: Request): Promise<Response> {
    await this.ready();

    const accountId = await this.accountFor(request);

    const clientIp = request.headers.get('x-forwarded-for') ?? 'anonymous';
    if (!this.rateLimiter.consume(clientIp)) {
      telemetry.recordHttpRequest('/api/submissions', 429);
      return Response.json({ error: 'Rate limit exceeded — try again shortly' }, { status: 429 });
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const campaignId = String(body.campaignId ?? '');

    return await this.locks.withLock(campaignId || 'global', async () => {
      const campaign = this.store.campaign(campaignId);
      const result = submitClip(
        campaign, body, new Date(),
        (cid, platform, postId) => this.store.claimantOf(cid, platform, postId),
        (creatorId) => this.eligibilityFor(creatorId, campaignId),
      );
      if (!result.ok) {
        telemetry.recordHttpRequest('/api/submissions', 400);
        return Response.json({ error: result.error, field: result.field }, { status: 400 });
      }

      const { submission, creator } = result.value;

      // Write down that this wallet belongs to the signed-in account, so the
      // account's profile can find work filed under it. Best effort: a
      // creator is paid to an address, and a failure to record the link does
      // not change the address.
      if (accountId) {
        linkWallet(this.store, accountId, creator.payoutAddress);
      }

      await this.record({ type: 'creator_upserted', creator });
      const isNew = await this.record({ type: 'submission_accepted', submission });

      const terms = submission.acceptedTerms;
      const status = isNew ? 201 : 200;
      telemetry.recordHttpRequest('/api/submissions', status);

      return Response.json(
        {
          submissionId: submission.submissionId,
          alreadySubmitted: !isNew,
          url: submission.url,
          platform: submission.platform,
          // The deal, echoed back. It is frozen from this moment and the brand
          // cannot change it under work already accepted.
          agreedTerms: {
            cpmUsdc: terms.cpmUsdc.toString(),
            perCreatorCapUsdc: terms.perCreatorCapUsdc.toString(),
            dwellHours: Math.round(terms.dwellMs / 3_600_000),
            acceptedAt: terms.acceptedAt,
            guaranteedUntil: terms.settlementDeadline,
          },
          poolRemainingUsdc: this.store.remainingPool(submission.campaignId).toString(),
          next:
            'your views are counted from now. nothing pays until they have held ' +
            `for ${Math.round(terms.dwellMs / 3_600_000)}h — check /api/submissions/` +
            submission.submissionId,
        },
        { status },
      );
    });
  }

  /** `GET /api/submissions/:id` — what a creator sees about their own clip. */
  async handleSubmissionStatus(submissionId: string): Promise<Response> {
    await this.ready();
    const submission = this.store.submission(submissionId);
    if (!submission) return Response.json({ error: 'unknown submission' }, { status: 404 });

    const decision = this.gate.decide(submissionId, {
      agentId: this.env.AGENT_ID ?? 'campaign-agent',
    });
    const verdict = this.store.latestVerdict(submissionId);

    return Response.json({
      submissionId,
      url: submission.url,
      status: decision.disposition,
      control: decision.control,
      /**
       * Whether this is still in progress or genuinely decided.
       *
       * `disposition` alone conflates them: a clip awaiting its first
       * verification and a clip that failed the brief are both `blocked`, and
       * a UI showing them identically tells a creator their work was rejected
       * when it is merely queued. The distinction is the difference between
       * "not yet" and "no", and this product's whole posture is that a wait
       * must never read as a rejection.
       */
      settled: decision.control !== 'no_verdict' && decision.control !== 'dwell_unmet',
      // Written for the creator, not a log parser — including on a refusal.
      reason: decision.reason,
      verdict: verdict && { pass: verdict.pass, reasons: verdict.reasons, at: verdict.at },
      confirmedViews: decision.confirmedViews.toString(),
      paidForViews: this.store.viewsPaidTo(submissionId).toString(),
      earnedUsdc: this.store.spentOnCreator(submission.campaignId, submission.creatorId).toString(),
      guaranteedUntil: submission.acceptedTerms.settlementDeadline,
      // Their standing, from the same arithmetic that decides the payout.
      standing: standingFor(
        submission.creatorId,
        this.store.exportState().submissions.filter((x) => x.creatorId === submission.creatorId),
        this.store,
      ),
    });
  }

  /**
   * The operator gate — a *different* secret from the tick's.
   *
   * These were the same value, and they should not be. The two capabilities
   * are not comparable: running a tick settles payouts the engine has already
   * decided, within caps the operator set. Opening a campaign declares a pool,
   * and a pool is a promise to pay — it is how money gets committed in the
   * first place.
   *
   * Cloud Scheduler holds the tick secret because it must, and it is the least
   * protected credential in the system: it sits in a scheduler job definition,
   * it was typed into a shell to create that job, and it travels as a header
   * on every scheduled request. Granting campaign creation to whatever can
   * trigger a tick means the weakest credential carries the strongest
   * capability.
   *
   * Fails closed, like the tick. An operator endpoint that is public because
   * nobody set a variable is worse than one that is switched off.
   */
  private requireOperator(request: Request): Response | null {
    const expected = this.env.OPERATOR_SECRET;
    if (!expected) {
      return Response.json(
        {
          error: 'OPERATOR_SECRET is not configured — refusing operator actions',
          detail:
            'Opening a campaign commits money, so it needs its own secret rather ' +
            'than sharing the one Cloud Scheduler holds. Generate with: ' +
            'openssl rand -hex 24',
        },
        { status: 503 },
      );
    }
    if (!secretMatches(request.headers.get('x-operator-secret'), expected)) {
      return Response.json({ error: 'unauthorised' }, { status: 401 });
    }
    return null;
  }

  /** Route handler for on-demand funding balance check for a campaign. */
  async handleCheckFunding(campaignId: string): Promise<Response> {
    await this.ready();
    const campaign = this.store.campaign(campaignId);
    if (!campaign) {
      return Response.json({ error: 'unknown campaign' }, { status: 404 });
    }
    const spent = this.store.spentOnCampaign(campaignId);
    const funding = this.balances
      ? await fundingFor(campaign, spent, this.balances)
      : {
          campaignId: campaign.campaignId,
          fundedUsdc: null,
          poolUsdc: campaign.poolUsdc.toString(),
          committedUsdc: spent.toString(),
          coverage: campaign.fundingWallet ? ('unknown' as const) : ('no_wallet' as const),
          summary: campaign.fundingWallet
            ? 'Balance reader not configured on this deployment.'
            : 'This campaign has not named a wallet, so nothing backs its budget yet.',
        };

    return Response.json({ ok: true, funding });
  }

  /** Expose latest tick execution status for asynchronous polling. */
  async handleTickStatus(): Promise<Response> {
    await this.ready();
    return Response.json({
      inProgress: !!this.inFlightTick,
      lastTick: this.lastTick
        ? {
            startedAt: this.lastTick.startedAt,
            paid: this.lastTick.paid,
            held: this.lastTick.held,
            blocked: this.lastTick.blocked,
            needsApproval: this.lastTick.needsApproval,
            totalPaidUsdc: this.lastTick.totalPaidUsdc.toString(),
            errors: this.lastTick.errors,
          }
        : null,
    });
  }

  /** Route handler for `POST /api/tick`. Returns null when the path isn't ours. */
  async handleTick(request: Request): Promise<Response> {
    const expected = this.env.TICK_SECRET;
    if (!expected) {
      return Response.json(
        {
          error: 'TICK_SECRET is not configured',
          detail:
            'refusing to run a payout pass on an unauthenticated endpoint — set ' +
            'TICK_SECRET and send it as x-tick-secret',
        },
        { status: 503 },
      );
    }
    if (!secretMatches(request.headers.get('x-tick-secret'), expected)) {
      return Response.json({ error: 'unauthorised' }, { status: 401 });
    }

    this.reservations.sweepExpired();

    const url = new URL(request.url);
    const isAsync =
      url.searchParams.get('async') === 'true' || request.headers.get('x-tick-async') === 'true';

    if (isAsync) {
      if (this.inFlightTick) {
        return Response.json(
          { ok: true, status: 'already_running', message: 'A tick pass is currently in progress' },
          { status: 409 },
        );
      }
      const backgroundRun = this.tick();
      backgroundRun.catch((err) => {
        console.error(`background tick failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      return Response.json(
        {
          ok: true,
          status: 'started',
          message: 'Tick pass started asynchronously',
          statusUrl: '/api/tick/status',
        },
        { status: 202 },
      );
    }

    const result = await this.tick();
    return Response.json({
      ...result,
      totalPaidUsdc: result.totalPaidUsdc.toString(),
      decisions: result.decisions.map((d) => ({
        submissionId: d.submissionId,
        disposition: d.disposition,
        control: d.control,
        reason: d.reason,
        confirmedViews: d.confirmedViews.toString(),
        payableViews: d.payableViews.toString(),
        amountUsdc: d.amountUsdc.toString(),
      })),
    });
  }
}


