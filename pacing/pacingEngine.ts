/**
 * Pacing Agent's core decision logic — pure, no I/O. Mirrors the style of
 * validation/engine.ts and settlement/pendingSettlement.ts: given a snapshot
 * of a campaign's clips and their recent engagement, decide each clip's new
 * effective_cpm_rate and produce a human-readable rationale for the
 * organizer's decision feed.
 *
 * This is rule-based and fully explainable on purpose — every number in the
 * output rationale can be recomputed by hand from the inputs. There is no
 * hidden weighting or learned model here.
 *
 * All arithmetic is BigInt, scaled in basis points (1/10000) where a ratio or
 * multiplier is involved, for the same reason as the rest of this codebase:
 * these values ultimately feed Solidity uint256 amounts and must never touch
 * floating point. Percentages/multipliers in rationale strings are converted
 * to Number only for display text, never for the actual rate computation.
 */

export interface PacingClipInput {
  clipId: string;
  /** Views gained in the recent window (see pacing/agent.ts for the window definition). */
  recentViewVelocity: bigint;
}

export interface PacingInput {
  campaignCpmRate: bigint;
  maxCpm: bigint;
  remainingBalance: bigint;
  totalBudget: bigint;
  clips: PacingClipInput[];
}

export interface PacingDecision {
  clipId: string;
  /** null means "revert to the campaign's base cpm_rate" — see the zero-velocity note below. */
  effectiveCpmRate: bigint | null;
  /** The velocity-share multiplier (basis points, 10000 = 1.0x) used to derive effectiveCpmRate. Null alongside effectiveCpmRate for the zero-velocity case — there's no multiplier to report. Exposed so callers (e.g. pacing/llmAdvisor.ts) can build context without re-deriving this formula independently. */
  multiplierBp: bigint | null;
  rationale: string;
}

export const BP = 10000n; // 1.0000 in basis points

/**
 * The formula from the spec: multiplier = 0.5 + (velocityShare / evenShare) * 0.5.
 * In basis points, velocityShare/evenShare = (velocity_i / totalVelocity) / (1/n)
 * = velocity_i * n / totalVelocity, so:
 *   multiplierBp = 5000 + (velocity_i * n * 5000) / totalVelocity
 * The floor (0.5x) and the coefficient (x0.5) happen to be the same constant
 * here purely because the spec's formula uses 0.5 for both roles — that's a
 * coincidence of this specific formula, not a general rule.
 */
const BASE_MULTIPLIER_BP = 5000n; // both the 0.5 floor and the 0.5 coefficient in the formula above

/** Runway threshold: throttle kicks in once remainingBalance/totalBudget < 20%. */
export const RUNWAY_THRESHOLD_BP = 2000n;
/** Global dampening applied to every clip's rate when runway is low. */
const RUNWAY_THROTTLE_BP = 7000n; // 0.7x

function bpToPercentString(bp: bigint): string {
  return (Number(bp) / 100).toFixed(1) + "%";
}

function bpToMultiplierString(bp: bigint): string {
  return (Number(bp) / 10000).toFixed(2) + "x";
}

export function computePacingDecisions(input: PacingInput): PacingDecision[] {
  const { campaignCpmRate, maxCpm, remainingBalance, totalBudget, clips } = input;

  const totalVelocity = clips.reduce((sum, c) => sum + c.recentViewVelocity, 0n);
  const n = BigInt(clips.length);

  const runwayBp = totalBudget > 0n ? (remainingBalance * BP) / totalBudget : BP;
  const runwayLow = totalBudget > 0n && runwayBp < RUNWAY_THRESHOLD_BP;
  const runwaySuffix = runwayLow
    ? `Campaign runway at ${bpToPercentString(runwayBp)}, below ${bpToPercentString(RUNWAY_THRESHOLD_BP)} threshold — ${bpToMultiplierString(RUNWAY_THROTTLE_BP)} throttle applied.`
    : `Campaign runway at ${bpToPercentString(runwayBp)}, no throttle applied.`;

  return clips.map(({ clipId, recentViewVelocity }) => {
    // A clip with zero recent velocity reverts to the campaign's base rate
    // (null) rather than being actively throttled to the 0.5x floor. Two
    // reasons: (1) with no engagement signal at all, there's nothing to base
    // a real pacing decision on — the floor multiplier would be a default,
    // not a decision. (2) effective_cpm_rate persists until the next pacing
    // cycle; if a currently-idle clip suddenly goes viral, we want it earning
    // at the full base rate immediately, not stuck at a stale 0.5x throttle
    // from when it happened to have no recent views. This only matters for
    // whatever views that clip earns *right now* anyway (view_delta ~ 0 in
    // this same window), so nothing is actually being underpaid by choosing
    // null over 0.5x here.
    if (recentViewVelocity === 0n) {
      return {
        clipId,
        effectiveCpmRate: null,
        multiplierBp: null,
        rationale: `Clip ${clipId}: no recent view velocity — reverting to campaign base rate (no signal to pace on).`,
      };
    }

    const velocityShareBp = (recentViewVelocity * BP) / totalVelocity;
    const evenShareBp = BP / n;

    let multiplierBp = BASE_MULTIPLIER_BP + (recentViewVelocity * n * BASE_MULTIPLIER_BP) / totalVelocity;
    if (multiplierBp < BASE_MULTIPLIER_BP) {
      multiplierBp = BASE_MULTIPLIER_BP; // defensive; the formula can't actually go below this for velocity_i >= 0
    }

    const rawRate = (campaignCpmRate * multiplierBp) / BP;
    const ceilingHit = rawRate > maxCpm;
    let rate = ceilingHit ? maxCpm : rawRate;

    let throttleNote = "";
    if (runwayLow) {
      const beforeThrottle = rate;
      rate = (rate * RUNWAY_THROTTLE_BP) / BP;
      if (rate > maxCpm) rate = maxCpm; // defensive re-clamp; can't actually happen since RUNWAY_THROTTLE_BP < BP
      throttleNote = ` Rate reduced from ${beforeThrottle} to ${rate} by the runway throttle.`;
    }

    const ceilingNote = ceilingHit
      ? `HIT ceiling ${maxCpm}, clamped from ${rawRate} to ${maxCpm}`
      : `ceiling ${maxCpm}, not hit`;

    const rationale =
      `Clip ${clipId}: velocity share ${bpToPercentString(velocityShareBp)} vs even split ${bpToPercentString(evenShareBp)} ` +
      `→ ${bpToMultiplierString(multiplierBp)} multiplier → rate ${rate} (base ${campaignCpmRate}, ${ceilingNote}). ` +
      `${runwaySuffix}${throttleNote}`;

    return { clipId, effectiveCpmRate: rate, multiplierBp, rationale };
  });
}
