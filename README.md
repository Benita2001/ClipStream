# ClipStream

**Get Paid for your Clips per view.**

No CPM thresholds. No payout minimums.
Clippers earn as views accrue. Organizers see exactly where every dollar goes.

**Live product:** https://clipstream-ten.vercel.app

**Demo Video:** https://x.com/Cryptoclips_/status/2074354073256497510?s=20

**Telegram Community:** https://t.me/Clippersarmy

**Twitter Account:** https://x.com/Cryptoclips_

<img width="1200" height="1200" alt="image" src="https://github.com/user-attachments/assets/2236d0d3-f24d-4e8b-8617-252e88cf2475" />

---

## Overview

Clipping is the biggest form of distribution in 2026 but clippers are really underpaid. Clippers get paid via a CPM basis and most time if they dont reach a minimum threshold they dont get paid or get incomplete payment also Organizers have no real time visibility into whether their budget went toward genuine engagement or was just paid out blind. 

Nanopayments remove that floor. ClipStream is what possible when you build Clippers payment Infrastructure on Arc Nanopayment Technology : Clippers submit clips and get paid per view, settled continuously in native USDC on Arc, the moment the views happen not on a CPM tier, not after a payout threshold. An autonomous Pacing Agent allocates each campaign's budget across competing clips in real time and shows its reasoning for every decision.

### ClipStream vs. other clipping platforms

| | Other clipping platforms | ClipStream |
|---|---|---|
| **Payout timing** | Weekly/monthly, after a threshold clears | Continuous, settled as views accrue |
| **Payout unit** | Flat CPM tier, same rate regardless of performance | Per-view, Paid in USDC |
| **Verifiability** | A dashboard number you have to trust | Every payout is a real on-chain transaction anyone can check |
| **Budget allocation** | Manual or a fixed split decided upfront | An agent reallocates in real time with a written reason for every change |
| **Wallet onboarding** | Seed phrases, browser extensions or centralized custody | Email/PIN-based Circle wallet, no seed phrase |

## How it works

```
Clip submitted (tweet URL)
   → tweet author verified against the clipper's linked X account
   → clip becomes eligible

View Poller (polls active clips' real view counts on an interval)
   → computes the view-count delta since the last poll
   → Validation Engine scores the delta (heuristic plausibility check)
   → if approved: queued for settlement

Pacing Agent (separate interval)
   → computes each clip's engagement velocity relative to the others
     competing for the same campaign's budget
   → adjusts each clip's effective per-view rate boosting clips
     earning real engagement, throttling ones that aren't, always
     clamped to the organizer's rate ceiling
   → a Claude API call reviews the deterministic result per campaign,
     proposing a bounded adjustment (±20%) with a written rationale 
     "LLM proposes, deterministic system disposes": the ceiling can
     never be violated regardless of what the model suggests
   → every decision, deterministic or LLM-augmented, is logged with
     its full rationale

Settlement Worker
   → calls CampaignEscrow.release() — a real native-USDC transfer,
     settled on-chain on Arc
   → calls PayoutRegistry.recordPayout() — an independently
     verifiable on-chain audit log
   → idempotent by settlementId: a retried or replayed settlement
     can never pay twice
```

## How view counts are actually verified

ClipStream reads view counts directly from X's own API — `GET /2/tweets/:id` with `tweet.fields=public_metrics`, using app-only Bearer authentication. This is the same `impression_count` X shows on the tweet itself; ClipStream doesn't scrape, estimate, or self-report it. Ownership is verified separately: a one time "Sign in with X" OAuth link (minimal scopes, no posting permission) ties a clipper's wallet to their real X account and every submitted clip's author is checked against that link via a live API call before it's accepted.

## Why the Pacing Agent is genuinely agentic, not just automated

A fixed formula alone is real decision-making it allocates a shared, limited budget across competing clips based on actual engagement data, not a flat split. On top of that, a real Claude API call reviews each campaign's clips together every cycle and can propose a bounded adjustment with a written rationale. From a real production run:

The hard ceiling is enforced in code regardless of what the model returns a system moving real money should never have an unconstrained LLM as the last word on a number but a constrained one can add judgment a fixed formula can't.

## Product

Two roles, each with a Profile and a Campaign view:

- **Clipper**: create a wallet (Circle User Controlled Wallets email + PIN, no seed phrase), link an X account, browse open campaigns, submit clips, watch a live earnings ticker see full payout history with real transaction links. Lost your session? Recover your wallet using your linked X account — no seed phrase to lose
- **Organizer**: create a real Circle-managed wallet, create and fund a campaign (with a description and source link for clippers to read before joining), set a CPM rate and a hard rate ceiling, watch the Pacing Agent's live decision feed, see aggregate spend across every campaign.

