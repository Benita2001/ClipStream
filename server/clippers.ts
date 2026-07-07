import { Router, Request, Response } from "express";
import {
  listClipsByClipper,
  listSettlementsByClipper,
  getTotalSettledAmountForClipper,
  getCampaignById,
  getXAccountByWallet,
} from "../db/db";
import { getExplorerTxUrl } from "./chain";

export const clippersRouter = Router();

/** Clipper profile page: lifetime earnings + per-campaign breakdown. */
clippersRouter.get("/clippers/:wallet/profile", (req: Request, res: Response) => {
  const wallet = req.params.wallet;
  if (typeof wallet !== "string") {
    return res.status(400).json({ error: "wallet path parameter must be a single string" });
  }

  const clips = listClipsByClipper(wallet);
  const settlements = listSettlementsByClipper(wallet);

  // Union of campaigns this clipper has either submitted a clip to or earned
  // a settlement in — a freshly-submitted clip may have zero settlements yet.
  const campaignIds = new Set<number>([...clips.map((c) => c.campaign_id), ...settlements.map((s) => s.campaign_id)]);

  const earningsByCampaign = new Map<number, bigint>();
  for (const s of settlements) {
    earningsByCampaign.set(s.campaign_id, (earningsByCampaign.get(s.campaign_id) ?? 0n) + BigInt(s.amount));
  }
  const clipCountByCampaign = new Map<number, number>();
  for (const c of clips) {
    clipCountByCampaign.set(c.campaign_id, (clipCountByCampaign.get(c.campaign_id) ?? 0) + 1);
  }

  const campaigns = [...campaignIds]
    .map((campaignId) => {
      const campaign = getCampaignById(campaignId);
      if (!campaign) return null; // shouldn't happen (FK), but don't crash the whole profile if it somehow did
      return {
        campaign_id: campaign.id,
        contract_campaign_id: campaign.contract_campaign_id,
        cpm_rate: campaign.cpm_rate,
        max_cpm: campaign.max_cpm,
        status: campaign.status,
        clips_submitted: clipCountByCampaign.get(campaignId) ?? 0,
        earnings_in_campaign: (earningsByCampaign.get(campaignId) ?? 0n).toString(),
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const xAccount = getXAccountByWallet(wallet);

  res.json({
    wallet_address: wallet,
    x_account: xAccount ? { linked: true, x_handle: xAccount.x_handle, x_user_id: xAccount.x_user_id } : { linked: false },
    lifetime_earnings: getTotalSettledAmountForClipper(wallet).toString(),
    clips_submitted: clips.length,
    campaigns,
  });
});

/** Clipper profile page's transaction list: full payout history, including a real, clickable tx explorer link. */
clippersRouter.get("/clippers/:wallet/settlements", (req: Request, res: Response) => {
  const wallet = req.params.wallet;
  if (typeof wallet !== "string") {
    return res.status(400).json({ error: "wallet path parameter must be a single string" });
  }
  const settlements = listSettlementsByClipper(wallet).map((s) => ({
    id: s.id,
    campaign_id: s.campaign_id,
    clip_id: s.clip_id,
    view_delta: s.view_delta,
    amount: s.amount,
    settlement_id: s.settlement_id,
    tx_hash: s.tx_hash,
    tx_url: getExplorerTxUrl(s.tx_hash),
    created_at: s.created_at,
  }));
  res.json({ wallet_address: wallet, settlements });
});
