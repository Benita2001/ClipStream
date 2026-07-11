"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import styles from "./page.module.css";
import { fetchOrganizerCampaigns, type OrganizerCampaigns } from "@/lib/api";
import { formatUsdc, formatRatePerThousand, formatRelativeTime } from "@/lib/format";
import CreateCampaignForm from "@/components/organizer/CreateCampaignForm";
import { useOrganizerWallet } from "@/lib/useOrganizerWallet";
import WalletBar from "@/components/shared/WalletBar";
import RoleNav from "@/components/shared/RoleNav";

export default function OrganizerProfilePage() {
  const wallet = useOrganizerWallet();
  const { activeWallet, showDevOverride, setShowDevOverride } = wallet;

  const [data, setData] = useState<OrganizerCampaigns | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [showCreateForm, setShowCreateForm] = useState(false);

  const load = useCallback(async () => {
    if (!activeWallet) {
      setData(null);
      setLoading(false);
      return;
    }
    try {
      const result = await fetchOrganizerCampaigns(activeWallet);
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load organizer campaigns");
    } finally {
      setLoading(false);
    }
  }, [activeWallet]);

  // Deliberately no auto-poll interval, same reasoning as the Clipper
  // Profile page: this is a summary an organizer checks in on, not a live
  // ticker they watch move. Aggregate spend specifically doesn't warrant
  // live updates either — it only changes as fast as the Settlement
  // Worker's 60s cadence, and granular real-time spend (spend velocity,
  // the decision feed) already lives on the per-campaign Organizer
  // Campaign page this list links out to; duplicating that liveness here
  // would just be re-polling the same slow-moving numbers on a second
  // page. Loads once per wallet change, plus a manual Refresh button.
  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!loading) {
      setLastLoadedAt((prev) => prev ?? Date.now());
    }
  }, [loading]);

  async function handleRefresh() {
    setRefreshing(true);
    await load();
    setLastLoadedAt(Date.now());
    setRefreshing(false);
  }

  function handleCampaignCreated(_campaignId: number, organizerWallet: string) {
    setShowCreateForm(false);
    // createCampaignFlow always signs with the real Circle-managed
    // organizer wallet (ensureOrganizerWallet), regardless of whether a
    // dev-preview override is currently active — so if someone was
    // previewing a different wallet when they created a campaign, switch
    // back to their real wallet's view so the new campaign is actually
    // visible, rather than leaving them looking at the wallet they were
    // just previewing (which doesn't own it).
    if (showDevOverride) {
      setShowDevOverride(false);
    }
    if (organizerWallet === activeWallet) {
      load();
    }
    // If it wasn't already the active wallet (dev override was on, or this
    // is the very first campaign right after wallet creation), the
    // activeWallet derivation itself updates once showDevOverride flips off
    // / circleWallet is set — the load() effect keyed on activeWallet picks
    // it up from there.
  }

  return (
    <main className={styles.page}>
      <div className={styles.wrap}>
        <RoleNav role="organizer" active="profile" />
        <WalletBar {...wallet} role="organizer" />

        {activeWallet && (
          <>
            <header className={styles.header}>
              <h1 className={styles.title}>Organizer profile</h1>
              <div className={styles.walletSubtitle}>{activeWallet}</div>
            </header>

            {/* Aggregate spend */}
            <section className={styles.tickerCard}>
              <div className={styles.tickerHead}>
                <span className={styles.tickerLabel}>Aggregate spend</span>
                <button type="button" className={styles.refreshBtn} onClick={handleRefresh} disabled={refreshing || loading}>
                  {refreshing ? "Refreshing…" : "Refresh"}
                  {!refreshing && lastLoadedAt && (
                    <span className={styles.refreshedAt}> · as of {formatRelativeTime(new Date(lastLoadedAt).toISOString(), now)}</span>
                  )}
                </button>
              </div>
              {loading || !data ? (
                <div className={styles.skeletonBlockDark}>Loading spend…</div>
              ) : error ? (
                <div className={styles.errorBanner}>{error}</div>
              ) : (
                <>
                  <div className={styles.tickerAmount}>{formatUsdc(data.aggregate_spend)}</div>
                  <div className={styles.tickerSub}>
                    across {data.campaigns.length} campaign{data.campaigns.length === 1 ? "" : "s"}
                  </div>
                </>
              )}
            </section>

            {/* Create a new campaign */}
            {showCreateForm ? (
              <CreateCampaignForm onCreated={handleCampaignCreated} />
            ) : (
              <button type="button" className={`btn ${styles.newCampaignBtn}`} onClick={() => setShowCreateForm(true)}>
                + Create a new campaign
              </button>
            )}

            {/* Campaigns created */}
            <section id="your-campaigns" className={styles.card}>
              <h2 className={styles.cardTitle}>Your campaigns</h2>
              {loading || !data ? (
                <div className={styles.skeletonBlock}>Loading campaigns…</div>
              ) : error ? (
                <div className={styles.errorBanner}>{error}</div>
              ) : data.campaigns.length === 0 ? (
                <div className={styles.emptyState}>
                  <div className={styles.emptyTitle}>You haven&rsquo;t created any campaigns yet</div>
                  <p className={styles.emptyDesc}>
                    Once you fund a campaign on-chain and it&rsquo;s indexed, it&rsquo;ll show up here with its rate,
                    remaining pool, and status — click through to manage it.
                  </p>
                </div>
              ) : (
                <div className={styles.campaignList}>
                  {data.campaigns.map((c) => (
                    <Link key={c.id} href={`/organizer/campaign/${c.id}`} className={styles.campaignRow}>
                      <div className={styles.campaignInfo}>
                        <div className={styles.campaignName}>
                          {c.name} <span className={styles.muted}>#{c.id}</span>
                        </div>
                        <span className={c.status === "active" ? styles.pillActive : styles.pillClosed}>{c.status}</span>
                      </div>
                      <div className={styles.campaignStat}>
                        <div className={styles.campaignColLabel}>Rate</div>
                        <div className={styles.campaignValue}>{formatRatePerThousand(c.cpm_rate)}</div>
                      </div>
                      <div className={styles.campaignStat}>
                        <div className={styles.campaignColLabel}>Remaining pool</div>
                        <div className={styles.campaignValue}>
                          {formatUsdc(c.remaining_balance)} <span className={styles.muted}>of {formatUsdc(c.total_budget)}</span>
                        </div>
                      </div>
                      <div className={styles.campaignArrow}>→</div>
                    </Link>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
