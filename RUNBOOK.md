# Getting one real USDC transaction on-chain

The Circle Agentic Economy Prize needs three proofs, and only one of them is
missing: **a recorded demo of at least one real, verifiable USDC transaction**,
plus the wallet address and a block-explorer URL.

Everything else already exists. The repo is public, the agent is autonomous,
and the executor works — it has simply never been allowed to broadcast.

## Where things stand

| | |
|---|---|
| `CAMPAIGN_WALLET` | `0xf461c5bb7e314670ae5c5eeb9929b15728ab2b6c` |
| Balance, Base Sepolia | **19.9975 USDC** — already funded |
| Balance, Base mainnet | 0 |
| `BROADCAST` | not set, so the executor is in dry run |
| `ALLOW_MAINNET` | not set, so testnet only |

**No funding step is needed for testnet.** The wallet has money.

## The steps

Steps 3 and 4 move real money. They are yours to run.

### 1. Open a campaign the wallet can actually cover

A 10 USDC pool sits inside the 19.99 on the wallet, so coverage reads
`covered` rather than `partial` — a demo that shows a fully funded campaign is
a demo with nothing to explain away.

```
BASE=https://merlinclips.com \
OPERATOR_SECRET=<the operator secret> \
DWELL_HOURS=1 \
bun run scripts/seed-demo.ts
```

Then submit a clip through `/app`, or let the script do it. The payout must
clear the **0.25 USDC minimum**, so at 1.00 per 1,000 views the clip needs at
least **250 confirmed views**.

### 2. Wait out the hold

One hour at `DWELL_HOURS=1`. This is not a delay to engineer around — it is
the product, and the demo is stronger for showing a payment that waited.

Meanwhile the hourly scheduler will run passes and hold the payout on
`dwell_unmet`. That is worth recording: a refusal that names its reason is
the same engine that will later approve.

### 3. Let it broadcast  ← moves money

```
gcloud run services update merlinclips \
  --region us-central1 --project merlinclips \
  --update-env-vars BROADCAST=true
```

Testnet only until `ALLOW_MAINNET=true` is also set. Do not set that unless
you intend mainnet.

### 4. Let the agent settle it  ← moves money

Either wait for the hourly scheduler — which is the better demo, because no
human touches it — or trigger a pass:

```
curl -X POST https://merlinclips.com/api/tick -H "x-tick-secret: <the tick secret>"
```

The response carries the decision. A settled payout has
`disposition: "settled"` and a transaction hash.

### 5. Collect the three proofs

```
curl -s https://merlinclips.com/api/campaign | python3 -m json.tool | grep -A4 txHash
```

- **Repo** — https://github.com/Aditya-galaxy/merlinclips
- **Wallet** — `0xf461c5bb7e314670ae5c5eeb9929b15728ab2b6c`
- **Explorer** — `https://sepolia.basescan.org/tx/<hash>`

Confirm the URL loads before submitting. An explorer link that 404s is worse
than none, because it looks like a claim that was never checked.

## Testnet or mainnet

The rules say "real, verifiable" without naming a network. Base Sepolia is
verifiable on `sepolia.basescan.org`, and the transaction is genuinely
agent-driven either way.

A judge could still read "real" as mainnet. Removing that ambiguity costs
about a dollar of USDC on Base mainnet plus `ALLOW_MAINNET=true`, and it is
the cheaper risk to eliminate. If you do it, fund
`MAINNET_CAMPAIGN_WALLET` (`0x0003a59858f44451be2a5b486ee612b4139700f0`),
which currently holds nothing.

## What to record

The demo has to show the payment was **agent-driven**. A human clicking
"pay" does not qualify, and the rules say so explicitly.

So film the scheduler firing, or the tick returning a settled decision, and
narrate that nothing between the clip arriving and the money leaving was a
person: the model judged the clip, the oracle read the count, the gate applied
the caps, the executor sent it.

The refusals are worth as much as the settlement. A pass showing
`dwell_unmet` before the hold closed and `settled` after is a demonstration
that the rules are real rather than decorative.

## Afterwards

Turn broadcasting back off unless you mean to keep settling:

```
gcloud run services update merlinclips \
  --region us-central1 --project merlinclips \
  --remove-env-vars BROADCAST
```
