---
name: merlinclips
description: Launch and manage short-form clip campaigns that pay creators in USDC on Base, only for views that survive a 24-hour retention hold. Use when asked to promote a release with clippers, run a clip campaign, check what a campaign has paid, submit a clip for payment, or understand why a clip was held or refused. Triggers on: clip campaign, clippers, pay creators, short-form promotion, retention hold, USDC payout, bot views.
---

# Merlin Clips

Pays creators per 1,000 views, but only for views that are still there 24 hours
later. That single change is the product: bought views are scrubbed by the
platform before the hold elapses, so nobody is paid for them and nobody buys
them.

Live at `https://merlinclips.com`. MCP endpoint: `https://merlinclips.com/mcp`.

## When to reach for this

- Someone wants a release, launch or product clipped and promoted
- Someone asks what a campaign has actually paid out
- A creator wants to submit a clip and be paid without signing up
- Someone asks why a clip was held, refused, or paid less than expected

## The mechanic, so you can explain refusals correctly

```
confirmed = min(every observation from the anchor until now)
payable   = confirmed - already_paid
amount    = payable x cpm / 1000
```

Observations are hourly. The minimum across the **whole** window is what
catches a count that went up, got scrubbed, and was rebought — comparing only
the endpoints would pay for it.

A clip inside its hold is **waiting, not rejected**. Say it that way; the
distinction matters to the person who made it.

## Tools

Connect to `https://merlinclips.com/mcp` and the tools appear. All are public
except campaign creation, which is operator-gated because declaring a pool
commits real money.

| Tool | What it does |
|---|---|
| `list_open_campaigns` | Campaigns open to creators, with rate, hold and remaining pool. Only funded campaigns appear |
| `submit_clip` | Submit a clip. Keyless — the payout address is the identity |
| `check_campaign_funding` | What is actually on-chain behind a pool |
| `get_ledger` | Every campaign and every settled payout, with its Base transaction |
| `explain_payout_rules` | The gates in order, and what each refusal means |

## Submitting a clip

```
list_open_campaigns          -> pick a campaignId
submit_clip                  -> campaignId, url, payoutAddress
```

The rate, hold and per-creator cap are frozen onto the submission the moment it
is accepted. A brand cannot lower them afterwards. YouTube and X only —
Instagram and TikTok are refused at intake because they need platform app
review we do not hold, and a scraped view count that can be blocked is a payout
that stops silently.

## Reading a result honestly

- `held` — the hold has not elapsed, or the amount is under 1.00 USDC and rolls
  into the next payment. Not a rejection.
- `blocked` with a verdict reason — the clip did not meet the brief. The
  verifier's own words are returned; quote them rather than paraphrasing.
- `no_wallet` coverage — nothing backs that pool. Do not tell a creator it is
  worth their evening.
- An empty ledger means nothing has settled, not that data is missing.

## What this does not do

There is no clawback. Settled USDC cannot be recalled, so a falling view count
reduces the **next** payout rather than reversing one. Any claim otherwise is
wrong about the product.
