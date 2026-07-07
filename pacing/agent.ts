import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import {
  listActiveCampaigns,
  listClipsByCampaign,
  getRecentViewSnapshotsForClip,
  getTotalSettledAmountForCampaign,
  getRecentFailedSettlementReasonsForClip,
  setClipEffectiveCpmRate,
  insertAgentDecision,
  Campaign,
  Clip,
} from "../db/db";
import { computePacingDecisions, PacingClipInput, PacingDecision, BP, RUNWAY_THRESHOLD_BP } from "./pacingEngine";
import { getLlmAdjustments, applyLlmAdjustment, LlmCampaignContext, LlmClipContext } from "./llmAdvisor";
import { CampaignEscrow__factory } from "../typechain-types/factories/contracts/CampaignEscrow__factory";
import type { CampaignEscrow } from "../typechain-types";

/**
 * Pacing Agent: on a configurable interval, re-allocates per-view rate
 * across a campaign's clips based on recent engagement, within the
 * organizer-set cpm_rate/max_cpm boundaries the earlier phase is
 * responsible for enforcing. This job only *decides* rates (writes
 * clips.effective_cpm_rate + logs agent_decisions) — it never touches the
 * chain itself; the View Poller picks up the new rate on its next cycle and
 * the Settlement Worker's existing defensive max_cpm check remains in place
 * as an independent second safety net.
 *
 * Same setInterval choice as the poller/worker, for the same reason — this
 * is "recompute every N seconds," not a calendar schedule.
 */

/** Recent-velocity window: the last N view_snapshots for a clip, not a fixed
 * time window. Poll intervals are configurable (VIEW_POLL_INTERVAL_SECONDS)
 * and can change, so "last 3 snapshots" adapts automatically to however
 * often polling actually happens, whereas "last N minutes" would silently
 * mean a different number of samples depending on that setting. */
const RECENT_SNAPSHOT_WINDOW = 3;

interface Deployments {
  campaignEscrow: string;
  payoutRegistry: string;
}

function loadDeployments(): Deployments {
  const deploymentsPath = process.env.DEPLOYMENTS_OUT || path.join(__dirname, "..", "deployments.json");
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error(`No deployments file at ${deploymentsPath} — run the deploy script first.`);
  }
  return JSON.parse(fs.readFileSync(deploymentsPath, "utf-8")) as Deployments;
}

function loadProvider(): ethers.JsonRpcProvider {
  const rpcUrl = process.env.ARC_TESTNET_RPC_URL;
  if (!rpcUrl) {
    throw new Error("Set ARC_TESTNET_RPC_URL in .env");
  }
  return new ethers.JsonRpcProvider(rpcUrl);
}

/** Views gained across the recent window: latest snapshot's impression_count
 * minus the oldest one in the window. Fewer than 2 snapshots means there's
 * no delta to compute yet — treated as zero velocity (reverts to base rate,
 * see pacingEngine.ts). */
function computeClipVelocity(clipId: number): bigint {
  const snapshots = getRecentViewSnapshotsForClip(clipId, RECENT_SNAPSHOT_WINDOW);
  if (snapshots.length < 2) return 0n;
  const delta = snapshots[snapshots.length - 1].impression_count - snapshots[0].impression_count;
  return BigInt(Math.max(0, delta));
}

/** How many recent pending_settlements 'failed' rows to surface per clip in the LLM prompt. */
const RECENT_FAILURE_WINDOW = 3;

function bpToMultiplierDisplay(bp: bigint): string {
  return (Number(bp) / 10000).toFixed(2) + "x";
}

function bpToPercentDisplay(bp: bigint): string {
  return (Number(bp) / 100).toFixed(1) + "%";
}

