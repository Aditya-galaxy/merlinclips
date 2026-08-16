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
import { MandateStore, issueMandate } from '../mandates';
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
import { apiKeysFromEnv, type ApiKey } from '../mcpauth';
import { ALWAYS_ENABLED, MemoryTrackingStore, previewClip, verifyClip } from './verify';
import type { ClipVerifier, CountOracle } from './verify';
import { CircleCliExecutor } from './executor';
import { analyticsFromEnv } from '../telemetry/analytics';
import { turnstileFromEnv } from '../telemetry/turnstile';
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
import { isLaunched } from './types';
import type { Campaign, CampaignStatus, Platform } from './types';
import type { CreatorAccount } from './types';
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

/**
 * The addresses this deployment can sign transfers from, per network.
 *
 * Network-selected for the same reason the executor is: a Circle agent wallet
 * exists on one chain, so a mainnet deployment listing testnet addresses can
 * sign for none of them. Reading one variable *or* the other means the mismatch
 * cannot be configured — there is no combination that arms mainnet against a
 * testnet list.
 *
 * Addresses are lowercased on the way in. They arrive from three places that
 * disagree on case — a brand pasting from a block explorer, an agent echoing
 * our own JSON, and a shell variable — and a checksummed address failing to
 * match the same address in lowercase would reject a wallet we do hold.
 */
export function signableWallets(
  env: Record<string, string | undefined> = Bun.env,
): ReadonlySet<string> {
  const raw = env.ALLOW_MAINNET === 'true'
    ? env.MAINNET_SETTLEMENT_WALLETS
    : env.SETTLEMENT_WALLETS;
  return new Set(
    (raw ?? '')
      .split(',')
      .map((a) => a.trim().toLowerCase())
      .filter((a) => a.length > 0),
  );
}

/**
 * Platforms this deployment can confirm views on.
 *
 * Instagram is added by the same variable that builds its oracle. Two switches
 * would allow the two states that are each wrong in their own way: a platform
 * open for submissions with nothing able to count it, and a reader for a
 * platform nobody is allowed to submit.
 */
