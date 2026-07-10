"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import styles from "./page.module.css";
import {
  fetchCampaign,
  fetchCampaignClips,
  fetchAgentDecisions,
  type Campaign,
  type CampaignClip,
  type AgentDecision,
} from "@/lib/api";
import { formatUsdc, formatRatePerThousandFromNumber, formatRelativeTime } from "@/lib/format";
import TopUpForm from "@/components/organizer/TopUpForm";
import { useOrganizerWallet } from "@/lib/useOrganizerWallet";
import WalletBar from "@/components/shared/WalletBar";
import RoleNav from "@/components/shared/RoleNav";

// Per docs/FRONTEND_DATA_CONTRACT.md Part 3: the decision feed's source
// (Pacing Agent) runs on a longer cycle (PACING_INTERVAL_SECONDS, 120s
// default) than settlements, so it can poll slower than the Clipper
// ticker's ~15-20s — ~30s here.
const POLL_INTERVAL_MS = 30_000;
const DECISION_LIMIT = 50;

function summarizeDecision(d: AgentDecision): string {
  if (d.clip_id === null) {
    return `Campaign-wide — ${d.decision_type.replace(/_/g, " ")}`;
  }
  if (d.old_rate !== null && d.new_rate !== null) {
    if (d.old_rate === d.new_rate) {
      return `Clip #${d.clip_id} — rate held at ${formatRatePerThousandFromNumber(d.new_rate)}`;
    }
    return `Clip #${d.clip_id} — rate ${formatRatePerThousandFromNumber(d.old_rate)} → ${formatRatePerThousandFromNumber(d.new_rate)}`;
  }
  return `Clip #${d.clip_id} — ${d.decision_type.replace(/_/g, " ")}`;
}

