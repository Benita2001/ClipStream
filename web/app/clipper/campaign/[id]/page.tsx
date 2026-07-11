"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import styles from "./page.module.css";
import {
  fetchCampaign,
  fetchClipperClips,
  fetchClipEarnings,
  submitClip,
  type Campaign,
  type CampaignClip,
  type ClipEarnings,
} from "@/lib/api";
import { formatUsdc, formatRatePerThousand } from "@/lib/format";
import { useClipperWallet } from "@/lib/useClipperWallet";
import WalletBar from "@/components/shared/WalletBar";
import RoleNav from "@/components/shared/RoleNav";

// Per docs/FRONTEND_DATA_CONTRACT.md Part 3: the View Poller/Settlement
// Worker only update every 60s, so polling faster than ~15-20s just
// re-fetches unchanged data.
const POLL_INTERVAL_MS = 17_000;

export default function ClipperCampaignPage() {
  const params = useParams<{ id: string }>();
  const campaignId = params.id;

  const wallet = useClipperWallet();
  const { activeWallet } = wallet;

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [campaignLoading, setCampaignLoading] = useState(true);
  const [campaignError, setCampaignError] = useState<string | null>(null);

  const [clips, setClips] = useState<CampaignClip[] | null>(null);
  const [clipsLoading, setClipsLoading] = useState(true);
  const [clipsError, setClipsError] = useState<string | null>(null);

  const [earningsByClipId, setEarningsByClipId] = useState<Record<number, ClipEarnings>>({});

  const [secondsAgo, setSecondsAgo] = useState(0);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  const [tweetUrl, setTweetUrl] = useState("");
  const [submitState, setSubmitState] = useState<"idle" | "submitting" | "error" | "success">("idle");
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);

  const loadCampaign = useCallback(async () => {
    try {
      const data = await fetchCampaign(campaignId);
      setCampaign(data);
      setCampaignError(null);
    } catch (err) {
      setCampaignError(err instanceof Error ? err.message : "Failed to load campaign");
    } finally {
      setCampaignLoading(false);
    }
  }, [campaignId]);

  const loadClips = useCallback(async () => {
    if (!activeWallet) {
      setClips(null);
      setClipsLoading(false);
      return;
    }
    try {
      const data = await fetchClipperClips(campaignId, activeWallet);
      setClips(data);
      setClipsError(null);

      // Tx links only exist on the per-clip earnings-detail endpoint, so
      // only fetch it for clips that have actually earned something —
      // no point round-tripping for a clip sitting at "0".
      const earningClips = data.filter((c) => c.total_earnings !== "0");
      const results = await Promise.all(
        earningClips.map(async (c) => {
          try {
            return [c.id, await fetchClipEarnings(c.id)] as const;
          } catch {
            return null;
          }
        })
      );
      setEarningsByClipId((prev) => {
        const next = { ...prev };
        for (const result of results) {
          if (result) next[result[0]] = result[1];
        }
        return next;
      });

      setSecondsAgo(0);
      setHasLoadedOnce(true);
    } catch (err) {
      setClipsError(err instanceof Error ? err.message : "Failed to load clips");
    } finally {
      setClipsLoading(false);
    }
  }, [campaignId, activeWallet]);

  useEffect(() => {
    setCampaignLoading(true);
    loadCampaign();
    const interval = setInterval(loadCampaign, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadCampaign]);

  useEffect(() => {
    setClipsLoading(true);
    setHasLoadedOnce(false);
    loadClips();
    const interval = setInterval(loadClips, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadClips]);

  useEffect(() => {
    const t = setInterval(() => setSecondsAgo((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const totalEarnings = (clips ?? []).reduce((sum, c) => sum + BigInt(c.total_earnings), 0n).toString();

  async function handleSubmitClip(e: FormEvent) {
    e.preventDefault();
    if (!tweetUrl.trim() || !activeWallet) return;
    setSubmitState("submitting");
    setSubmitMessage(null);
    try {
      const result = await submitClip({
        campaign_id: Number(campaignId),
        clipper_wallet: activeWallet,
        url: tweetUrl.trim(),
      });
      setSubmitState("success");
      setSubmitMessage(`Clip submitted — ${result.ownership}`);
      setTweetUrl("");
      loadClips();
    } catch (err) {
      setSubmitState("error");
      setSubmitMessage(err instanceof Error ? err.message : "Failed to submit clip");
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.wrap}>
        <RoleNav role="clipper" active="campaigns" />
        <WalletBar {...wallet} />

        {campaignLoading ? (
          <div className={styles.skeletonBlock}>Loading campaign…</div>
        ) : campaignError ? (
          <div className={styles.errorBanner}>{campaignError}</div>
        ) : campaign ? (
          <header className={styles.header}>
            <h1 className={styles.title}>
              {campaign.name}
              <span className={styles.titleId}>#{campaign.id}</span>
              {campaign.status === "closed" && <span className={styles.pillClosed}>Closed</span>}
            </h1>
            <div className={styles.statRow}>
              <div className={styles.stat}>
                <div className={styles.statLabel}>Current rate</div>
                <div className={styles.statValue}>{formatRatePerThousand(campaign.cpm_rate)}</div>
              </div>
              <div className={styles.stat}>
                <div className={styles.statLabel}>Remaining pool</div>
                <div className={styles.statValue}>
                  {formatUsdc(campaign.remaining_balance)}{" "}
                  <span className={styles.muted}>of {formatUsdc(campaign.total_budget)}</span>
                </div>
              </div>
            </div>
            {campaign.description && <p className={styles.description}>{campaign.description}</p>}
            {campaign.source_link && (
              <a href={campaign.source_link} target="_blank" rel="noopener noreferrer" className={styles.sourceLink}>
                Source ↗
              </a>
            )}
          </header>
        ) : null}

        {activeWallet && (
        <>
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Submit a clip</h2>
          {campaign?.status === "closed" ? (
            <p className={styles.closedNotice}>
              This campaign is closed — its pool is fully spent, so it&rsquo;s no longer accepting new clips. Existing
              clips below keep their earnings history.
            </p>
          ) : (
            <>
              <form onSubmit={handleSubmitClip} className={styles.submitForm}>
                <input
                  type="text"
                  placeholder="https://x.com/handle/status/…"
                  value={tweetUrl}
                  onChange={(e) => setTweetUrl(e.target.value)}
                  className={styles.input}
                />
                <button type="submit" className="btn" disabled={submitState === "submitting"}>
                  {submitState === "submitting" ? "Submitting…" : "Submit"}
                </button>
              </form>
              {submitMessage && (
                <div className={submitState === "error" ? styles.errorBanner : styles.successBanner}>
                  {submitMessage}
                </div>
              )}
            </>
          )}
        </section>

        <section className={styles.tickerCard}>
          <div className={styles.tickerHead}>
            <span className={styles.tickerLabel}>Your earnings in this campaign</span>
            {hasLoadedOnce && (
              <span className={styles.freshness}>
                <span className={styles.pulse} /> updated {secondsAgo}s ago
              </span>
            )}
          </div>
          {clipsLoading && !hasLoadedOnce ? (
            <div className={styles.skeletonBlockDark}>Loading earnings…</div>
          ) : clipsError ? (
            <div className={styles.errorBanner}>{clipsError}</div>
          ) : (
            <div className={styles.tickerAmount}>{formatUsdc(totalEarnings)}</div>
          )}
        </section>

        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Your clips</h2>
          {clipsLoading && !hasLoadedOnce ? (
            <div className={styles.skeletonBlock}>Loading clips…</div>
          ) : clipsError ? (
            <div className={styles.errorBanner}>{clipsError}</div>
          ) : clips && clips.length === 0 ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyTitle}>No clips submitted yet</div>
              <p className={styles.emptyDesc}>
                Submit your first tweet above — once it&rsquo;s live, views start counting and payouts begin.
              </p>
            </div>
          ) : (
            <div className={styles.clipList}>
              {clips?.map((clip) => {
                const detail = earningsByClipId[clip.id];
                const latestTx = detail?.recent_settlements?.[0];
                return (
                  <div key={clip.id} className={styles.clipRow}>
                    <div className={styles.clipInfo}>
                      <div className={styles.clipName}>Clip #{clip.id}</div>
                      <div className={styles.clipUrl}>{clip.url}</div>
                    </div>
                    <div className={styles.clipStat}>
                      <div className={styles.clipColLabel}>Views</div>
                      <div className={styles.clipValue}>
                        {clip.current_view_count !== null ? clip.current_view_count.toLocaleString() : "—"}
                      </div>
                    </div>
                    <div className={styles.clipStat}>
                      <div className={styles.clipColLabel}>Earned</div>
                      <div className={styles.clipValueAccent}>{formatUsdc(clip.total_earnings)}</div>
                    </div>
                    <div className={styles.clipStatus}>
                      {clip.is_capped ? (
                        <span className={styles.pillCapped}>Cap reached</span>
                      ) : latestTx?.tx_url ? (
                        <a href={latestTx.tx_url} target="_blank" rel="noopener noreferrer" className={styles.txLink}>
                          View transaction ↗
                        </a>
                      ) : (
                        <span className={styles.muted}>No payouts yet</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
        </>
        )}
      </div>
    </main>
  );
}