export function enabledPlatforms(
  env: Record<string, string | undefined> = Bun.env,
): ReadonlySet<Platform> {
  const enabled = new Set<Platform>(ALWAYS_ENABLED);
  const tokens = (env.INSTAGRAM_TESTER_TOKENS ?? '').split(',').filter((t) => t.trim());
  if (tokens.length > 0) enabled.add('instagram');
  return enabled;
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
  /** Public so the auditor's export can replay the same events the engine reads. */
  public readonly log: EventLog;
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

  /**
   * The wallets this deployment's Circle session can actually sign for.
   *
   * A campaign is funded to `campaign.fundingWallet` and paid out of it, so an
   * address we hold no key for produces a campaign that takes a brand's
   * deposit and can never pay a creator — and only says so at settlement,
   * after the clips are made. The container has no Circle CLI (see the
   * Dockerfile: the session is an interactive OTP login and cannot live in an
   * image), so it cannot ask; the deployment has to tell it.
   *
   * Empty means no settlement rail, which is already a deployment that pays
   * nobody — `buildExecutor` returns a `DryRunExecutor` on the same condition.
   * The guard only bites when the deployment claims it *can* settle, because
   * that is the case where a campaign would otherwise be accepted on a promise
   * we cannot keep.
   */
  private readonly signable: ReadonlySet<string>;

  /**
   * Platforms this deployment can confirm views on.
   *
   * The same flag that builds the Instagram oracle decides this, because the
   * two must not disagree: an enabled platform with no reader accepts clips
   * that can never accrue, and a reader for a platform nobody may submit is
   * dead weight. One source, so the pair cannot drift.
   */
  private readonly enabledPlatforms: ReadonlySet<Platform>;

  /**
   * Keys that may open a campaign through MCP.
   *
   * Held here rather than read from `Bun.env` at the call site so the runtime
   * has one environment, not two. The executor learned this the hard way: it
   * read the process env for its broadcast gate while the runtime read the
   * injected object for everything else, so a runtime told BROADCAST=true
   * still estimated and no test could express the case.
   */
  public readonly mcpKeys: readonly ApiKey[];

  /** Two-phase budget reservation engine for enterprise campaign payouts. */
  public readonly reservations = new ReservationEngine();
  /** Per-campaign distributed lock manager for mutual exclusion. */
  public readonly locks = new CampaignLockManager();
  /**
   * The campaign-to-wallet registry.
   *
   * Nothing in the settlement path reads it yet — payouts still leave the
   * configured campaign wallet, so nonce isolation is a precondition that is
   * in place rather than a benefit already realised. The exclusivity rule it
   * enforces is live though, and `otherClaimsOn()` below is the arithmetic
   * that stops one balance backing two pools in the meantime.
   */
  public readonly cluster = new MultiAgentClusterManager();
  /** Product analytics, captured server-side so blockers cannot undercount. */
  public readonly analytics = analyticsFromEnv();
  /** Bot challenge on the public enquiry form. */
  public readonly turnstile = turnstileFromEnv();
  /** Token bucket rate limiter for public API doors. */
  public readonly rateLimiter = new TokenBucketRateLimiter({ capacity: 60, refillRate: 10 });

  constructor(options: CampaignRuntimeOptions = {}) {
    this.env = options.env ?? Bun.env;
    this.signable = signableWallets(this.env);
    this.enabledPlatforms = enabledPlatforms(this.env);
    this.mcpKeys = apiKeysFromEnv(this.env);
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

    // Circle's Agent Stack, which is what this settles through: the CLI is the
    // Agent Stack component that moves USDC, signing with the session created
    // by `circle wallet login`.
    //
    // These no longer name the wallet money leaves — that is
    // `campaign.fundingWallet`, decided per campaign, because the wallet
    // coverage is checked against has to be the wallet that pays. What the
    // deployment still has to answer is which wallets it can sign for, which
    // is also the answer to whether it can settle at all. Empty means no
    // settlement rail, so payouts are planned and never sent.
    if (onMainnet && this.signable.size === 0) {
      throw new Error(
        'ALLOW_MAINNET=true but MAINNET_SETTLEMENT_WALLETS is empty. Refusing to start: ' +
          'settling on mainnet from a testnet session is not a recoverable mistake.',
      );
    }
    if (this.signable.size === 0) return new DryRunExecutor();

    return new CircleCliExecutor({
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
      // The policy engine reads this.mandates, replay fills this.store. Without
      // this copy a cold instance boots with no spend authority and refuses
      // every payout it was funded to make.
      const replayed = this.store.exportState();
      for (const mandate of replayed.mandates) this.mandates.put(mandate);
      // Rebuilt from the campaigns themselves: the binding is a fact about a
      // campaign, not a separate record, so replay is where it comes back.
      // Ended campaigns do not hold their wallet. They are owed nothing, so
      // the address is free for the next one — which is what lets an agent
      // with a single wallet run more than one campaign in its lifetime.
      for (const c of replayed.campaigns) {
        if (c.fundingWallet && c.status !== 'ended') {
          this.cluster.register(c.campaignId, c.fundingWallet);
        }
      }
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
      { agentId: this.env.AGENT_ID ?? 'campaign-agent', now: at, analytics: this.analytics },
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
      // Pre-launch campaigns are withheld, not merely labelled. Listing an
      // unfunded pool next to a rate is the exact thing this system is meant to
      // stop: the number a creator uses to decide whether the evening is worth
      // it, published before anyone checked it.
      // Launched *and* not ended. Two different questions were sharing one
      // predicate: the payout gate must keep settling an ended campaign,
      // because clips accepted under its frozen terms are still owed, while
      // this listing is what a creator reads as available work. An ended
      // campaign shown here invites an evening of editing against a brief that
      // will refuse the submission.
      campaigns: await Promise.all(state.campaigns
        .filter((c) => isLaunched(c.status) && c.status !== 'ended')
        .map(async (c) => {
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
          // Who is paying and what to call it. Absent on campaigns opened
          // before these existed, which is why every consumer falls back to
          // the brief rather than rendering a blank card.
          brandName: c.brandName,
          title: c.title,
          category: c.category,
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
            ? await fundingFor(c, spent, this.balances, this.otherClaimsOn(c))
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
      // Every settlement, newest first, so the public ledger renders from the
      // same rows the payout engine wrote rather than from anything typed into
      // a page by hand. `txHash` is the whole point: it is what lets a creator
      // check our arithmetic against Base instead of believing it.
      //
      // `creatorId` is deliberately withheld. The audit claim is "this amount
      // settled for these views, here is the transaction" — publishing a named
      // person's full earnings history is not needed to support it.
      payouts: [...state.payouts]
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
        .map((p) => ({
          payoutId: p.payoutId,
          campaignId: p.campaignId,
          submissionId: p.submissionId,
          viewsPaidTo: p.viewsPaidTo.toString(),
          amountUsdc: p.amountUsdc.toString(),
          at: p.at,
          txHash: p.txHash,
          explorerUrl: p.explorerUrl,
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
        { tracking: this.tracking, enabled: this.enabledPlatforms },
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
    return (await this.sessionFor(request))?.creatorId;
  }

  /**
   * The whole session, not just the id.
   *
   * Onboarding used to default a creator's name to the literal string
   * "Creator" and synthesise an email, while Google had already told us both
   * at sign-in. The dashboard then showed "Creator" to someone whose name we
   * knew, which is a small thing that reads as the product not knowing who
   * they are.
   */
  private async sessionFor(request: Request) {
    const secret = this.env.SESSION_SECRET?.trim();
    if (!secret) return undefined;
    return verifySession(
      readSessionCookie(request.headers.get('cookie'), SESSION_COOKIE_NAME), secret,
    );
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
    const walletAddrs = acc ? walletsFor(acc) : [];
    const ids = new Set(walletAddrs);
    const state = this.store.exportState();
    const mine = state.submissions.filter((x) => ids.has(x.creatorId));

    let earnedMicro = 0n;
    const payouts = [];
    const lastPaidAtMap = new Map<string, string>();

    // `viewsPaidTo` is a high-water mark per submission, not an increment. A
    // clip paid twice as it kept accruing — 8,000 views, then 12,400 — carries
    // both marks, and adding them reports 20,400 views for a clip that reached
    // 12,400. Amounts *are* increments and do sum; views are the mark reached,
    // so take the largest per submission and add those.
    const highWater = new Map<string, bigint>();

    for (const p of state.payouts) {
      if (!ids.has(p.creatorId)) continue;
      earnedMicro += p.amountUsdc.micro;
      const seen = highWater.get(p.submissionId) ?? 0n;
      if (p.viewsPaidTo > seen) highWater.set(p.submissionId, p.viewsPaidTo);
      payouts.push({
        submissionId: p.submissionId,
        campaignId: p.campaignId,
        amountUsdc: p.amountUsdc.toString(),
        viewsPaidTo: p.viewsPaidTo.toString(),
        settledAt: p.at,
        txHash: p.txHash,
        // Carried through rather than rebuilt in the page. The creator studio
        // was composing `basescan.org/tx/<hash>` by hand, which is the mainnet
        // explorer — every settlement so far is on Base Sepolia, so the one
        // link that exists to prove a payment happened led to a page saying
        // the transaction does not exist.
        explorerUrl: p.explorerUrl,
      });
      lastPaidAtMap.set(p.creatorId.toLowerCase(), p.at);
    }

    let viewsPaid = 0n;
    for (const mark of highWater.values()) viewsPaid += mark;

    const linkedWallets = walletAddrs.map((w) => ({
      address: w,
      chain: 'Base',
      firstSeenAt: acc ? acc.joinedAt : new Date().toISOString(),
      lastPaidAt: lastPaidAtMap.get(w.toLowerCase()) || null,
    }));

    const record = standingFor(accountId, mine, this.store);

    let holdingMicro = 0n;
    let holdingViews = 0n;
    const campaignMap = new Map<
      string,
      { campaignId: string; submissionsCount: number; viewsPaid: bigint; earnedMicro: bigint }
    >();

    const submissionsDetailed = mine.map((x) => {
      const snapshots = this.store.snapshots(x.submissionId);
      const paidViews = this.store.viewsPaidTo(x.submissionId);
      const verdict = this.store.latestVerdict(x.submissionId);

      let peakViews = 0n;
      for (const s of snapshots) if (s.views > peakViews) peakViews = s.views;

      let st = 'waiting';
      let reason = '';
      if (paidViews > 0n) {
        st = 'settled';
      } else if (verdict && !verdict.pass) {
        st = 'refused';
        reason = verdict.reasons.join(' ') || 'Clip did not meet the brief criteria.';
      } else {
        st = 'waiting';
        const unserved = peakViews - paidViews;
        if (unserved > 0n) {
          const micro = (unserved * x.acceptedTerms.cpmUsdc.micro) / 1000n;
          holdingMicro += micro;
          holdingViews += unserved;
        }
      }

      const earnedSubMicro = (paidViews * x.acceptedTerms.cpmUsdc.micro) / 1000n;

      let cData = campaignMap.get(x.campaignId);
      if (!cData) {
        cData = { campaignId: x.campaignId, submissionsCount: 0, viewsPaid: 0n, earnedMicro: 0n };
        campaignMap.set(x.campaignId, cData);
      }
      cData.submissionsCount += 1;
      cData.viewsPaid += paidViews;
      cData.earnedMicro += earnedSubMicro;

      return {
        submissionId: x.submissionId,
        campaignId: x.campaignId,
        url: x.url,
        submittedAt: x.submittedAt,
        cpmUsdc: x.acceptedTerms.cpmUsdc.toString(),
        dwellHours: Math.round(x.acceptedTerms.dwellMs / 3_600_000),
        state: st,
        confirmedViews: peakViews.toString(),
        paidForViews: paidViews.toString(),
        earnedUsdc: (Number(earnedSubMicro) / 1_000_000).toFixed(2),
        refusalReason: reason,
      };
    });

    const campaignsBreakdown = Array.from(campaignMap.values()).map((c) => ({
      campaignId: c.campaignId,
      submissionsCount: c.submissionsCount,
      viewsPaid: c.viewsPaid.toString(),
      earnedUsdc: (Number(c.earnedMicro) / 1_000_000).toFixed(2),
    }));

    // Standing level progress calculation (Unproven -> Building -> Reliable -> Exceptional)
    let nextLevelProgress = 100;
    let nextLevelName = 'Max Level';
    if (record.standing === 'unproven') {
      nextLevelProgress = Math.min(100, Math.round((record.judged / 3) * 100));
      nextLevelName = 'Building';
    } else if (record.standing === 'building') {
      const rate = record.survivalRate || 0;
      nextLevelProgress = Math.min(100, Math.round((rate / 0.7) * 100));
      nextLevelName = 'Reliable';
    } else if (record.standing === 'reliable') {
      const rate = record.survivalRate || 0.7;
      nextLevelProgress = Math.min(100, Math.round(((rate - 0.7) / 0.2) * 100));
      nextLevelName = 'Exceptional';
    }

    return Response.json({
      account: {
        accountId,
        googleSub: acc?.googleSub || accountId,
        name: acc?.name || 'Creator',
        email: acc?.email || '',
        handle: acc?.handle || 'creator',
        bio: acc?.bio || '',
        language: acc?.language || 'English',
        creatorType: acc?.creatorType || 'Clipper',
        wallet: acc?.wallet || walletAddrs[0] || '0x0003a59858f44451be2a5b486ee612b4139700f0',
        joinedAt: acc?.joinedAt || new Date().toISOString(),
      },
      linkedWallets,
      wallets: walletAddrs,
      standing: {
        level: record.standing,
        survivalRate: record.survivalRate,
        clipsJudged: record.judged,
        observedViews: record.observedViews.toString(),
        survivedViews: record.survivedViews.toString(),
        says: record.summary,
        nextLevelProgress,
        nextLevelName,
      },
      totals: {
        earnedUsdc: (Number(earnedMicro) / 1_000_000).toFixed(2),
        holdingUsdc: (Number(holdingMicro) / 1_000_000).toFixed(2),
        holdingViews: holdingViews.toString(),
        viewsPaid: viewsPaid.toString(),
        submissions: mine.length,
        payouts: payouts.length,
      },
      submissions: submissionsDetailed,
      campaignsBreakdown,
      payouts,
    });
  }

  /**
   * Record creator onboarding profile data (handle, bio, language, creatorType, wallet).
   */
  async handleSaveOnboarding(request: Request): Promise<Response> {
    await this.ready();

    // Refused rather than filed under 'anonymous'. Every signed-out save used
    // to land on one shared account, so unrelated creators' payout wallets
    // accumulated in a single record's linkedWallets — and nobody could reach
    // it afterwards, because reading a profile requires the session that
    // writing one did not.
    const session = await this.sessionFor(request);
    const accountId = session?.creatorId;
    if (!accountId) {
      return Response.json(
        { error: 'sign in before saving a profile — a payout address has to belong to someone' },
        { status: 401 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const existingAcc = this.store.getCreatorAccount(accountId);
    const existingWallets = existingAcc ? [...existingAcc.linkedWallets] : [];

    // Single wallet architecture: reuse existing primary wallet if available to prevent multi-wallet fragmentation
    let wallet = typeof body.wallet === 'string' && body.wallet.trim().startsWith('0x')
      ? body.wallet.trim()
      : '';

    if (!wallet) {
      if (existingAcc?.wallet && existingAcc.wallet.startsWith('0x')) {
        wallet = existingAcc.wallet;
      } else {
        // Previously defaulted to the platform's own agent wallet, which meant
        // a creator who left the field blank had our treasury recorded as
        // their payout address — their earnings would have settled to us.
        return Response.json(
          { error: 'a Base wallet address is required — this is where your USDC is sent',
            field: 'wallet' },
          { status: 400 },
        );
      }
    }

    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      return Response.json(
        { error: 'that is not a valid Base address — it should be 0x followed by 40 characters',
          field: 'wallet' },
        { status: 400 },
      );
    }
    
    if (!existingWallets.some((w) => w.address.toLowerCase() === wallet.toLowerCase())) {
      existingWallets.push({
        address: wallet,
        chain: 'base',
        firstSeenAt: new Date().toISOString(),
      });
    }

    const updatedAccount: CreatorAccount = {
      accountId,
      googleSub: existingAcc?.googleSub || accountId,
      name: (typeof body.name === 'string' && body.name)
        || session?.name || existingAcc?.name || 'Creator',
      email: session?.email || existingAcc?.email || `${accountId}@merlinclips.user`,
      handle: typeof body.handle === 'string' ? body.handle : existingAcc?.handle || 'creator',
      bio: typeof body.bio === 'string' ? body.bio : existingAcc?.bio || '',
      language: typeof body.language === 'string' ? body.language : existingAcc?.language || 'English',
      creatorType: typeof body.type === 'string' ? body.type : existingAcc?.creatorType || 'Clipper',
      wallet,
      joinedAt: existingAcc?.joinedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revision: (existingAcc?.revision ?? 0) + 1,
      linkedWallets: existingWallets,
    };

    // Through the log, not only into the store. Writing to the store alone
    // meant a creator's Google account, handle and linked payout wallet lived
    // in one instance's memory: they completed onboarding, and lost all of it
    // the moment that instance recycled.
    this.store.putCreatorAccount(updatedAccount);
    await this.record({ type: 'account_upserted', account: updatedAccount });

    void this.analytics.identify(accountId, {
      $email: updatedAccount.email || undefined,
      $name: updatedAccount.name || undefined,
      handle: updatedAccount.handle || undefined,
      creatorType: updatedAccount.creatorType ?? undefined,
      language: updatedAccount.language ?? undefined,
      role: 'creator',
      walletsLinked: existingWallets.length,
      joinedAt: updatedAccount.joinedAt,
      // Held back unless POSTHOG_INCLUDE_WALLETS is set: an email is
      // revocable, a wallet is a permanent key into a public ledger.
      payoutWallet: this.analytics.includeWallets ? wallet : undefined,
    });
    void this.analytics.capture({
      event: existingAcc ? 'creator_profile_updated' : 'creator_signed_up',
      distinctId: accountId,
      properties: {
        walletsLinked: existingWallets.length,
        hasHandle: Boolean(updatedAccount.handle),
        creatorType: updatedAccount.creatorType ?? null,
      },
    });
    await this.record({
      type: 'creator_upserted',
      creator: {
        creatorId: wallet,
        payoutAddress: wallet,
        handles: {},
      },
    });
    return Response.json({ ok: true, account: updatedAccount });
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
      return Response.json(
        { brand: null, next: 'No brand account for this address yet — tell us about your campaign at /launch.html' },
        { status: 200 },
      );
    }

    await this.ready();
    const state = this.store.exportState();
    const mine = state.campaigns.filter((c) => c.ownerId === brand.brandId);

    let totalPoolMicro = 0n;
    let totalCommittedMicro = 0n;
    let totalSettledMicro = 0n;
    let totalViewsPaid = 0n;
    const globalRefusalMap = new Map<string, number>();

    const campaigns = await Promise.all(mine.map(async (c) => {
      totalPoolMicro += c.poolUsdc.micro;
      const subs = state.submissions.filter((x) => x.campaignId === c.campaignId);
      const paid = state.payouts.filter((x) => x.campaignId === c.campaignId);

      let spentMicro = 0n;
      let viewsPaid = 0n;
      let committedMicro = 0n;
      const perCreatorMap = new Map<string, { creatorId: string; spentMicro: bigint; submissionsCount: number }>();
      const campaignRefusalsMap = new Map<string, number>();

      for (const p of paid) {
        spentMicro += p.amountUsdc.micro;
        viewsPaid += p.viewsPaidTo;

        let pc = perCreatorMap.get(p.creatorId);
        if (!pc) {
          pc = { creatorId: p.creatorId, spentMicro: 0n, submissionsCount: 0 };
          perCreatorMap.set(p.creatorId, pc);
        }
        pc.spentMicro += p.amountUsdc.micro;
        pc.submissionsCount += 1;
      }

      totalSettledMicro += spentMicro;
      totalViewsPaid += viewsPaid;

      const received = subs.map((x) => {
        const theirs = state.submissions.filter((y) => y.creatorId === x.creatorId);
        const verdict = state.verdicts.find((v) => v.submissionId === x.submissionId);
        const paidFor = paid.find((pp) => pp.submissionId === x.submissionId);
        const paidViews = this.store.viewsPaidTo(x.submissionId);
        const snapshots = this.store.snapshots(x.submissionId);

        let peakViews = 0n;
        for (const s of snapshots) if (s.views > peakViews) peakViews = s.views;

        let st = 'waiting';
        let reason = '';
        if (paidFor) {
          st = 'paid';
        } else if (verdict && !verdict.pass) {
          st = 'refused';
          reason = verdict.reasons[0] || 'Clip did not meet brief criteria.';
          campaignRefusalsMap.set(reason, (campaignRefusalsMap.get(reason) || 0) + 1);
          globalRefusalMap.set(reason, (globalRefusalMap.get(reason) || 0) + 1);
        } else {
          st = 'waiting';
          const unserved = peakViews - paidViews;
          if (unserved > 0n) {
            const micro = (unserved * x.acceptedTerms.cpmUsdc.micro) / 1000n;
            committedMicro += micro;
          }
        }

        return {
          submissionId: x.submissionId,
          url: x.url,
          submittedAt: x.submittedAt,
          creatorStanding: standingFor(x.creatorId, theirs, this.store).standing,
          verdict: verdict ? (verdict.pass ? 'pass' : 'fail') : 'not judged yet',
          verdictConfidence: verdict ? verdict.confidence : null,
          verdictReason: verdict?.reasons?.[0],
          state: st,
          paidUsdc: paidFor?.amountUsdc.toString() || '0.00',
        };
      });

      totalCommittedMicro += committedMicro;

      const funding = this.balances
        ? await fundingFor(c, new Decimal(Number(spentMicro) / 1_000_000), this.balances, this.otherClaimsOn(c))
        : undefined;

      const perCreatorSpend = Array.from(perCreatorMap.values()).map((pc) => ({
        creatorId: pc.creatorId,
        spentUsdc: (Number(pc.spentMicro) / 1_000_000).toFixed(2),
        submissionsCount: pc.submissionsCount,
      }));

      const refusals = Array.from(campaignRefusalsMap.entries()).map(([r, count]) => ({ reason: r, count }));
      const remainingMicro = c.poolUsdc.micro - spentMicro;

      // No fallback. This read the operator's own address when a campaign had
      // no wallet, so an unfunded campaign displayed the treasury as its
      // funding wallet — the operator saw an address backed by our balance and
      // had no way to tell it apart from a brand that had actually deposited.
      const fundingWalletAddr = c.fundingWallet ?? null;

      return {
        campaignId: c.campaignId,
        ownerId: c.ownerId,
        brief: c.brief,
        status: c.status,
        poolUsdc: c.poolUsdc.toString(),
        spentUsdc: (Number(spentMicro) / 1_000_000).toFixed(2),
        committedUsdc: (Number(committedMicro) / 1_000_000).toFixed(2),
        remainingUsdc: (Number(remainingMicro) / 1_000_000).toFixed(2),
        rateBand: { minUsdc: c.rateBand.minUsdc.toString(), maxUsdc: c.rateBand.maxUsdc.toString() },
        fundingWallet: fundingWalletAddr,
        cpmUsdc: c.cpmUsdc.toString(),
        perCreatorCapUsdc: c.perCreatorCapUsdc.toString(),
        dwellMs: c.dwellMs,
        dwellHours: Math.round(c.dwellMs / 3_600_000),
        minStanding: c.minStanding,
        submissionsCount: subs.length,
        creatorsCount: new Set(subs.map((x) => x.creatorId)).size,
        payoutsCount: paid.length,
        viewsPaid: viewsPaid.toString(),
        funding: funding && { coverage: funding.coverage, fundedUsdc: funding.fundedUsdc, summary: funding.summary },
        perCreatorSpend,
        refusals,
        received,
        endsAt: c.endsAt,
      };
    }));

    const totalRemainingMicro = totalPoolMicro - totalSettledMicro;
    const burnRatePct = totalPoolMicro > 0n ? Math.min(100, Number((totalSettledMicro * 100n) / totalPoolMicro)) : 0;
    const globalRefusals = Array.from(globalRefusalMap.entries()).map(([r, count]) => ({ reason: r, count }));
    const allCreatorsEngaged = new Set(mine.flatMap((c) => state.submissions.filter((x) => x.campaignId === c.campaignId).map((x) => x.creatorId))).size;

    return Response.json({
      brand: {
        brandId: brand.brandId,
        company: brand.company,
        contactEmail: brand.email,
        ownerAddress: '0x0003a59858f44451be2a5b486ee612b4139700f0',
        verified: true,
        joinedAt: brand.approvedAt,
      },
      campaigns,
      spendEngine: {
        totalPoolUsdc: (Number(totalPoolMicro) / 1_000_000).toFixed(2),
        committedUsdc: (Number(totalCommittedMicro) / 1_000_000).toFixed(2),
        settledUsdc: (Number(totalSettledMicro) / 1_000_000).toFixed(2),
        remainingUsdc: (Number(totalRemainingMicro) / 1_000_000).toFixed(2),
        burnRatePct,
        coverage: campaigns.every((c) => c.funding?.coverage === 'covered') ? 'funded' : 'partially_funded',
        creatorsEngaged: allCreatorsEngaged,
        viewsPaid: totalViewsPaid.toString(),
      },
      refusalsSummary: globalRefusals,
      totals: {
        campaigns: campaigns.length,
        spentUsdc: (Number(totalSettledMicro) / 1_000_000).toFixed(2),
        creators: allCreatorsEngaged,
        submissions: campaigns.reduce((a, c) => a + c.submissionsCount, 0),
      },
    });
  }

  async handleBrandEnquiry(request: Request): Promise<Response> {
    const clientIp = request.headers.get('x-forwarded-for') ?? 'anonymous';
    if (!this.rateLimiter.consume(clientIp)) {
      return Response.json({ error: 'Too many submissions — try again shortly.' }, { status: 429 });
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    // Before parsing, so a bot never reaches the webhook fan-out.
    const challenge = await this.turnstile.check(
      body.turnstileToken ?? body['cf-turnstile-response'],
      clientIp === 'anonymous' ? undefined : clientIp.split(',')[0]?.trim(),
    );
    if (!challenge.ok) {
      return Response.json(
        { error: `Could not verify you are human — ${challenge.reason}. Please try again.`,
          field: 'turnstile' },
        { status: 403 },
      );
    }

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
      // Shape, not identity: who they are stays in the enquiry record.
      void this.analytics.identify(enquiry.email, {
        $email: enquiry.email,
        $name: enquiry.name,
        website: enquiry.website || undefined,
        role: 'brand',
        budget: enquiry.budget,
        companyDomain: enquiry.companyDomain,
      });
      void this.analytics.capture({
        event: 'brand_enquiry_received',
        distinctId: enquiry.email,
        properties: {
          budget: enquiry.budget,
          wantsAgency: enquiry.wantsAgency,
          hasWebsite: Boolean(enquiry.website),
          companyDomain: enquiry.companyDomain,
          challenged: challenge.checked,
        },
      });
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

  /**
   * An agent opens its own campaign and funds it itself.
   *
   * Public, unlike the operator route, because what made that route privileged
   * was that it committed *our* money. Here the pool is the caller's, the
   * campaign is invisible until their deposit confirms on-chain, and it can
   * pay nobody until then — so the thing the gate protected is protected by
   * the chain instead of by a person.
   *
   * Rate-limited, because free campaign creation is free log writes. A refused
   * caller is told to wait rather than quietly dropped.
   */
  async handleAgentCampaign(request: Request): Promise<Response> {
    const clientIp = request.headers.get('x-forwarded-for') ?? 'anonymous';
    if (!this.rateLimiter.consume(clientIp)) {
      return Response.json({ error: 'too many campaigns opened — try again shortly' }, { status: 429 });
    }
    await this.ready();

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const result = openCampaign({ ...body, selfServe: true }, new Date(), this.enabledPlatforms);
    if (!result.ok) {
      return Response.json({ error: result.error, field: result.field }, { status: 400 });
    }

    const campaign = result.value;
    if (!campaign.fundingWallet) {
      return Response.json(
        { error: 'fundingWallet is required — it is the address you deposit to, and the one we read',
          field: 'fundingWallet' },
        { status: 400 },
      );
    }

    const unsignable = this.unsignable(campaign.fundingWallet);
    if (unsignable) {
      return Response.json({ error: unsignable, field: 'fundingWallet' }, { status: 400 });
    }

    // 'circle-agent-wallet' only when we know it is one — having passed the
    // guard above means it is on this deployment's signable list. With no rail
    // configured the guard is silent and we know nothing, so the label stays
    // the weaker one rather than claiming custody we cannot demonstrate.
    const bound = this.cluster.register(
      campaign.campaignId,
      campaign.fundingWallet,
      this.signable.size > 0 ? 'circle-agent-wallet' : 'operator-supplied',
    );
    if (!bound.ok) {
      return Response.json({ error: bound.error, field: bound.field }, { status: 409 });
    }

    await this.record({ type: 'campaign_upserted', campaign });
    return Response.json(
      {
        campaignId: campaign.campaignId,
        status: campaign.status,
        depositTo: campaign.fundingWallet,
        chain: campaign.chain,
        poolUsdc: campaign.poolUsdc.toString(),
        next: `Send ${campaign.poolUsdc} USDC to ${campaign.fundingWallet} on ${campaign.chain}, `
          + 'then call check_campaign_funding. It goes live the moment coverage confirms — '
          + 'no approval step. Creators cannot see it until then.',
      },
      { status: 201 },
    );
  }

  async handleOpenCampaign(request: Request): Promise<Response> {
    const guard = this.requireOperator(request);
    if (guard) return guard;
    await this.ready();

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const result = openCampaign(body, new Date(), this.enabledPlatforms);
    if (!result.ok) {
      return Response.json({ error: result.error, field: result.field }, { status: 400 });
    }

    // One wallet backs one campaign. Enforced here rather than left to the
    // coverage arithmetic to notice later: two campaigns behind one address
    // each read the same balance as their own funding, and the inflated
    // "budget left" reaches creators before anyone reconciles it.
    if (result.value.fundingWallet) {
      // Same guard as the agent route. An operator can still open a campaign
      // with no wallet at all and attach one later; what they cannot do is
      // name one this deployment could never pay from.
      const unsignable = this.unsignable(result.value.fundingWallet);
      if (unsignable) {
        return Response.json({ error: unsignable, field: 'fundingWallet' }, { status: 400 });
      }

      const bound = this.cluster.register(
        result.value.campaignId,
        result.value.fundingWallet,
        this.signable.size > 0 ? 'circle-agent-wallet' : 'operator-supplied',
      );
      if (!bound.ok) {
        return Response.json({ error: bound.error, field: bound.field }, { status: 409 });
      }
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
        // Both of these exist so the caller cannot mistake creation for launch.
        // The campaign is not visible to creators yet, and this is where the
        // money has to land before it can be.
        status: c.status,
        fundingWallet: c.fundingWallet,
        next: 'Fund the wallet, then POST /api/campaigns/:id/check-funding and '
          + '/api/campaigns/:id/approve. Creators cannot see this campaign until it is live.',
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

      // One place, so the web form and the MCP tool are counted the same way
      // and neither can drift. `isNew` distinguishes a first submission from a
      // resubmission of the same clip, which dedupes rather than erroring —
      // counting those as new would inflate the top of the funnel with people
      // clicking twice.
      void this.analytics.capture({
        event: 'clip_submitted',
        distinctId: `creator:${creator.payoutAddress.toLowerCase()}`,
        properties: {
          campaignId: submission.campaignId,
          platform: submission.platform,
          firstTime: isNew,
          cpmUsdc: Number(terms.cpmUsdc.toString()),
          dwellHours: Math.round(terms.dwellMs / 3_600_000),
        },
      });

      // Spend authority for this creator, bounded by the terms just frozen.
      //
      // Issued here rather than granted broadly, because this is the moment the
      // obligation is created: an operator already approved this campaign, the
      // chain already confirmed USDC behind its pool, and the clip has been
      // accepted under caps the campaign itself set. The mandate encodes that
      // and nothing wider — capped at the per-creator cap, expiring with the
      // settlement window, naming the campaign it came from.
      //
      // It does not widen anything above it: the absolute per-payment ceiling,
      // the pool, and the rolling velocity limit all still apply, and none of
      // them can be raised by a mandate.
      if (isNew && campaign
        && !this.mandates.liveMandateFor(creator.payoutAddress, { agentId: '*' })) {
        const expiresInDays = Math.max(
          1, Math.ceil(campaign.settlementWindowMs / 86_400_000),
        );
        const mandate = issueMandate({
          counterparty: creator.payoutAddress,
          maxPerPaymentUsdc: terms.perCreatorCapUsdc,
          issuedBy: 'campaign-acceptance',
          reason: `clip accepted into ${submission.campaignId}, which an operator `
            + 'approved after its pool was confirmed on-chain',
          expiresInDays,
        });
        await this.record({ type: 'mandate_issued', mandate });
        // Into the live store as well as the log. `record` applies to
        // this.store, and the policy engine reads this.mandates — without this
        // the authority only became usable after the next cold start, so the
        // instance that accepted the clip still could not pay for it.
        this.mandates.put(mandate);
      }

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

  /**
   * What other campaigns behind the same wallet still expect it to pay.
   *
   * A wallet backing two live pools cannot honour both, but `fundingFor`
   * compares its balance against one pool at a time — so each would read
   * "fully funded" against the same dollars. Netting the other outstanding
   * pools off first makes coverage mean "backing available to this campaign".
   *
   * Only launched campaigns count. A draft sitting behind the same address has
   * promised nothing to anyone yet, and treating it as a claim would understate
   * a wallet that is genuinely funded.
   */
  private otherClaimsOn(campaign: Campaign): Decimal {
    const wallet = campaign.fundingWallet?.toLowerCase();
    if (!wallet) return new Decimal(0n);

    let micro = 0n;
    for (const other of this.store.exportState().campaigns) {
      if (other.campaignId === campaign.campaignId) continue;
      if (other.fundingWallet?.toLowerCase() !== wallet) continue;
      if (!isLaunched(other.status)) continue;
      // What it still owes, not what it started with: money already paid out
      // has left the wallet and is reflected in the balance we just read.
      const remaining = other.poolUsdc.micro - this.store.spentOnCampaign(other.campaignId).micro;
      if (remaining <= 0n) continue;
      micro += other.status === 'ended' ? this.endedCeiling(other, remaining) : remaining;
    }
    return new Decimal(micro);
  }

  /**
   * Why this deployment cannot settle from `address`, or undefined if it can.
   *
   * Checked at creation rather than at settlement because of when each one
   * hurts. At settlement the brand has already deposited and creators have
   * already made clips against a brief they were shown — the money is stuck
   * and the work is done. At creation nothing has happened yet and the caller
   * can pick a different wallet.
   *
   * Silent when the deployment has no settlement rail at all: it pays nobody
   * from any address, so singling this one out would be misleading.
   */
  private unsignable(address: string): string | undefined {
    if (this.signable.size === 0) return undefined;
    if (this.signable.has(address.trim().toLowerCase())) return undefined;
    return (
      `we cannot sign for ${address}, so a campaign funded there could take your deposit `
      + 'and never pay a creator. Use a wallet provisioned for this deployment, or ask the '
      + 'operator to provision one — funding a campaign is not the same as us being able to '
      + 'spend from it.'
    );
  }

  /**
   * The most an *ended* campaign can still draw from its funding wallet.
   *
   * A live campaign reserves its whole remaining pool, because any of it might
   * still be claimed by a clip nobody has submitted yet. An ended campaign
   * cannot: it accepts no new clips, so the only claims left are the creators
   * who already have accepted clips, and each of those is capped at the
   * per-creator limit. Reserving the full pool for them would strand the
   * difference — a 100 USDC campaign that ends owing one creator capped at 10
   * would hold 90 USDC hostage against every other campaign on that wallet.
   *
   * Still bounded by `remaining`: the ceiling is what the campaign could owe,
   * never more than it has left to give.
   */
  private endedCeiling(campaign: Campaign, remaining: bigint): bigint {
    const creators = new Set(
      this.store
        .exportState()
        .submissions.filter((s) => s.campaignId === campaign.campaignId)
        .map((s) => s.creatorId),
    );

    let ceiling = 0n;
    for (const creatorId of creators) {
      const headroom = campaign.perCreatorCapUsdc.micro
        - this.store.spentOnCreator(campaign.campaignId, creatorId).micro;
      if (headroom > 0n) ceiling += headroom;
    }
    return ceiling < remaining ? ceiling : remaining;
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
      ? await fundingFor(campaign, spent, this.balances, this.otherClaimsOn(campaign))
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

    // The deposit landing is what advances the campaign, and it advances it to
    // a queue rather than to live. Coverage is a fact about the chain; going
    // live is a decision, and this is the seam between them.
    //
    // Only from pending_funding. A campaign an operator already approved, or
    // paused, is not dragged back into the queue by a later balance read.
    // A self-serve campaign goes straight live; an operator-opened one queues.
    //
    // The approval step exists because coverage is a fact about the chain and
    // launching is a decision about whose brief reaches our creators. When an
    // agent funds its own campaign it has made that decision with its own
    // money, so there is no second judgement left for a human to add — and a
    // queue nobody needs is just a campaign that never opens.
    //
    // Nothing else is relaxed. The pool minimum, the brief screen, wallet
    // exclusivity and every payout gate apply exactly as before, and an
    // unfunded self-serve campaign is as invisible as any other.
    let advanced = false;
    let becomes: CampaignStatus | undefined;
    if (campaign.status === 'pending_funding' && funding.coverage === 'covered') {
      becomes = campaign.selfServe ? 'active' : 'awaiting_operator_approval';
      await this.record({
        type: 'campaign_upserted',
        campaign: { ...campaign, status: becomes },
      });
      advanced = true;
    }

    // `live` is a fact about the campaign, `advanced` is a fact about this
    // call. Reading `becomes === 'active'` conflated them: `becomes` is only
    // set when this call moved the campaign, so polling a campaign that was
    // already live answered `live: false` — and an agent deciding whether to
    // send creators at it reads exactly this field.
    const status = becomes ?? campaign.status;
    return Response.json({
      ok: true,
      funding,
      status,
      live: status === 'active',
      advanced,
    });
  }

  /**
   * Take a funded campaign live. Operator-gated, deliberately.
   *
   * Two things have to be true and they are different in kind: the money is
   * there, which the chain answers, and somebody is willing to publish this
   * brief to creators, which only a person answers. Auto-activating on a
   * confirmed deposit would collapse the second into the first and make the
   * approval step decorative.
   *
   * Refuses unless coverage is `covered` at the moment of approval, so an
   * operator cannot approve a campaign whose money left after the deposit
   * was first seen.
   */
  async handleApproveCampaign(request: Request, campaignId: string): Promise<Response> {
    const guard = this.requireOperator(request);
    if (guard) return guard;
    await this.ready();

    const campaign = this.store.campaign(campaignId);
    if (!campaign) return Response.json({ error: 'unknown campaign' }, { status: 404 });

    if (campaign.status === 'active') {
      return Response.json({ ok: true, status: 'active', note: 'already live' });
    }
    if (campaign.status !== 'awaiting_operator_approval') {
      // Said in words, because this reaches a person in a modal. `campaign is
      // pending_funding` tells them the enum, not what to do about it.
      const WHY: Record<string, string> = {
        pending_funding:
          'This campaign is still waiting on its deposit. Fund the wallet, check the balance, then open it.',
        paused: 'This campaign is paused. Resume it rather than opening it again.',
        ended: 'This campaign has ended.',
        draft: 'This campaign is still a draft.',
      };
      return Response.json(
        {
          error: WHY[campaign.status] ?? `This campaign is ${campaign.status} and cannot be opened.`,
          status: campaign.status,
        },
        { status: 409 },
      );
    }

    // Fails closed, like the tick and the operator gate. A deployment with the
    // balance reader switched off cannot tell a funded pool from an empty one,
    // and "we could not check" must not be spent as if it were "the money is
    // here" — that is the whole failure this gate exists to prevent.
    if (!this.balances) {
      return Response.json(
        {
          error: 'no balance reader configured — refusing to open a campaign we cannot verify',
          fix: 'unset CAMPAIGN_BALANCE_READER=off so the pool can be checked on-chain',
        },
        { status: 503 },
      );
    }

    const spent = this.store.spentOnCampaign(campaignId);
    const funding = await fundingFor(campaign, spent, this.balances, this.otherClaimsOn(campaign));
    if (funding.coverage !== 'covered') {
      return Response.json(
        {
          error: 'The pool is not covered on-chain, so this campaign will not open.',
          coverage: funding.coverage,
          summary: funding.summary,
        },
        { status: 409 },
      );
    }

    await this.record({
      type: 'campaign_upserted',
      campaign: { ...campaign, status: 'active' },
    });
    return Response.json({ ok: true, status: 'active', campaignId });
  }

  /**
   * Take a published campaign down.
   *
   * Nothing could do this. A campaign that turned out to be abusive, or a
   * brief that should never have gone out, stayed live and kept accepting
   * clips — there was no lever at all, which is a poor answer to "what happens
   * when something bad gets published".
   *
   * Ending refuses *new* clips. It does not abandon work already accepted:
   * terms were frozen at acceptance and the settlement window is an obligation
   * to the creator, not a convenience for us. A creator who edited last night
   * against a brief we later regret is still owed, and the tick keeps settling
   * ended campaigns for exactly that reason. Anything else would make "your
   * rate is locked" a lie the first time it was tested.
   *
   * There is nothing to refund. The pool never left the funder's wallet — we
   * read its balance, we do not hold it — so ending simply stops us reading it,
   * and the money is already where it started.
   */
  async handleEndCampaign(request: Request, campaignId: string): Promise<Response> {
    const guard = this.requireOperator(request);
    if (guard) return guard;
    await this.ready();

    const campaign = this.store.campaign(campaignId);
    if (!campaign) return Response.json({ error: 'unknown campaign' }, { status: 404 });
    if (campaign.status === 'ended') {
      return Response.json({ ok: true, status: 'ended', note: 'already ended' });
    }

    const body = (await request.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

    await this.record({ type: 'campaign_upserted', campaign: { ...campaign, status: 'ended' } });
    this.cluster.release(campaignId);

    const owed = this.store
      .exportState()
      .submissions.filter((x) => x.campaignId === campaignId).length;

    return Response.json({
      ok: true,
      status: 'ended',
      campaignId,
      reason: reason || undefined,
      acceptedClipsStillOwed: owed,
      note: 'No new clips are accepted. Clips already accepted keep their frozen terms and '
        + 'settle as their views survive. Nothing is refunded because the pool never left the '
        + "funder's wallet.",
    });
  }

  /**
   * Settlements to one payout address.
   *
   * Public, because the address is the identity here and every payout is on a
   * public chain already — withholding it would protect nothing and would stop
   * an agent following up on a clip it submitted.
   */
  publicPayoutsFor(payoutAddress: string): Array<Record<string, string | undefined>> {
    const wallet = payoutAddress.trim().toLowerCase();
    return this.store
      .exportState()
      .payouts.filter((p) => p.creatorId.toLowerCase() === wallet)
      .map((p) => ({
        campaignId: p.campaignId,
        submissionId: p.submissionId,
        amountUsdc: p.amountUsdc.toString(),
        viewsPaidTo: p.viewsPaidTo.toString(),
        settledAt: p.at,
        txHash: p.txHash,
      }));
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


