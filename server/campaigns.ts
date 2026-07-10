import { Router, Request, Response } from "express";
import {
  listActiveCampaigns,
  getCampaignById,
  getCampaignByContractId,
  listCampaignsByOrganizer,
  listClipsByCampaign,
  listAgentDecisionsByCampaign,
  countClipsByCampaign,
  getTotalSettledAmountForCampaign,
  getSettledAmountSince,
  getLatestViewSnapshotForClip,
  getTotalSettledAmountForClip,
  insertCampaign,
  CpmRateExceedsMaxError,
  Campaign,
} from "../db/db";
import { getCampaignRemainingBalance, getCampaignOnChainDetails, getConfiguredAgentAddress, getCampaignIdFromTxHash } from "./chain";

export const campaignsRouter = Router();

/** Window for the Organizer campaign page's "spend velocity" metric. */
const SPEND_VELOCITY_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * runway_percent is a display convenience only (rounded to 1 decimal) — the
 * exact accounting values (remaining_balance, total_budget) are always
 * returned alongside it as TEXT-bigint strings. Converting a *ratio* of two
 * bigints to a JS number is fine here (the result is a small percentage,
 * not a raw base-unit amount), unlike doing arithmetic on the raw amounts
 * themselves, which must stay BigInt/TEXT throughout — see
 * docs/FRONTEND_DATA_CONTRACT.md.
 */
function computeRunwayPercent(remainingBalance: bigint, totalBudget: bigint): number | null {
  if (totalBudget === 0n) return null;
  return Math.round((Number(remainingBalance) / Number(totalBudget)) * 1000) / 10;
}

async function summarizeCampaign(campaign: Campaign) {
  const remainingBalanceStr = await getCampaignRemainingBalance(campaign.contract_campaign_id);
  const remainingBalance = BigInt(remainingBalanceStr);
  const totalSettled = getTotalSettledAmountForCampaign(campaign.id);
  const totalBudget = remainingBalance + totalSettled;
  const sinceIso = new Date(Date.now() - SPEND_VELOCITY_WINDOW_MS).toISOString();
  const spendLastHour = getSettledAmountSince(campaign.id, sinceIso);

  return {
    id: campaign.id,
    contract_campaign_id: campaign.contract_campaign_id,
    organizer_wallet: campaign.organizer_wallet,
    cpm_rate: campaign.cpm_rate,
    max_cpm: campaign.max_cpm,
    max_duration: campaign.max_duration,
    status: campaign.status,
    created_at: campaign.created_at,
    remaining_balance: remainingBalanceStr,
    total_settled: totalSettled.toString(),
    total_budget: totalBudget.toString(),
    runway_percent: computeRunwayPercent(remainingBalance, totalBudget),
    clip_count: countClipsByCampaign(campaign.id),
    spend_velocity_last_hour: spendLastHour.toString(),
  };
}

/** Clipper browse view: list of open (active) campaigns. */
campaignsRouter.get("/campaigns", async (req: Request, res: Response) => {
  try {
    const campaigns = listActiveCampaigns();
    const summaries = await Promise.all(campaigns.map(summarizeCampaign));
    res.json({ campaigns: summaries });
  } catch (err: any) {
    res.status(502).json({ error: `Failed to read on-chain campaign balances: ${err.message}` });
  }
});

/** Full detail for one campaign — Clipper campaign detail view + Organizer campaign management view. */
campaignsRouter.get("/campaigns/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "campaign id must be an integer" });
  }
  const campaign = getCampaignById(id);
  if (!campaign) {
    return res.status(404).json({ error: `No campaign with id ${id}` });
  }
  try {
    res.json({ campaign: await summarizeCampaign(campaign) });
  } catch (err: any) {
    res.status(502).json({ error: `Failed to read on-chain campaign balance: ${err.message}` });
  }
});

/**
 * Organizer campaign management view: clips submitted to a campaign, with
 * current view counts and total earnings. Also doubles as the Clipper
 * campaign page's "this clipper's clips in this campaign" live ticker via
 * ?clipper_wallet= — same rich per-clip shape (view count, effective rate,
 * earnings, capped status), just filtered to one wallet.
 */
campaignsRouter.get("/campaigns/:id/clips", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "campaign id must be an integer" });
  }
  if (!getCampaignById(id)) {
    return res.status(404).json({ error: `No campaign with id ${id}` });
  }

  const clipperWallet = req.query.clipper_wallet;
  let allClips = listClipsByCampaign(id);
  if (typeof clipperWallet === "string") {
    allClips = allClips.filter((c) => c.clipper_wallet === clipperWallet);
  }

  const clips = allClips.map((clip) => {
    const latestSnapshot = getLatestViewSnapshotForClip(clip.id);
    return {
      id: clip.id,
      campaign_id: clip.campaign_id,
      clipper_wallet: clip.clipper_wallet,
      url: clip.url,
      tweet_id: clip.tweet_id,
      per_clip_cap: clip.per_clip_cap,
      is_capped: clip.is_capped,
      effective_cpm_rate: clip.effective_cpm_rate,
      submitted_at: clip.submitted_at,
      current_view_count: latestSnapshot ? latestSnapshot.impression_count : null,
      last_polled_at: latestSnapshot ? latestSnapshot.polled_at : null,
      total_earnings: getTotalSettledAmountForClip(clip.id).toString(),
    };
  });

  res.json({ clips });
});