## Real verification

Every layer of this pipeline is deployed and proven against real infrastructure, not mocked:

- **Contracts**, live on Arc Testnet: **Contracts (Arc Testnet, chain ID 5042002):** [`CampaignEscrow`](https://testnet.arcscan.app/address/0x15EA687a8C70c2AF3AA68BA90B4B8904E7162509) · [`PayoutRegistry`](https://testnet.arcscan.app/address/0xE52514D229038F0E159119BA76db2A3bA0963123). A real settlement, triggered by real polled X view data, produced a real on-chain transfer confirmed via Blockscout — recipient balance moved, escrow balance decremented, event emitted with matching args.
- **A real Pacing Agent decision was traced through to a real settlement** that used its adjusted rate, not the flat base rate proving the agent's output actually changes what gets paid, not just what gets logged.
- **Real Circle wallets**, created through the actual browser PIN flow, valid Arc Testnet addresses.
- **Real X OAuth linking** ownership of a submitted clip is checked against a live X API call before it's accepted not assumed.
- **97+ automated tests passing** across contracts (Hardhat), validation, server, settlement, pacing, and the LLM-advisor layer.

Real production bugs were found and fixed against live infrastructure during development not just caught in code review including a nonce-desync bug that could hang the settlement worker, a unit-conversion mismatch that would have made every organizer deposit off by 12 orders of magnitude and an address casing bug that made a real successful campaign invisible to its own organizer. All are documented with root cause and fix in the project's internal build log.

## Deviations from `circlefin/arc-escrow`

`CampaignEscrow.sol` and `PayoutRegistry.sol` are based on the `arc-escrow` reference pattern, with deliberate departures:

- **Native currency, not ERC20.** Arc uses USDC as its native gas currency, not a token at a separate contract address. `createCampaign`/`topUp` are `payable`; `release`/`withdrawRemaining` use a low-level `call{value}` rather than `SafeERC20.safeTransfer`.
- **`settlementId`-based idempotency.** Every `release()` and `recordPayout()` call is keyed by a unique settlement ID, checked before any transfer occurs. A retried settlement reverts rather than paying twice proven by deliberately reprocessing an already-settled row and confirming the revert.
- **`authorizedAgent`-gated writes on both contracts.** `PayoutRegistry` initially had no access control, which would have let anyone log a fabricated payout indistinguishable from a real one caught and fixed before deployment.
- **Reentrancy tested against a real attacking contract**, not just asserted by a modifier's presence — a `ReentrantClipper` mock attempts to reenter `release()` from its own `receive()` hook, confirming the guard actually blocks the attack.

## Honest scope 

- Currently supports X/Twitter as the clip source; the architecture keeps view-data reading abstracted so another platform could be added without redesigning the settlement core.

## Traction

- **Real clippers onboarded:** [ 400 Clippers in waitlist] (https://t.me/Clippersarmy)
- **Real organizers onboarded:** [3]
- **Real campaigns created:** [3]
- **Real clips submitted:** [10]
- **Real settlements paid out:** [ ] transactions, totaling [ ] testnet USDC
- **Real Pacing Agent decisions logged:** [ ], including [ ] with Claude-augmented reasoning
- **Social proof:** [7K Followers, 400 community members,  ] 

## Tech stack

Arc Testnet (native USDC) · Solidity + Hardhat + OpenZeppelin · Node.js + TypeScript · SQLite · X API v2 (OAuth 2.0 + app-only reads) · Circle User-Controlled Wallets · Anthropic API (structured output) · Next.js · Render (backend) · Vercel (frontend)

## Judging alignment

- **Agentic sophistication**: a real budget allocation engine with an LLM-augmented reasoning layer, hard-constrained, every decision logged with a written, specific rationale.
- **Traction**: real Arc Testnet transactions, real X data, real wallet creation, real settlements 
- **Circle tool usage**: native USDC settlement, Contracts, User-Controlled Wallets (PIN-based signup and signing for both roles), X-based wallet recovery.
- **Innovation**: per-view granular payout replacing CPM thresholds; a hybrid deterministic/LLM pacing engine with an organizer-visible decision feed.

## Local development

```bash
npm install
npm run db:init
npm run build
npm start          # server + view poller + settlement worker + pacing agent

cd web && npm install && npm run dev
```

See `.env.example` for required environment variables (Arc RPC, agent keys, X API credentials, Circle API credentials, Anthropic API key).