export default function OrganizerCampaignPage() {
  const params = useParams<{ id: string }>();
  const campaignId = params.id;

  const wallet = useOrganizerWallet();

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [campaignLoading, setCampaignLoading] = useState(true);
  const [campaignError, setCampaignError] = useState<string | null>(null);

  const [clips, setClips] = useState<CampaignClip[] | null>(null);
  const [clipsLoading, setClipsLoading] = useState(true);
  const [clipsError, setClipsError] = useState<string | null>(null);

  const [decisions, setDecisions] = useState<AgentDecision[] | null>(null);
  const [decisionsLoading, setDecisionsLoading] = useState(true);
  const [decisionsError, setDecisionsError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const [now, setNow] = useState(Date.now());
  const [decisionsSecondsAgo, setDecisionsSecondsAgo] = useState(0);
  const [hasLoadedDecisionsOnce, setHasLoadedDecisionsOnce] = useState(false);

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
    try {
      const data = await fetchCampaignClips(campaignId);
      setClips(data);
      setClipsError(null);
    } catch (err) {
      setClipsError(err instanceof Error ? err.message : "Failed to load clips");
    } finally {
      setClipsLoading(false);
    }
  }, [campaignId]);

  const loadDecisions = useCallback(async () => {
    try {
      const data = await fetchAgentDecisions(campaignId, DECISION_LIMIT);
      setDecisions(data);
      setDecisionsError(null);
      setDecisionsSecondsAgo(0);
      setHasLoadedDecisionsOnce(true);
    } catch (err) {
      setDecisionsError(err instanceof Error ? err.message : "Failed to load agent decisions");
    } finally {
      setDecisionsLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    setCampaignLoading(true);
    loadCampaign();
    const interval = setInterval(loadCampaign, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadCampaign]);

  useEffect(() => {
    setClipsLoading(true);
    loadClips();
    const interval = setInterval(loadClips, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadClips]);

  useEffect(() => {
    setDecisionsLoading(true);
    loadDecisions();
    const interval = setInterval(loadDecisions, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadDecisions]);

  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      setDecisionsSecondsAgo((s) => s + 1);
    }, 1000);
    return () => clearInterval(t);
  }, []);

  function toggleExpanded(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const runwayPercent = campaign?.runway_percent ?? 0;
  const runwayLow = runwayPercent < 20;

  return (
    <main className={styles.page}>
      <div className={styles.wrap}>
        <RoleNav role="organizer" active="campaigns" />
        <WalletBar {...wallet} role="organizer" />

        <div className={styles.scopeBanner}>
          Topping up below signs a real transaction with a real Circle-managed organizer wallet (PIN approval).
          Creating a brand-new campaign lives on the Organizer Profile page. Note: <code>topUp()</code> has no
          on-chain access control by design — anyone can add funds to any campaign — so this form doesn&rsquo;t
          check &ldquo;is this your campaign&rdquo; before allowing a top-up, same as the contract itself.
        </div>

        {campaignLoading ? (
          <div className={styles.skeletonBlock}>Loading campaign…</div>
        ) : campaignError ? (
          <div className={styles.errorBanner}>{campaignError}</div>
        ) : campaign ? (
          <header className={styles.header}>
            <h1 className={styles.title}>Campaign #{campaign.id}</h1>
            <div className={styles.poolCard}>
              <div className={styles.poolLabel}>Pool health</div>
              <div className={styles.poolBarTrack}>
                <div
                  className={runwayLow ? styles.poolBarFillLow : styles.poolBarFill}
                  style={{ width: `${Math.max(0, Math.min(100, runwayPercent))}%` }}
                />
              </div>
              <div className={styles.poolNumbers}>
                <span>
                  {formatUsdc(campaign.remaining_balance)} <span className={styles.muted}>of {formatUsdc(campaign.total_budget)}</span>
                </span>
                <span className={runwayLow ? styles.poolPercentLow : styles.muted}>{runwayPercent.toFixed(1)}% remaining</span>
              </div>
            </div>
            <div className={styles.topUpWrap}>
              <TopUpForm contractCampaignId={campaign.contract_campaign_id} onFunded={loadCampaign} />
            </div>
            <div className={styles.statRow}>
              <div className={styles.stat}>
                <div className={styles.statLabel}>Spend velocity</div>
                <div className={styles.statValue}>{formatUsdc(campaign.spend_velocity_last_hour)}/hr</div>
              </div>
              <div className={styles.stat}>
                <div className={styles.statLabel}>Base rate</div>
                <div className={styles.statValue}>{formatUsdc(campaign.cpm_rate)}/1,000</div>
              </div>
              <div className={styles.stat}>
                <div className={styles.statLabel}>Clips</div>
                <div className={styles.statValue}>{campaign.clip_count}</div>
              </div>
            </div>
          </header>
        ) : null}

        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Submitted clips</h2>
          {clipsLoading ? (
            <div className={styles.skeletonBlock}>Loading clips…</div>
          ) : clipsError ? (
            <div className={styles.errorBanner}>{clipsError}</div>
          ) : clips && clips.length === 0 ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyTitle}>No clips submitted yet</div>
            </div>
          ) : (
            <div className={styles.clipList}>
              {clips?.map((clip) => (
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
                    {clip.is_capped ? <span className={styles.pillCapped}>Cap reached</span> : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className={styles.feedCard}>
          <div className={styles.feedHead}>
            <h2 className={styles.feedTitle}>Pacing Agent — decision feed</h2>
            {hasLoadedDecisionsOnce && (
              <span className={styles.freshness}>
                <span className={styles.pulse} /> updated {decisionsSecondsAgo}s ago
              </span>
            )}
          </div>
          {decisionsLoading && !hasLoadedDecisionsOnce ? (
            <div className={styles.skeletonBlockDark}>Loading decisions…</div>
          ) : decisionsError ? (
            <div className={styles.errorBanner}>{decisionsError}</div>
          ) : decisions && decisions.length === 0 ? (
            <div className={styles.emptyStateDark}>
              <div className={styles.emptyTitleDark}>No agent decisions logged yet</div>
              <p className={styles.emptyDescDark}>
                The Pacing Agent needs at least two clips with recent view activity to have anything to
                allocate between. Nothing to show until it runs against this campaign.
              </p>
            </div>
          ) : (
            <div className={styles.decisionList}>
              {decisions?.map((d) => {
                const isExpanded = expanded.has(d.id);
                return (
                  <div key={d.id} className={styles.decisionRow}>
                    <div className={styles.decisionTime}>{formatRelativeTime(d.created_at, now)}</div>
                    <div className={styles.decisionBody}>
                      <button type="button" className={styles.decisionSummaryBtn} onClick={() => toggleExpanded(d.id)}>
                        <span className={styles.decisionSummary}>{summarizeDecision(d)}</span>
                        {d.llm_used ? (
                          <span className={styles.pillLlm}>Claude-adjusted</span>
                        ) : (
                          <span className={styles.pillFormula}>Formula</span>
                        )}
                        <span className={styles.expandArrow}>{isExpanded ? "▲" : "▼"}</span>
                      </button>
                      {isExpanded && d.rationale && <p className={styles.rationale}>{d.rationale}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