/** Organizer decision feed: recent Pacing Agent decisions for a campaign, most-recent-first. */
campaignsRouter.get("/campaigns/:id/agent-decisions", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "campaign id must be an integer" });
  }
  if (!getCampaignById(id)) {
    return res.status(404).json({ error: `No campaign with id ${id}` });
  }

  const limitParam = req.query.limit;
  const limit = typeof limitParam === "string" && Number.isInteger(Number(limitParam)) ? Number(limitParam) : 50;

  const decisions = listAgentDecisionsByCampaign(id)
    .slice(0, limit)
    .map((d) => ({
      id: d.id,
      campaign_id: d.campaign_id,
      clip_id: d.clip_id,
      decision_type: d.decision_type,
      rationale: d.rationale,
      old_rate: d.old_rate,
      new_rate: d.new_rate,
      llm_used: d.llm_used,
      created_at: d.created_at,
    }));

  res.json({ agent_decisions: decisions });
});

/**
 * Organizer profile page: campaigns this organizer created. Not explicitly
 * named in the requested endpoint list (the page inventory paste was empty),
 * but CLAUDE.md's own page structure reference requires an Organizer Profile
 * page, and listCampaignsByOrganizer already existed to support exactly
 * this — added so that page has something to read from.
 */
campaignsRouter.get("/organizers/:wallet/campaigns", async (req: Request, res: Response) => {
  const wallet = req.params.wallet;
  if (typeof wallet !== "string") {
    return res.status(400).json({ error: "wallet path parameter must be a single string" });
  }
  try {
    const campaigns = listCampaignsByOrganizer(wallet);
    const summaries = await Promise.all(campaigns.map(summarizeCampaign));
    // Aggregate spend across all of this organizer's campaigns — Organizer
    // Profile page's headline number. Summed as BigInt over the already-
    // computed per-campaign total_settled strings, not re-queried.
    const aggregateSpend = summaries.reduce((sum, c) => sum + BigInt(c.total_settled), 0n);
    res.json({ organizer_wallet: wallet, aggregate_spend: aggregateSpend.toString(), campaigns: summaries });
  } catch (err: any) {
    res.status(502).json({ error: `Failed to read on-chain campaign balances: ${err.message}` });
  }
});

/**
 * Resolves the real on-chain contract_campaign_id from a confirmed
 * createCampaign() transaction hash — the step between a Circle-wallet-
 * signed create-campaign transaction confirming and calling POST
 * /campaigns to index it. Kept as its own endpoint (not folded into POST
 * /campaigns) since it reads chain state only, no DB write.
 */
campaignsRouter.get("/campaigns/resolve-tx/:txHash", async (req: Request, res: Response) => {
  const txHash = req.params.txHash;
  if (typeof txHash !== "string") {
    return res.status(400).json({ error: "txHash path parameter must be a single string" });
  }
  try {
    const contract_campaign_id = await getCampaignIdFromTxHash(txHash);
    res.json({ contract_campaign_id });
  } catch (err: any) {
    res.status(502).json({ error: `Failed to resolve campaign id from tx ${txHash}: ${err.message}` });
  }
});

/**
 * Organizer campaign creation flow: the organizer's own wallet has already
 * called CampaignEscrow.createCampaign on-chain directly (client-side
 * signing via App Kit — this backend never holds organizer funds or signs
 * on their behalf). This endpoint indexes the resulting on-chain campaign
 * into SQLite, adding the off-chain-only cpm_rate/max_cpm pricing fields
 * that the contract has no concept of.
 *
 * organizer_wallet/base_rate/max_duration are deliberately NOT trusted from
 * the request body — they're read from the chain itself via
 * getCampaignOnChainDetails, the actual source of truth, so a client can't
 * misrepresent who the organizer is or what was actually deposited.
 */
campaignsRouter.post("/campaigns", async (req: Request, res: Response) => {
  const { contract_campaign_id, cpm_rate, max_cpm } = req.body ?? {};

  if (typeof contract_campaign_id !== "string" || typeof cpm_rate !== "string" || typeof max_cpm !== "string") {
    return res
      .status(400)
      .json({ error: "contract_campaign_id (string), cpm_rate (string), and max_cpm (string) are required" });
  }

  if (getCampaignByContractId(contract_campaign_id)) {
    return res.status(409).json({ error: `Campaign with contract_campaign_id ${contract_campaign_id} is already indexed` });
  }

  let onChain;
  try {
    onChain = await getCampaignOnChainDetails(contract_campaign_id);
  } catch (err: any) {
    return res.status(404).json({ error: `No on-chain campaign with id ${contract_campaign_id}: ${err.message}` });
  }

  let configuredAgent: string;
  try {
    configuredAgent = getConfiguredAgentAddress();
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
  if (onChain.authorizedAgent.toLowerCase() !== configuredAgent.toLowerCase()) {
    return res.status(400).json({
      error:
        `On-chain authorizedAgent (${onChain.authorizedAgent}) does not match ClipStream's configured Settlement Agent ` +
        `(${configuredAgent}) — this campaign's release() calls would always revert with NotAuthorizedAgent. ` +
        `Re-create the campaign with ${configuredAgent} as authorizedAgent.`,
    });
  }

  try {
    const campaign = insertCampaign({
      organizer_wallet: onChain.organizer,
      contract_campaign_id,
      base_rate: Number(onChain.baseRate),
      cpm_rate,
      max_cpm,
      max_duration: Number(onChain.maxDuration),
    });
    res.status(201).json({ campaign: await summarizeCampaign(campaign) });
  } catch (err: any) {
    if (err instanceof CpmRateExceedsMaxError) {
      return res.status(400).json({ error: err.message });
    }
    res.status(502).json({ error: `Failed to index campaign: ${err.message}` });
  }
});
