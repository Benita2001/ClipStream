import { keccak256, toUtf8Bytes } from "ethers";

/**
 * Pure helpers shared by the View Poller (which creates pending_settlements
 * rows) and the Settlement Worker (which consumes them). No I/O — kept
 * separate from both so the arithmetic and id derivation can be unit tested
 * in isolation from the database and the chain.
 */

/**
 * Payout amount for one polled delta, in USDC base units. BigInt throughout —
 * view_delta and base_rate both ultimately feed a Solidity uint256 argument
 * (release()'s amount), and this is exactly the kind of integer that can
 * exceed Number.MAX_SAFE_INTEGER, so no JS Number arithmetic here at all.
 */
export function computeSettlementAmount(viewDelta: bigint, baseRate: bigint): bigint {
  return viewDelta * baseRate;
}

/**
 * Deterministic settlement_id for a given clip's poll event. Same
 * (clipId, polledAt) always produces the same bytes32-hex id, so re-running
 * or re-processing the same poll event can never mint two different ids for
 * what is really one event — that determinism is what the UNIQUE constraint
 * on pending_settlements.settlement_id (and CampaignEscrow's on-chain
 * usedSettlementIds mapping) relies on to prevent a double-pay.
 */
export function computeSettlementId(clipId: number, polledAt: string): string {
  return keccak256(toUtf8Bytes(`${clipId}:${polledAt}`));
}

export interface ClampToRemainingCapInput {
  requestedAmount: bigint;
  alreadyPaid: bigint;
  cap: bigint | null;
}

export interface ClampToRemainingCapResult {
  payableAmount: bigint;
  isCapped: boolean;
}

/**
 * Clamps a requested payout to whatever remains under a clip's per-clip cap.
 * `cap: null` means uncapped. `isCapped` is true exactly when this call
 * reduced or zeroed out the requested amount — hitting the cap exactly with
 * a full, unreduced payment (alreadyPaid + requestedAmount === cap) is *not*
 * flagged here, since nothing about that payment itself was clamped; the
 * next settlement attempt against this clip is what will discover the cap is
 * now exhausted and get clamped to zero. This mirrors how the Settlement
 * Worker uses the result: only a reduced or zero payableAmount triggers
 * setting clips.is_capped.
 */
export function clampToRemainingCap({
  requestedAmount,
  alreadyPaid,
  cap,
}: ClampToRemainingCapInput): ClampToRemainingCapResult {
  if (cap === null) {
    return { payableAmount: requestedAmount, isCapped: false };
  }

  const remaining = cap - alreadyPaid;
  if (remaining <= 0n) {
    return { payableAmount: 0n, isCapped: true };
  }

  if (requestedAmount <= remaining) {
    return { payableAmount: requestedAmount, isCapped: false };
  }

  return { payableAmount: remaining, isCapped: true };
}
