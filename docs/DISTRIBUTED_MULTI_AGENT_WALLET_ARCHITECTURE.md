# One wallet per campaign

How Merlin Clips removes the single-wallet failure mode, what is built today,
and what is deliberately not.

Every claim below is either implemented and tested, or marked **Not built**.
An earlier version of this document described the whole design in the present
tense while the code behind it generated random numbers and called them
wallets; that is worse than having no document, because it is the kind of page
someone implements against.

---

## 1. What the single wallet actually costs

One address holding every campaign's pool has three failures, and only one of
them is about keys.

| | Failure | Consequence |
|---|---|---|
| 1 | **Blast radius** | One compromised key exposes every brand's pool and the platform's fees at once. |
| 2 | **Nonce coupling** | EVM transactions from an address are ordered by nonce. One stuck payout on campaign A stalls payouts on every campaign behind that address. |
| 3 | **Coverage that lies** | `fundingFor` compares a wallet's balance against *one* campaign's pool. Three campaigns behind a wallet holding 100 USDC each read "fully funded" against a 100 pool. |

The third is the one that pays a wrong number out, and it was live. The same
hundred dollars was promised three times and published to creators as the
amount left to earn — which is the exact complaint this product exists to
answer, reproduced by our own arithmetic.

---

## 2. Built: coverage nets other claims off first

`fundingFor` takes the outstanding pools of every *launched* campaign behind
the same wallet and subtracts them before deciding coverage. The answer now
means "backing available to **this** campaign".

Drafts and unfunded campaigns are not counted as claims — they have promised
nothing to anyone yet, and treating them as claims would understate a wallet
that is genuinely funded.

Verified against Base mainnet with two campaigns behind one address holding
167.551481 USDC:

```
camp-spof-a  →  covered   (claims 100, goes live)
camp-spof-b  →  partial   "67.551481 USDC backs a 100 budget.
                           167.551481 USDC sits here but 100 of it is
                           already promised to other campaigns."
```

Before the change, `camp-spof-b` read `covered` and entered the approval
queue. Oversubscription clamps at zero rather than reporting a negative
balance as a credit.

- `src/campaign/funding.ts` — the netting
- `src/campaign/runtime.ts` — `otherClaimsOn()`, applied at all four coverage call sites
- `src/campaign/sharedwallet.test.ts` — 9 tests

## 3. Built: a wallet backs exactly one campaign

`MultiAgentClusterManager` binds a campaign to an address and refuses:

- anything that is not a 0x-prefixed 40-character hex address
- the zero address, and the `0xSafeTreasury000…` placeholder that shipped as
  the old default — both are unrecoverable losses, so both are named
- an address that already backs a different campaign
- repointing a campaign that already has one

Registration is idempotent for the same pair. `topology()` reports whether
isolation actually holds rather than asserting it.

- `src/campaign/cluster.ts`, `src/campaign/cluster.test.ts` — 10 tests

### Wallets are provisioned, never generated

The previous implementation produced twenty random bytes and returned them as
a sub-wallet address. Nobody holds the key to a random number: USDC sent there
is destroyed, and the "unspent refund sweep" documented on top of it could
never have run. Its tests asserted that two generated strings differed and
matched `/^0x[a-f0-9]{40}$/` — both true of random bytes — so the suite passed
while the subject could not have held a cent.

An address is registered only after something can sign for it. `custody`
records which: `circle-agent-wallet` or `operator-supplied`.
`provisionCommand()` prints the `circle wallet create` step rather than
pretending to have taken it.

## 4. Built: the deposit splitter computes, and refuses

`splitDeposit()` returns the treasury fee and the campaign pool for a deposit.
It refuses when `SAFE_TREASURY_ADDRESS` is unset or invalid, and when the
campaign has no registered wallet. There is no default treasury — computing a
split against a placeholder is how every fee was previously routed to a string
that is not an address.

It calculates only. **No transfer is executed anywhere in this module.**

---

## 5. Not built

- **Automatic wallet provisioning per campaign.** Creating custody is a
  deliberate act by someone who can prove it. Campaigns today carry an
  operator-supplied `fundingWallet`.
- **Executing the fee split on-chain.** The split is computed; moving the USDC
  is not wired.
- **Gnosis Safe multisig treasury.** No Safe is deployed. `SAFE_TREASURY_ADDRESS`
  is unset, which is why the splitter refuses.
- **Nonce isolation in settlement.** Distinct wallets are a precondition, not
  the whole fix: the executor still settles from the configured campaign
  wallet rather than per-campaign addresses. Until that changes, benefit 2
  above is not yet realised.
- **Refund sweep on campaign expiry.** Requires custody of the campaign
  wallet, so it follows provisioning.

---

## 6. On-chain, decoded

Base mainnet agent wallet
[`0x0003a598…`](https://basescan.org/address/0x0003a59858f44451be2a5b486ee612b4139700f0)
holds **4.763161 USDC**.

| Transaction | What the receipt shows |
|---|---|
| [`0x66e5c2fa…`](https://basescan.org/tx/0x66e5c2faf60ba47853852f4d2cc27cd27bce1b014e12181f59d496d287b16277) | 0.50 USDC transfer with a Circle Gateway (`0x77777777…`) log — a Gateway deposit, via ERC-4337 EntryPoint |
| [`0x12a6d60c…`](https://basescan.org/tx/0x12a6d60c852714acb8a3bf892fac738485b23cc38115978544d895e353fa8431) | one ERC-20 `Approval` on Base USDC, no transfer |
| [`0x5b7382dd…`](https://basescan.org/tx/0x5b7382dd6a929465706d699deb262bc8f56d9b7264a1e28c5021918553e0694f) | a 0.50 USDC transfer, and **no Gateway log** — so it is a USDC transfer, not the "Gateway deposit to Domain 7" previously claimed |

**No creator payout has settled on Base.** These are treasury operations.

---

## 7. Sequencing

The order matters, because two of these are preconditions for the rest.

1. Provision a Circle agent wallet per live campaign and register it.
2. Deploy the Safe, set `SAFE_TREASURY_ADDRESS`, and the splitter starts
   answering instead of refusing.
3. Thread the campaign wallet through the executor — this is what delivers
   nonce isolation.
4. Refund sweep on expiry, once custody exists.
