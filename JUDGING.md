# For judges

A working instance is at **https://merlinclips.com**. Nothing below needs a
login, an API key, or a build step.

## What this is

Brands pay creators for views on short clips. Every platform in this category
pays on a number the person being paid can buy for less than the payout, so
detection loses by construction — the money moves before anyone can tell.

We changed what is being bought. Views are counted, counted again after a
waiting period, and payment is made on **the lowest figure observed across the
window**. Inflating a count is cheap. Keeping it inflated through a platform's
own retroactive removal for a full day is somebody else's expensive problem.

## The agent, and what it is not allowed to do

An LLM decides whether a clip meets the brief. It cannot decide whether money
moves.

```
creator submits a clip
        │
        ▼
  Gemini watches it, judged against the brief the brand wrote
        │
        ▼
  view oracle reads the count from the platform, never from the creator
        │
        ▼
  the gate — deterministic, no model, no network, no configurable strictness
        │
        ├── settle    within budget, cap, and the wait
        ├── hold      the wait has not closed
        └── refuse    named reason, recorded
        │
        ▼
  USDC leaves the brand's wallet for the creator's, via the Circle CLI
```

An agent that can be talked into *proposing* a payment is expected and
survivable. One that can be talked into *approving* one is not. That single
idea is the architecture.

**No human is in this path.** Cloud Scheduler fires hourly, the pass runs, the
money moves or does not. Nobody clicks pay.

## Circle, and where it is load-bearing

| Piece | Where |
|---|---|
| Agent wallet, USDC transfer | `src/campaign/executor.ts` — `circle wallet transfer` with an idempotency key derived from the submission and view count, so a replayed pass cannot pay twice |
| x402 | `src/x402.ts`, served at `POST /api/job` — a buying agent pays ours over HTTP 402 |
| USDC balance verification | `src/campaign/balances.ts` — reads the chain so a published budget is checked rather than asserted |

Both directions of the Agent Stack: the agent **disburses** to creators and
**receives** for services.

## Things worth clicking

| | |
|---|---|
| The product | https://merlinclips.com/app |
| How a payout is decided | https://merlinclips.com/architecture.html |
| Threat model, 21 invariants | https://merlinclips.com/security.html |
| How it is tested | https://merlinclips.com/testing.html |
| API reference | https://merlinclips.com/api.html |
| Live campaign state | https://merlinclips.com/api/campaign |

## Verifying the claims

**That refusals are real, not decorative.** `GET /api/campaign` returns the
last pass. A payout inside its waiting period reports `dwell_unmet` with the
reason in words, and the same engine settles it once the wait closes.

**That the model genuinely judges.** Submit a clip that does not match a
brief. The refusal names timestamps — in testing it declined one with *"only a
title card is shown from 00:00 to 00:03, the subject does not appear until
approximately 00:40."*

**That the record cannot be quietly edited.** Every snapshot, verdict and
payout is appended to a log whose hash chain is derived on read. Altering a
past entry breaks verification of every entry after it. This is
*tamper-evident*, not immutable — someone with write access can still truncate
a file, and we would rather say so.

**That the tests mean something.** 527 tests, and a mutation harness that
breaks a guard on purpose to confirm a test fails. A guard nobody has tried to
break is a guard nobody has tested.

## What we do not claim

We do not out-detect fraud farms. We changed what gets bought so outlasting
them is unnecessary — a different claim, and the honest one.

An account raises the cost of farming the per-creator cap across many wallets.
It does not remove it. Google accounts are cheap too.

Chain verification under concurrent appends is unproved, and fault injection
between reserving and committing is not yet covered by a test. Both are named
on the architecture page rather than left for someone to find.

## Running it yourself

```
bun install
bun test
bun run src/server.ts
```

No build step, no bundler, no runtime dependencies in the payout path. The
whole deployment is `bun run src/server.ts` on Cloud Run.
