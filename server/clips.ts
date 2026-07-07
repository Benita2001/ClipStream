import { Router, Request, Response } from "express";
import { getTweetAuthor } from "./xApi";
import {
  insertClip,
  getClipByTweetId,
  getXAccountByWallet,
  getCampaignById,
  getClipById,
  getLatestViewSnapshotForClip,
  getTotalSettledAmountForClip,
  listSettlementsByClip,
} from "../db/db";
import { getExplorerTxUrl } from "./chain";

/** How many recent settlements to include in the live earnings ticker's history. */
const RECENT_SETTLEMENTS_LIMIT = 20;

const TWEET_URL_PATTERN = /^https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/[^/]+\/status(?:es)?\/(\d+)/i;

/** Pure — no I/O, easy to test in isolation. */
export function extractTweetId(url: string): string | null {
  const match = url.match(TWEET_URL_PATTERN);
  return match ? match[1] : null;
}

export interface OwnershipCheckResult {
  ok: boolean;
  reason: string;
}

/**
 * Compares the tweet's actual author (from X, via app-only read — no user
 * auth needed) against the submitting wallet's linked X account. Prevents a
 * clipper from submitting someone else's viral tweet to claim its views.
 */
export async function checkClipOwnership(clipperWallet: string, tweetId: string): Promise<OwnershipCheckResult> {
  const xAccount = getXAccountByWallet(clipperWallet);
  if (!xAccount) {
    return {
      ok: false,
      reason: `wallet ${clipperWallet} has no linked X account — link one at /auth/x/start before submitting clips`,
    };
  }

  const author = await getTweetAuthor(tweetId);
  if (author.authorId !== xAccount.x_user_id) {
    return {
      ok: false,
      reason:
        `tweet ${tweetId}'s author (id ${author.authorId}) does not match the X account linked to this wallet ` +
        `(@${xAccount.x_handle}, id ${xAccount.x_user_id})`,
    };
  }

  return { ok: true, reason: `tweet ${tweetId}'s author matches linked account @${xAccount.x_handle}` };
}

export const clipsRouter = Router();

clipsRouter.post("/clips", async (req: Request, res: Response) => {
  const { campaign_id, clipper_wallet, url } = req.body ?? {};

  if (typeof campaign_id !== "number" || typeof clipper_wallet !== "string" || typeof url !== "string") {
    return res.status(400).json({ error: "campaign_id (number), clipper_wallet (string), and url (string) are required" });
  }

  if (!getCampaignById(campaign_id)) {
    return res.status(404).json({ error: `No campaign with id ${campaign_id}` });
  }

  const tweetId = extractTweetId(url);
  if (!tweetId) {
    return res.status(400).json({ error: `Could not extract a tweet id from url: ${url}` });
  }

  if (getClipByTweetId(tweetId)) {
    return res.status(409).json({ error: `Tweet ${tweetId} has already been submitted as a clip` });
  }

  try {
    const ownership = await checkClipOwnership(clipper_wallet, tweetId);
    if (!ownership.ok) {
      return res.status(403).json({ error: ownership.reason });
    }

    const clip = insertClip({ campaign_id, clipper_wallet, url, tweet_id: tweetId });
    res.status(201).json({ clip, ownership: ownership.reason });
  } catch (err: any) {
    res.status(502).json({ error: `Ownership check failed: ${err.message}` });
  }
});

/** Clipper campaign page's live earnings ticker: one clip's running total + recent settlement history. */
clipsRouter.get("/clips/:id/earnings", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "clip id must be an integer" });
  }
  const clip = getClipById(id);
  if (!clip) {
    return res.status(404).json({ error: `No clip with id ${id}` });
  }

  const latestSnapshot = getLatestViewSnapshotForClip(id);
  const recentSettlements = listSettlementsByClip(id)
    .slice(0, RECENT_SETTLEMENTS_LIMIT)
    .map((s) => ({
      id: s.id,
      view_delta: s.view_delta,
      amount: s.amount,
      settlement_id: s.settlement_id,
      tx_hash: s.tx_hash,
      tx_url: getExplorerTxUrl(s.tx_hash),
      created_at: s.created_at,
    }));

  res.json({
    clip_id: clip.id,
    campaign_id: clip.campaign_id,
    clipper_wallet: clip.clipper_wallet,
    effective_cpm_rate: clip.effective_cpm_rate,
    total_earnings: getTotalSettledAmountForClip(id).toString(),
    current_view_count: latestSnapshot ? latestSnapshot.impression_count : null,
    last_polled_at: latestSnapshot ? latestSnapshot.polled_at : null,
    recent_settlements: recentSettlements,
  });
});
