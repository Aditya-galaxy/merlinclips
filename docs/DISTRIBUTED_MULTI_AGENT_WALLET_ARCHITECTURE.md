# 🏛️ Distributed Multi-Agent Wallet Architecture & Safe Treasury Protection

This document outlines the **Hierarchical Multi-Agent Wallet Cluster** for Merlin Clips on Base Mainnet, protecting platform revenues using a **Safe Multisig Treasury Wallet** and eliminating EVM nonce bottlenecks through **Isolated Campaign Sub-Wallets**.

---

## 1. Executive Summary & Problem Statement

### ❌ Legacy Single-Wallet Vulnerability
In a single-wallet architecture (`0x0003a59858f44451be2a5b486ee612b4139700f0`), one private key holds all campaign funds and executes all payouts.
1. **Single Point of Failure (SPOF)**: A compromised master key exposes all brand campaign pools and collected platform fees.
2. **EVM Nonce Bottleneck**: EVM transactions process sequentially by `nonce`. A single stuck transaction on Campaign A halts creator payouts across **all** active campaigns.
3. **Accounting Pollution**: On-chain view of transactions is mixed, making per-campaign auditing difficult.

---

## 🛡️ 2. The Hierarchical Multi-Agent Cluster Solution

```
                               ┌──────────────────────────────────────────┐
                               │   Gnosis Safe Multisig Treasury Wallet   │
                               │        (Collects & Protects Fees)        │
                               │    0xSafeTreasury000000000000000000000   │
                               └────────────────────┬─────────────────────┘
                                                    │ (Platform Fees)
                       ┌────────────────────────────┴───────────────────────────┐
                       │       Master Developer Agent / Orchestrator            │
                       │    (Circle Developer Controlled API / SDK)            │
                       └──────┬─────────────────────────────────┬───────────────┘
                              │                                 │
            ┌─────────────────┴──────────┐       ┌──────────────┴─────────────┐
            │ Dedicated Campaign 1 Agent │       │ Dedicated Campaign 2 Agent │
            │   (Brand A: $1,000 Pool)   │       │   (Brand B: $5,000 Pool)   │
            │     0xCampAgent1...        │       │     0xCampAgent2...        │
            └────────────┬───────────────┘       └──────────────┬─────────────┘
                         │                                      │
             ┌───────────┴────────────┐             ┌───────────┴────────────┐
             │ Creator Payouts (A)    │             │ Creator Payouts (B)    │
             │ (Parallel Nonce A)     │             │ (Parallel Nonce B)     │
             └────────────────────────┘             └────────────────────────┘
```

---

## 🔐 3. Component Details & Security Rules

### A. Gnosis Safe Multisig Treasury (`SAFE_TREASURY_ADDRESS`)
- **Purpose**: Holds all accumulated Merlin Clips platform revenues ($49, $199, $499 flat fees).
- **Protection**: Requires 2-of-3 or 3-of-5 hardware key signatures (e.g. Ledger / Trezor / Cold storage) to execute any outbound transfer.
- **Rule**: Automated campaign agents can **deposit** fees to the Safe Treasury, but **cannot withdraw** from it.

### B. Master Developer Agent (Orchestrator)
- **Purpose**: Listens for new campaign creations, splits brand deposits, and provisions dedicated Campaign Sub-Wallets.
- **Integration**: Uses Circle's Developer Controlled Wallets REST API (`POST /v1/w3s/developer/wallets`).

### C. Isolated Campaign Sub-Wallets (`0xCamp...`)
- **Purpose**: Each campaign is assigned a unique, dedicated EVM wallet address.
- **Isolation**:
  - **Nonce Isolation**: Campaign 1 executes payouts on Nonce Pipeline 1; Campaign 2 executes on Nonce Pipeline 2. Zero cross-campaign blocking.
  - **Blast Radius Limit**: A failure or compromise on Campaign 1 affects only Campaign 1 ($500), leaving all other campaigns 100% safe.
- **Unspent Refund Sweep**: When a campaign expires, the Campaign Agent automatically sweeps remaining USDC back to the brand's funding wallet.

---

## 💰 4. Fee Splitter & Deposit Flow

When a brand deposits funds (e.g. **$500 Pool** + **$49 Platform Fee** = **$549 Total**):

1. **Deposit Router**: Receives $549 USDC.
2. **Fee Splitter Execution**:
   - `$49.00 USDC` → Directly transferred to `SAFE_TREASURY_ADDRESS` (Gnosis Safe Multisig).
   - `$500.00 USDC` → Directly transferred to `0xCampAgent1...` (Dedicated Campaign Sub-Wallet).
3. **Verification**: Both transactions emit on-chain events on Base Mainnet for full auditability.

---

## 🚀 5. Implementation File Mapping in Repository

- **[`src/campaign/cluster.ts`](file:///Users/aditya/merlinclips/src/campaign/cluster.ts)**: Core Multi-Agent Cluster Manager & Safe Treasury Splitter.
- **[`src/campaign/intake.ts`](file:///Users/aditya/merlinclips/src/campaign/intake.ts)**: Provisions dedicated sub-wallets on campaign creation.
- **[`src/campaign/runtime.ts`](file:///Users/aditya/merlinclips/src/campaign/runtime.ts)**: Executes payouts using campaign-specific sub-wallets.
- **[`src/campaign/cluster.test.ts`](file:///Users/aditya/merlinclips/src/campaign/cluster.test.ts)**: Automated unit tests for fee splitting, Safe Multisig routing, and sub-wallet isolation.
