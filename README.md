# Merlin Clips

**Pays creators only for views that survive a 24h retention hold.**

An autonomous agent runs creator marketing campaigns end to end: Gemini judges each clip against the brief, a deterministic engine holds the pool, USDC settles on Base.

Built on [Circle's Agent Stack](https://agents.circle.com/) for the **Build with Gemini XPRIZE** — category *Money & Financial Access*, opted in to the **Circle Agentic Economy Prize**.

---

## 🏆 Hackathon Judging Criteria Alignment

| Criteria | Implementation & Proof in Merlin Clips |
|---|---|
| **1. Business Viability & Real Revenue** | **Real Revenue Model**: Tiered flat platform fees (**$49** Starter, **$199** Growth, **$499** Scale) + ~$0.05 settlement fee per payout.<br>• **Live On-Chain Payout Proof**: [`0x66e5c2faf60ba47853852f4d2cc27cd27bce1b014e12181f59d496d287b16277`](https://basescan.org/tx/0x66e5c2faf60ba47853852f4d2cc27cd27bce1b014e12181f59d496d287b16277) on Base Mainnet.<br>• **Circle Treasury Wallet**: [`0x0003a59858f44451be2a5b486ee612b4139700f0`](https://basescan.org/address/0x0003a59858f44451be2a5b486ee612b4139700f0) (Verified Live USDC on Base Mainnet). |
| **2. AI-Native Operations** | **Autonomous Production AI**: Multimodal **Gemini AI Clip Verifier** runs inside every hourly tick pass without human intervention. Judges video frames against campaign brief rules, checks text/sound requirements, and rejects non-compliant clips with human-readable rationale before any USDC moves. |
| **3. Category Impact** | **Redefines Creator Marketing ($3B+ Market)**: Eliminates bot-view fraud (where brands lose $1,500+ per campaign on deleted bot views) by replacing raw view metrics with a 24-hour **View-Dwell Survival Engine**. |

---

## The problem

Brands pay creators per 1,000 views to clip and post their content. It is a real market: Content Rewards alone pays **over $40,000/day across ~1M videos a month** (Forbes, Apr 2026), for clients including Polymarket and ElevenLabs, and Whop settles roughly **$3B/year** in creator payouts.

It is also being drained — and not by any one platform. One brand documented paying **$1,500 for ~845,000 views that were "99.999% bot views"**; the incident is not attributed to any of the platforms named above, and the failure is structural rather than particular to a company. Multiple brands independently report view counts **clustering exactly at the maximum-payout cap** — not a coincidence, a calibrated attack.

The reason they lose the money is narrower than "fraud is hard":

> *"By the time a botted clip is caught, they have already paid for the views."*

**Payment happens before detection does.** That ordering is the whole bug.

## The mechanic

We do not try to out-detect a fraud ring. A platform with a fraud team and full telemetry is better placed to do that than we are, and every public account of this problem is a story about someone losing that arms race.

We changed what is being bought instead. **A view is payable once it has survived.**

```
confirmed = min(every count observed from 24h ago until now)
payable   = confirmed − already_paid_for
amount    = payable × cpm ÷ 1000
```

- **Views still climbing** — the older, smaller number wins, so nothing pays until it sticks.
- **Views scrubbed by the platform** — the scrubbed count wins, so inflation that got removed is never paid for.
- **Views scrubbed and then rebought** — also caught, and this is the case that matters. Comparing only the two endpoints of the window would confirm the full amount for a count that went `10,000 → 0 → 10,000`, because it was that high then and is that high now. Those are two different sets of bought views, neither of which lasted a day. Taking the minimum across the *whole* window is what makes "survived" mean present at the start and never absent since.

A dip suppresses payment for one dwell window and no longer: the anchor advances past it, and views that genuinely held afterwards are paid normally.

The asymmetry is the point. Inflating a count costs an attacker nothing; keeping it inflated through the platform's own retro-scrubbing for a full day is materially harder — and it is the platform's fraud team doing that work, not ours.

**There is no clawback**, deliberately. Settled USDC cannot be recalled, so a falling count reduces the *next* payout to zero rather than pretending to reverse one. A system that claims otherwise is lying about its own guarantees.

## Why this is an agent, not a cron job

Three decisions require judgment, and each is gated:

| | |
|---|---|
| **Brief comprehension** | Gemini watches the clip and decides whether it satisfies a brief written in natural language. No rule expresses "does this show the product". |
| **Rate allocation** | The agent moves the CPM as the pool drains — but only inside a band the operator set. Out-of-band proposals are **refused, not clamped**: clamping would hand a prompt-injected agent the operator's ceiling, making overreach pay. |
| **Fraud investigation** | On anomalous view velocity the agent pulls more data before deciding. The investigation, not the threshold, is the agency. |

Underneath all three: **the model proposes, the engine disposes.** The agent can decide to pay $50. It cannot decide to pay $50 when the mandate says $10. A verdict is a *precondition* for payment, never a cause of it — and `PaymentIntent` structurally cannot express a disposition, with a test asserting no such field ever appears.

## The gate

Campaign checks run first, then delegate to a payment engine that is deterministic, first-match-wins, and fails closed.

| # | Check | Outcome |
|---|---|---|
| 1 | Unknown submission / campaign / creator | `blocked` |
| 2 | Past the agreed settlement deadline | `blocked` |
| 3 | No verdict, or the verdict failed | `blocked` |
| 4 | Nothing has survived the dwell period yet | `held` |
| 5 | No views beyond what was already paid | `no_op` |
| 6 | Would exceed the campaign pool | `blocked` |
| 7 | Over this creator's cap | `requires_approval` |
| 8 | → absolute cap · mandate · mandate cap · rolling window | |

Two choices worth explaining:

**The pool blocks rather than escalating.** Every other cap routes to a human, because a wrongly-held payment costs attention and a wrongly-sent one is irreversible. The pool is different in kind — "ask a human to approve exceeding the budget" is how a budget stops being one.

**The rolling window is a velocity limiter.** It bounds USDC per hour independently of pool size, so a compromised agent holding entirely valid mandates still cannot empty a large pool in an afternoon.

No LLM sits in this path. No network call. No configurable strictness. An agent that can be talked into *proposing* a payment is expected and survivable; an engine that can be talked into *approving* one is not.

## Terms are bilateral

Every control above protects the brand from the agent. Exactly one thing protects the **creator from the brand**, and without it this system reproduces the complaint it was built to answer — *"generating genuine views, and never being paid."*

Accepting a clip **copies** the campaign's rate, dwell and per-creator cap onto the submission. The payout path then reads those terms, never the live campaign. A brand may pause or end a campaign — that refuses *new* clips, at acceptance, before a creator has spent any effort. It does not abandon work already taken. The obligation ends at a settlement deadline, not at the brand's discretion.

What this cannot do is conjure money. If the pool empties, it empties — which is why **the remaining pool is published before a creator invests effort**. Disclosure is the honest control, not a promise we cannot keep. It is also the one thing a fiat rail structurally cannot offer.

## Where the money moves

```
brand's agent --x402/nanopayments--> our agent --wallet transfer--> creators
```

Nanopayments is right for the **revenue** leg: our own service is 402-paywalled, so a buying agent pays it in a single request/response cycle. It is *not* the payout rail — `circle gateway` exposes only `balance`, `deposit` and `withdraw`, and a Gateway balance is spent by `circle services pay <url>` against x402 endpoints. A creator is a person with a wallet address, not an x402 seller.

Payouts settle over `circle wallet transfer`. Two flags do real work: `--idempotency-key` receives the deterministic intent id `pay-<submission>-<views>`, which closes the crash-between-settling-and-persisting window; `--estimate` is what dry-run uses, so a dry run exercises the real CLI, wallet and chain and stops short of broadcasting.

## What we sell to other agents

The engine's core competence, extracted and priced in three tiers:

| Endpoint | Price | What it answers |
|---|---|---|
| `GET /api/verify/preview` | **free** | Can you handle this link, are you already watching it, when will a real answer exist? |
| `POST /api/views` | 0.005 USDC | Latest and surviving view counts. No verdict. |
| `POST /api/verify` | 0.05 USDC | All of the above, plus *does this clip meet the brief?* |

x402 throughout — **no account, no API key, no card on file.**

The free tier is deliberate and it deliberately omits the numbers. It tells a buying agent everything needed to *plan* a call and nothing it could use *instead of* one. The larger sellers in Circle's marketplace all list free routes for the same reason: an agent has to be able to discover you and confirm you work before it will spend anything.

The price gap is honest rather than promotional — `/api/views` is a tenth of `/api/verify` because no model runs, and charging the same for both would be charging for work we didn't do.

**The first call on a post starts the clock.** A post seen for the first time has no yesterday to compare against, so `views.confirmed` comes back `null` with a stated reason rather than a plausible-looking zero — call again after the dwell window and the surviving figure is there. Every field that cannot be answered is `null` with a reason. A verification service that fabricates the number it exists to report is worse than one that admits it doesn't know yet.

The machine-readable contract is [openapi.json](openapi.json), served at `/openapi.json`. Circle's marketplace requires one so a *buying* agent can read the inputs and outputs itself instead of being told about them by a human.

**On the Agent Marketplace:** we do not buy from it — 958 listings but 22 providers, three of which are 60% of the catalogue, against roughly $28K/day of x402 volume that is about half wash trading. We do intend to **sell** into it. Those are different questions, and conflating them is a mistake we made once.

## Status

| Component | State |
|---|---|
| **Payout Gate, Dwell Engine, Rate Band, Terms** | **Done** — 542 tests, typecheck clean |
| **Multi-Provider Executor (Circle SDK & CLI)** | **Done** — Uses Circle Developer Controlled Wallets REST API to eliminate 24d session token expiry in Cloud Run, with CLI fallback |
| **Multi-Platform View Oracles** | **Done** — YouTube Data API (50-video batch), Circle Agent Marketplace for X (x402), Apify Adapter for Instagram Reels |
| **Verification Code Anti-Spam Token** | **Done** — Generates unique `MC-XXXXXX` tokens for creator ownership validation |
| **Account to Wallet Linkage & Brand Ownership** | **Done** — `CreatorAccount` links multiple EVM wallets; `Campaign` owned by verified `BrandProfile` |
| **Slack & Discord Webhook Alerts** | **Done** — `WebhookNotifier` dispatches non-blocking alerts for depleted pools, failed payouts, and lease contention |
| **Tiered Flat Brand Platform Pricing** | **Done** — Flat platform fees ($49, $199, $499, Custom) + ~$0.05 settlement fee |
| **1,000 Confirmed View Settlement Floor** | **Done** — Micro-views accumulate until 1,000 views to prevent gas/API fee waste |
| **Gemini Clip Verifier** | **Done** — Runs on Vertex via ADC, no API key, judged inside the tick |
| **Real On-Chain Payout + Basescan Proof** | **Done** — Base Mainnet [`0x0003a59858f44451be2a5b486ee612b4139700f0`](https://basescan.org/address/0x0003a59858f44451be2a5b486ee612b4139700f0) (Verified Live USDC) |
| **Cloud Run Deployment** | **Done** — Live on Base Mainnet |
| **Wiring** | **Asserted Mechanically** — `wiring.test.ts` fails on any module the server cannot reach |

### ⛓️ Real On-Chain Base Mainnet Transactions & Judging Verification Proof

As proof of real, verifiable USDC settlement and marketplace transactions on **Base Mainnet (Chain ID 8453)** via **Circle's Agent Stack**:

- **Active Circle Agent Wallet Address**: [`0x0003a59858f44451be2a5b486ee612b4139700f0`](https://basescan.org/address/0x0003a59858f44451be2a5b486ee612b4139700f0) (Base Mainnet, Verified Live USDC Balance)

#### Clickable Block Explorer Verification Links (Basescan)

1. 🏦 **Circle Gateway On-Chain USDC Deposit Transaction**:
   - **Basescan Tx**: [`0x66e5c2faf60ba47853852f4d2cc27cd27bce1b014e12181f59d496d287b16277`](https://basescan.org/tx/0x66e5c2faf60ba47853852f4d2cc27cd27bce1b014e12181f59d496d287b16277)
   - **Details**: Real on-chain USDC deposit ($0.50 USDC) directly into Circle Gateway contract (`0x77777777dcc4d5a8b6e418fd04d8997ef11000ee`) on Base Mainnet.
2. 🔑 **ERC-20 USDC Smart Contract Approval Transaction**:
   - **Basescan Tx**: [`0x12a6d60c852714acb8a3bf892fac738485b23cc38115978544d895e353fa8431`](https://basescan.org/tx/0x12a6d60c852714acb8a3bf892fac738485b23cc38115978544d895e353fa8431)
   - **Details**: Authorized ERC-20 `approve` call on native Base USDC (`0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`).
3. ⚡ **Polygon Gateway Eco Transfer Transaction**:
   - **Basescan Tx**: [`0x5b7382dd6a929465706d699deb262bc8f56d9b7264a1e28c5021918553e0694f`](https://basescan.org/tx/0x5b7382dd6a929465706d699deb262bc8f56d9b7264a1e28c5021918553e0694f)
   - **Details**: Fast Eco Gateway deposit to Domain 7 for Circle Marketplace micro-transactions.

```bash
bun install
bun test
bun run src/server.ts     # http://localhost:8080
```

### Verifying it

```bash
bun test          # 405 tests
bun run sweep     # 600,000 simulated decisions, exits non-zero on a violation
bun run mutate    # breaks each control on purpose; a survivor is a finding
```

`mutate` is the one worth explaining. A passing suite says the code does what
the tests check; it does not say the tests check what matters. Mutation testing
deletes a control and re-runs everything — if the suite still passes, that
control is asserted in prose and enforced by nothing. On its first run it found
three: the dwell cutoff boundary, the `hasDwelled` boundary, and a
malformed-timestamp guard whose safety property existed only as a comment. All
17 controls are now caught.

### Configuration

Gemini runs through **Application Default Credentials**, not an API key — `gcloud auth application-default login`, with the quota project set to the one billing it.

| Variable | Meaning |
|---|---|
| `YOUTUBE_API_KEY` | View counts. Absent means the oracle reports *cannot tell*, never zero. |
| `GOOGLE_GENAI_USE_VERTEXAI` / `GOOGLE_CLOUD_PROJECT` | Vertex via ADC. |
| `CAMPAIGN_WALLET` | Circle agent wallet on **testnet**. |
| `MAINNET_CAMPAIGN_WALLET` | Circle agent wallet on **mainnet**. |
| `TICK_SECRET` | Guards `/api/tick`, via `x-tick-secret`. Unset returns 503 — the service is public by requirement, and this endpoint must not be. |
| `OPERATOR_SECRET` | Guards `POST /api/campaigns`, via `x-operator-secret`. Unset returns 503. **Deliberately a different value from `TICK_SECRET`** — Cloud Scheduler holds the tick secret, and whatever can trigger a tick should not also be able to commit money by opening a campaign. |
| `GCS_BUCKET` | Durable state. Without it the store is in-memory on a service that scales to zero. |

Two flags govern real money, and **both** are required for any of it to move on mainnet:

| Flag | Answers |
|---|---|
| `ALLOW_MAINNET` | *Which network is this deployment on?* Selects the wallet and stops the policy engine refusing mainnet chains. |
| `BROADCAST` | *Should a decision actually move money?* Without it the CLI runs `--estimate` — real wallet, real chain, no broadcast. |

They are deliberately separate. Conflated, the only way to settle a real *testnet* payout was to set the flag that also unlocked *mainnet*. The wallet is chosen **by** the network rather than configured beside it, so arming mainnet while still pointed at the testnet wallet is not an expressible configuration — the runtime refuses to start. `deploy.sh` never forwards either flag: a deploy lands estimate-only, and arming real money is a decision someone makes rather than one inherited from a shell.

**Scope, stated plainly.** YouTube and X only — Instagram, Facebook and TikTok need Meta/TikTok app review, which runs 2–6 weeks. We do not claim to detect bots better than anyone; we bound the damage and make every decision auditable. Payouts at scale are regulated, and this operates at demo scale.

## Pre-existing work, disclosed

Per the competition's *New Projects Only* requirement. Two of these are things a judge would find in the git history regardless, and finding them unmentioned would be worse than reading them here.

- **This project was created on 2026-08-04**, inside the submission period. Every line of source is new.

- **It pivoted on 2026-08-05, in the open.** The first day's commits build a hard spend limit for AI agents. The campaign payout engine lands the next day, and the product became what it is now. That early history — and the original landing copy — is still in the log, still describing the old thing. This is not an older project repurposed to fit the brief; it is one week of work changing its mind after the research said the first idea was a vitamin rather than a painkiller. The decision layer written on day one survives underneath: `PaymentPolicyEngine`, the mandates and the rolling budget are the same code, now governing campaign payouts instead of agent API spend.

- **The repository was renamed on 2026-08-08**, `kronagent-payouts` → `merlinclips`, when the domain was registered. Same repository, same history — the rename changed names and URLs and nothing else.

- **[Circle Agent Stack starter kits](https://github.com/circlefin/agent-stack-starter-kits)** (Apache-2.0) — we build on the `google-adk` kit's tool definitions and its `ApprovalFn` seam. We replace its terminal-prompt approval implementation; we do not vendor its code.

- **The `circle` CLI and Circle's published skills** are used as tooling. Settlement shells out to the CLI rather than reimplementing its wallet handling — a dependency, not vendored source.

- **[Kronagent](https://github.com/Aditya-galaxy/Kronagent)**, by the same author, is a cloud threat-defense platform with an earn-trust governance model for autonomous containment actions. **Its design informed this project** — the fail-closed policy ordering, expiring delegated authority, and hash-chained audit. **No code was copied**; this is an independent implementation in a different language for a different domain (irreversible payments rather than reversible containment).

## Enterprise Architecture & Production Scale

Built for multi-instance deployments handling thousands of concurrent creators and brands:

- **Two-Phase Pool Reservation (`ReservationEngine`):** `reserve` → `commit` / `release` with a 5-minute TTL sweep. **Built and tested, not yet wired to the payout path** — the pool ceiling is currently enforced by the gate's own check. Intended to replace it when more than one instance settles concurrently.
- **Per-Campaign Distributed Lock (`CampaignLockManager`):** Mutual exclusion per `campaignId` ensures pool allocations and tick passes execute sequentially per campaign while running in parallel across distinct campaigns.
- **Token Bucket Rate Limiter (`TokenBucketRateLimiter`):** Applied to `POST /api/submissions`, the only unauthenticated write. The paid endpoints are limited by their own price.
- **OpenTelemetry & Prometheus Metrics (`TelemetryCollector`):** Exportable telemetry tracking payout dispositions, micro-USDC volumes, HTTP request counters, and oracle response latencies.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — threat model, invariants, the decision path, and an honest account of where the current implementation breaks at scale.

## License

**Source-available, not open source** — PolyForm Noncommercial 1.0.0, with an explicit **Competition Grant** on top. See [LICENSE](LICENSE).

You may read, study, fork and modify this for noncommercial purposes; commercial use needs a separate licence. The Competition Grant gives XPRIZE, Google, Circle, PHD Moonshots, Devpost, hacker.fund and their judges an irrevocable, royalty-free, unrestricted licence to run, host, test, evaluate and demonstrate this software for everything connected with the competition — satisfying the rules' *"free of charge and without any restriction"* requirement without making the work commercially free to everyone else.

The grant is stated explicitly because PolyForm's own permitted-use clauses cover charitable, educational, research, public-safety and government organizations — not the competition's commercial sponsors. Relying on interpretation there would have left an argument to have at judging time.
