import { getTweetImpressionCount } from "../server/xApi";
import {
  listActiveClipsForPolling,
  getLatestViewSnapshotForClip,
  insertViewSnapshot,
  getCampaignById,
  insertPendingSettlement,
  Clip,
} from "../db/db";
import { validateViewDelta } from "../validation/engine";
import { computeSettlementAmount, computeSettlementId } from "../settlement/pendingSettlement";

/**
 * View Poller: on a configurable interval, reads each active clip's tweet
 * impression_count from X, snapshots it, and — if a prior snapshot exists —
 * hands the delta to validateViewDelta() for a plausibility check. This is
 * the read/validate side only; it does not call CampaignEscrow.release() or
 * fire any payment. That's the Settlement Worker, a separate later piece.
 *
 * Implementation choice: a plain setInterval loop, not node-cron. node-cron
 * is built for calendar-style schedules ("every day at 9am"); what we need
 * is "poll every N seconds," which setInterval already expresses directly
 * without pulling in a cron-syntax parser we won't otherwise use. The
 * interval is read from VIEW_POLL_INTERVAL_SECONDS so it can be tuned
 * against X's 15-minute rolling rate-limit window without a code change.
 */

const DEFAULT_INTERVAL_SECONDS = 60;

export function getPollIntervalSeconds(): number {
  const raw = process.env.VIEW_POLL_INTERVAL_SECONDS;
  const parsed = raw ? Number(raw) : DEFAULT_INTERVAL_SECONDS;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`VIEW_POLL_INTERVAL_SECONDS must be a positive number, got: ${raw}`);
  }
  return parsed;
}

async function pollClip(clip: Clip): Promise<void> {
  const previous = getLatestViewSnapshotForClip(clip.id);

  let currentImpressionCount: number;
  try {
    const metrics = await getTweetImpressionCount(clip.tweet_id);
    currentImpressionCount = metrics.impressionCount;
  } catch (err: any) {
    console.error(`[poller] clip ${clip.id} (tweet ${clip.tweet_id}): X API read failed — ${err.message}`);
    return;
  }

  const currentPolledAt = new Date().toISOString();
  insertViewSnapshot({ clip_id: clip.id, tweet_id: clip.tweet_id, impression_count: currentImpressionCount });

  if (!previous) {
    console.log(
      `[poller] clip ${clip.id} (tweet ${clip.tweet_id}): first poll, impression_count=${currentImpressionCount} — no prior snapshot, nothing to validate yet`
    );
    return;
  }

  const delta = currentImpressionCount - previous.impression_count;

  const result = validateViewDelta({
    clipId: String(clip.id),
    tweetId: clip.tweet_id,
    previousImpressionCount: previous.impression_count,
    currentImpressionCount,
    previousPolledAt: previous.polled_at,
    currentPolledAt,
  });

  console.log(
    `[poller] clip ${clip.id} (tweet ${clip.tweet_id}): ${previous.impression_count} -> ${currentImpressionCount} ` +
      `=> ${result.status} — ${result.reason}`
  );

  if (result.status !== "APPROVED") {
    return;
  }

  // Performance/cleanliness skip only — the Settlement Worker recomputes the
  // real remaining cap itself and is the actual source of truth, so this
  // check is never load-bearing for correctness, only for not generating
  // settlements we already know will be rejected.
  if (clip.is_capped) {
    console.log(`[poller] clip ${clip.id}: is_capped, skipping pending settlement generation`);
    return;
  }

  const campaign = getCampaignById(clip.campaign_id);
  if (!campaign) {
    console.error(`[poller] clip ${clip.id}: no campaign row for id ${clip.campaign_id}, cannot compute payout`);
    return;
  }

  const viewDelta = BigInt(delta);
  // Per-view rate is cpm_rate (per 1,000 views) / 1000, floored — fractional
  // base units below the smallest unit aren't preserved, by design. Uses the
  // clip's own effective_cpm_rate if the Pacing Agent has set one (already
  // clamped to max_cpm when written); falls back to the campaign's base
  // cpm_rate for a clip that hasn't been paced (or was reverted to null —
  // see pacing/pacingEngine.ts's zero-velocity handling).
  const cpmRateSource = clip.effective_cpm_rate ?? campaign.cpm_rate;
  const perViewRate = BigInt(cpmRateSource) / 1000n;
  const computedAmount = computeSettlementAmount(viewDelta, perViewRate);
  const settlementId = computeSettlementId(clip.id, currentPolledAt);

  const pending = insertPendingSettlement({
    clip_id: clip.id,
    campaign_id: clip.campaign_id,
    clipper_wallet: clip.clipper_wallet,
    view_delta: viewDelta.toString(),
    computed_amount: computedAmount.toString(),
    settlement_id: settlementId,
    validation_reason: result.reason,
  });

  const rateLabel = clip.effective_cpm_rate !== null ? `effective_cpm_rate ${cpmRateSource}` : `campaign cpm_rate ${cpmRateSource}`;
  console.log(
    `[poller] clip ${clip.id}: queued pending settlement #${pending.id} (${settlementId}) — ` +
      `${viewDelta} views * (${rateLabel} / 1000 = ${perViewRate}) = ${computedAmount}`
  );
}

let isPolling = false;

export async function pollOnce(): Promise<void> {
  if (isPolling) {
    console.warn("[poller] previous poll cycle still running, skipping this tick");
    return;
  }
  isPolling = true;
  try {
    const clips = listActiveClipsForPolling();
    if (clips.length === 0) {
      console.log("[poller] no active clips to poll");
      return;
    }
    console.log(`[poller] polling ${clips.length} active clip(s)`);
    for (const clip of clips) {
      await pollClip(clip);
    }
  } finally {
    isPolling = false;
  }
}

export function startPoller(intervalSeconds: number = getPollIntervalSeconds()): NodeJS.Timeout {
  console.log(`[poller] starting, polling every ${intervalSeconds}s`);
  void pollOnce(); // run immediately on startup rather than waiting a full interval
  return setInterval(() => void pollOnce(), intervalSeconds * 1000);
}