async function paceCampaign(campaign: Campaign, escrow: CampaignEscrow): Promise<void> {
  const clips = listClipsByCampaign(campaign.id);

  if (clips.length < 2) {
    console.log(`[pacing] campaign ${campaign.id}: skipped — only ${clips.length} clip(s), nothing to allocate between`);
    insertAgentDecision({
      campaign_id: campaign.id,
      decision_type: "pacing_skipped",
      rationale: `Skipped: only ${clips.length} clip(s) in this campaign, nothing to allocate between.`,
    });
    return;
  }

  const velocities = clips.map((clip) => ({ clip, velocity: computeClipVelocity(clip.id) }));
  const totalVelocity = velocities.reduce((sum, v) => sum + v.velocity, 0n);

  if (totalVelocity === 0n) {
    console.log(`[pacing] campaign ${campaign.id}: skipped — no clip has any recent view velocity`);
    insertAgentDecision({
      campaign_id: campaign.id,
      decision_type: "pacing_skipped",
      rationale: `Skipped: none of this campaign's ${clips.length} clips have any recent view velocity — nothing to base a decision on.`,
    });
    return;
  }

  const onChainCampaignId = BigInt(campaign.contract_campaign_id);
  const remainingBalance = await escrow.getCampaignBalance(onChainCampaignId);
  const totalBudget = remainingBalance + getTotalSettledAmountForCampaign(campaign.id);

  const clipInputs: PacingClipInput[] = velocities.map((v) => ({
    clipId: String(v.clip.id),
    recentViewVelocity: v.velocity,
  }));

  const maxCpm = BigInt(campaign.max_cpm);
  const decisions = computePacingDecisions({
    campaignCpmRate: BigInt(campaign.cpm_rate),
    maxCpm,
    remainingBalance,
    totalBudget,
    clips: clipInputs,
  });

  const clipsById = new Map<number, Clip>(clips.map((c) => [c.id, c]));
  const velocityByClipId = new Map<string, bigint>(velocities.map((v) => [String(v.clip.id), v.velocity]));

  // Zero-velocity clips revert to the campaign base rate (effectiveCpmRate
  // null) and have no deterministic rate for an LLM to adjust — only
  // actively-paced clips are candidates for the LLM step. See
  // pacing/llmAdvisor.ts's top-of-file comment for the overall design.
  const pacedDecisions = decisions.filter((d) => d.effectiveCpmRate !== null && d.multiplierBp !== null);

  const runwayBp = totalBudget > 0n ? (remainingBalance * BP) / totalBudget : BP;
  const runwayThrottleApplied = totalBudget > 0n && runwayBp < RUNWAY_THRESHOLD_BP;

  let llmAdjustments: Awaited<ReturnType<typeof getLlmAdjustments>> = null;
  if (pacedDecisions.length > 0) {
    const llmContext: LlmCampaignContext = {
      campaignCpmRate: campaign.cpm_rate.toString(),
      maxCpm: maxCpm.toString(),
      runwayPercent: bpToPercentDisplay(runwayBp),
      runwayThrottleApplied,
      clips: pacedDecisions.map(
        (d): LlmClipContext => ({
          clipId: d.clipId,
          recentViewVelocity: (velocityByClipId.get(d.clipId) ?? 0n).toString(),
          deterministicMultiplier: bpToMultiplierDisplay(d.multiplierBp!),
          deterministicRate: d.effectiveCpmRate!.toString(),
          recentFailures: getRecentFailedSettlementReasonsForClip(Number(d.clipId), RECENT_FAILURE_WINDOW),
        })
      ),
    };

    llmAdjustments = await getLlmAdjustments(llmContext);
    if (llmAdjustments === null) {
      console.log(`[pacing] campaign ${campaign.id}: LLM step skipped for this cycle — using deterministic-only rates (see error above, if any).`);
    }
  }
  const llmAdjustmentsByClipId = new Map((llmAdjustments ?? []).map((a) => [a.clipId, a]));

  for (const decision of decisions) {
    const clipId = Number(decision.clipId);
    const clip = clipsById.get(clipId)!;
    const oldRate = clip.effective_cpm_rate ?? campaign.cpm_rate;

    let finalRate: bigint | null = decision.effectiveCpmRate;
    let rationale = decision.rationale;
    let llmUsed = false;

    if (decision.effectiveCpmRate !== null) {
      const llmAdjustment = llmAdjustmentsByClipId.get(decision.clipId);
      if (llmAdjustment) {
        finalRate = applyLlmAdjustment(decision.effectiveCpmRate, llmAdjustment.adjustmentFactor, maxCpm);
        rationale = llmAdjustment.rationale;
        llmUsed = true;
        console.log(
          `[pacing] campaign ${campaign.id} clip ${clipId}: LLM adjustment_factor=${llmAdjustment.adjustmentFactor} applied to deterministic rate ${decision.effectiveCpmRate} -> ${finalRate} (maxCpm ${maxCpm})`
        );
      }
    }

    const newRate = finalRate !== null ? finalRate.toString() : campaign.cpm_rate;
    setClipEffectiveCpmRate(clipId, finalRate !== null ? finalRate.toString() : null);

    insertAgentDecision({
      campaign_id: campaign.id,
      clip_id: clipId,
      decision_type: "pacing_rate_update",
      rationale,
      old_rate: Number(oldRate),
      new_rate: Number(newRate),
      llm_used: llmUsed,
    });

    console.log(`[pacing] campaign ${campaign.id} clip ${clipId}: ${rationale}`);
  }
}

let isRunning = false;

export async function runPacingCycle(): Promise<void> {
  if (isRunning) {
    console.warn("[pacing] previous cycle still running, skipping this tick");
    return;
  }
  isRunning = true;
  try {
    const campaigns = listActiveCampaigns();
    if (campaigns.length === 0) {
      console.log("[pacing] no active campaigns");
      return;
    }

    const deployments = loadDeployments();
    const provider = loadProvider();
    const escrow = CampaignEscrow__factory.connect(deployments.campaignEscrow, provider) as unknown as CampaignEscrow;

    console.log(`[pacing] evaluating ${campaigns.length} active campaign(s)`);
    for (const campaign of campaigns) {
      await paceCampaign(campaign, escrow);
    }
  } finally {
    isRunning = false;
  }
}

const DEFAULT_INTERVAL_SECONDS = 120;

export function getPacingIntervalSeconds(): number {
  const raw = process.env.PACING_INTERVAL_SECONDS;
  const parsed = raw ? Number(raw) : DEFAULT_INTERVAL_SECONDS;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`PACING_INTERVAL_SECONDS must be a positive number, got: ${raw}`);
  }
  return parsed;
}

export function startPacingAgent(intervalSeconds: number = getPacingIntervalSeconds()): NodeJS.Timeout {
  console.log(`[pacing] starting, evaluating every ${intervalSeconds}s`);
  void runPacingCycle();
  return setInterval(() => void runPacingCycle(), intervalSeconds * 1000);
}
