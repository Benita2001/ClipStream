# ClipStream

**Paid per view, powered by Arc.**

ClipStream is a Clipping platform built for the Lepton Agents Hackathon (Canteen × Circle × Arc). Organizers fund their Clipping campaign in native USDC on Arc; clippers submitb their clips link as tweet URLs and get paid per view, settled continuously as their clip's view count climbs  no CPM threshold, no monthly payout cycle, no waiting to find out if the numbers were fair.

An autonomous Pacing Agent — a deterministic budget-allocation engine with a Claude-in-the-loop reasoning layer on top — shifts a campaign's spend toward whichever clips are actually earning engagement, in real time, within hard limits the organizer sets.

Built for RFB 4 (Streaming & Continuous Payments) and RFB 6 (Creator & Publisher Monetization).

---

## The problem

Clipping platforms pay on flat CPM tiers with payout thresholds and monthly delays. A clip that goes viral on Monday and one that quietly does nothing get reconciled the same way, weeks later, in a lump sum nobody can independently verify. Organizers have no real-time visibility into whether their budget is going toward genuine engagement or just being paid out blind.

## How ClipStream works

```
Clip submitted (tweet URL)
   → tweet author verified against the clipper's linked X account
   → clip becomes active

View Poller (polls active clips' real view counts on an interval)
   → computes the view-count delta since the last poll
   → Validation Engine scores the delta (heuristic plausibility check)
   → if approved: queued for settlement

Pacing Agent (separate interval)
   → computes each clip's engagement velocity relative to the others
     competing for the same campaign's budget
   → adjusts each clip's effective per-view rate — boosting clips
     earning real engagement, throttling ones that aren't, always
     clamped to the organizer's rate ceiling
   → a Claude API call reviews the deterministic result per campaign,
     proposing a bounded adjustment (±20%) with a written rationale —
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

## Why the Pacing Agent is genuinely agentic, not just automated

The deterministic engine alone is real decision-making — it allocates a shared, limited budget across competing clips based on actual engagement data, not a fixed split. On top of that, a real Claude API call reviews the campaign's clips together each cycle and can propose a bounded adjustment with a written rationale, e.g.:

> *"This clip has a recent rate-ceiling rejection where the computed amount of 180000 exceeded the campaign max_cpm cap. The deterministic rate of 140900 is already close to the 150000 ceiling, and the observed settlement failure suggests the effective payout is being pushed beyond the cap. A modest downward adjustment to ~119765 reduces the risk of further ceiling rejections while still rewarding this clip's strong view velocity."*

The hard ceiling is enforced in code regardless of what the model returns — a system moving real money should never have an unconstrained LLM as the last word on a number, but a constrained one can add judgment a fixed formula can't.

## Deviations from `circlefin/arc-escrow`

`CampaignEscrow.sol` and `PayoutRegistry.sol` are based on the `arc-escrow` reference pattern, with several deliberate departures:

- **Native currency, not ERC20.** Arc uses USDC as its native gas currency, not a token at a separate contract address. `createCampaign`/`topUp` are `payable`; `release`/`withdrawRemaining` use a low-level `call{value}` rather than `SafeERC20.safeTransfer`. There is no token contract dependency anywhere in either contract.
- **`settlementId`-based idempotency.** Every `release()` and `recordPayout()` call is keyed by a unique settlement ID, checked against a mapping before any transfer occurs. A retried or replayed settlement reverts rather than paying twice — proven under test by deliberately reprocessing an already-settled row and confirming the revert, not just asserting the check exists.
- **`authorizedAgent`-gated writes on both contracts.** `PayoutRegistry` initially had no access control at all, which would have let anyone log a fabricated payout indistinguishable from a real one — this was caught and fixed before deployment, mirroring the same `authorizedAgent` pattern `CampaignEscrow` already used.
- **Reentrancy tested against a real attacking contract**, not just asserted by the presence of a modifier — a `ReentrantClipper` mock attempts to re-enter `release()` from its own `receive()` hook, confirming the guard actually blocks the attack.

## Real verification, not simulated

Deployed and tested end-to-end on real Arc testnet (chain ID `5042002`):

- `CampaignEscrow`: `0x15EA687a8C70c2AF3AA68BA90B4B8904E7162509`
- `PayoutRegistry`: `0xE52514D229038F0E159119BA76db2A3bA0963123`

A real settlement, triggered by real polled X view data, produced a real on-chain transfer confirmed via Blockscout (`testnet.arcscan.app`) — recipient balance moved, escrow balance decremented, `PayoutRecorded` event emitted with matching args. A Pacing Agent decision was traced through to a real settlement that used its adjusted rate (not the flat base rate), proving the agent's output actually changes what gets paid, not just what gets logged.

**74/74 tests passing** across contracts (Hardhat), validation, server, settlement, pacing, and the LLM-advisor layer.

## Honest scope — what this is and isn't

- View-delta validation is a **heuristic plausibility check** (implausible jumps given the elapsed poll interval), not fraud detection. It's described that way throughout the codebase deliberately.
- Currently supports X/Twitter as the clip source; the architecture keeps view-data reading abstracted so another platform could be added without redesigning the settlement core.
- Circle Wallets (User-Controlled for clippers, Developer-Controlled/connect flow for organizers) and App Kit funding flexibility (Bridge/Swap/Unified Balance) are designed for in the architecture but not yet wired into the frontend — currently wallet addresses are used directly.

## Tech stack

Arc testnet (native USDC) · Solidity + Hardhat + OpenZeppelin · Node.js/TypeScript · SQLite · X API v2 (OAuth 2.0 + app-only reads) · Claude API (structured output, Anthropic SDK) · Next.js frontend

## Judging alignment

- **Agentic sophistication**: a real budget-allocation decision engine with an LLM-augmented reasoning layer, hard-constrained, every decision logged with a written rationale.
- **Traction**: real Arc testnet transactions, real X data, real settlements — not simulated data at any layer of the pipeline.
- **Circle tool usage**: native USDC settlement on Arc, Contracts, X API integration mirroring the x402-style pay-per-access pattern.
- **Innovation**: per-view granular payout replacing CPM thresholds; a hybrid deterministic/LLM pacing engine with an organizer-visible decision feed.
