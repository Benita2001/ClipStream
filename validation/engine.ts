/**
 * Heuristic view-delta validator for ClipStream.
 *
 * Clips are tweet URLs — viewers watch on X, not on ClipStream. There is no
 * viewer-side telemetry; the only signal is X's public `impression_count`,
 * read by polling. This module sanity-checks the *delta* between two polls
 * of the same tweet before the Settlement Agent pays out on it. It is a
 * heuristic plausibility check on public view-count data, not fraud
 * detection — it has no opinion on whether the underlying views are bots,
 * ad spend, or organic reach, only on whether the reported delta is
 * internally consistent given the elapsed time between polls.
 *
 * Pure function, no I/O: both snapshots (impression counts + poll
 * timestamps) must already be supplied by the caller — typically the two
 * most recent rows from `view_snapshots` for a clip (see
 * `getLatestViewSnapshotForClip` / `listViewSnapshotsForClip` in db/db.ts).
 * This module never polls X or touches the database itself, which is what
 * keeps it cheap to unit test in isolation.
 */

export interface ViewDeltaEvent {
  clipId: string;
  tweetId: string;
  previousImpressionCount: number;
  currentImpressionCount: number;
  previousPolledAt: string;
  currentPolledAt: string;
}

export type ValidationStatus = "APPROVED" | "REJECTED";

export interface ValidationResult {
  status: ValidationStatus;
  reason: string;
}

/**
 * Generous ceiling on views gained per second of elapsed time between polls.
 * Real viral spikes can be fast, so this is intentionally loose — it exists
 * to catch obviously-wrong data (e.g. a misattributed snapshot or a counter
 * reset), not to second-guess genuine virality. Tune freely; this is a
 * heuristic, not a modeled bound.
 */
export const MAX_PLAUSIBLE_VIEWS_PER_SECOND = 5000;

export function validateViewDelta(event: ViewDeltaEvent): ValidationResult {
  const { tweetId, previousImpressionCount, currentImpressionCount, previousPolledAt, currentPolledAt } = event;

  // Impression counts are monotonically non-decreasing on X; a drop means
  // the snapshots are out of order, mismatched, or the count was reset —
  // never a real negative view delta.
  if (currentImpressionCount < previousImpressionCount) {
    return {
      status: "REJECTED",
      reason:
        `impression_count for tweet ${tweetId} dropped from ${previousImpressionCount} to ` +
        `${currentImpressionCount} — view counts should only climb`,
    };
  }

  const elapsedMs = new Date(currentPolledAt).getTime() - new Date(previousPolledAt).getTime();
  const elapsedSeconds = elapsedMs / 1000;

  // Need a positive interval to reason about a rate at all — a non-positive
  // gap means the polls are out of order or mis-timestamped.
  if (elapsedSeconds <= 0) {
    return {
      status: "REJECTED",
      reason:
        `poll interval for tweet ${tweetId} is non-positive (${elapsedSeconds}s between ` +
        `${previousPolledAt} and ${currentPolledAt}) — cannot validate a rate`,
    };
  }

  const delta = currentImpressionCount - previousImpressionCount;
  const viewsPerSecond = delta / elapsedSeconds;

  if (viewsPerSecond > MAX_PLAUSIBLE_VIEWS_PER_SECOND) {
    return {
      status: "REJECTED",
      reason:
        `tweet ${tweetId} gained ${delta} views in ${elapsedSeconds}s (${viewsPerSecond.toFixed(1)}/s), ` +
        `exceeding the plausible ceiling of ${MAX_PLAUSIBLE_VIEWS_PER_SECOND}/s — implausible jump`,
    };
  }

  return {
    status: "APPROVED",
    reason: `approved: tweet ${tweetId} gained ${delta} views over ${elapsedSeconds}s (${viewsPerSecond.toFixed(2)}/s)`,
  };
}
