"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import styles from "./page.module.css";
import { fetchCampaigns, type Campaign } from "@/lib/api";
import { formatUsdc, formatRatePerThousand } from "@/lib/format";
import { useClipperWallet } from "@/lib/useClipperWallet";
import WalletBar from "@/components/shared/WalletBar";
import RoleNav from "@/components/shared/RoleNav";

/**
 * The missing discovery step: before this page existed, joining a campaign
 * required already knowing its numeric id and typing it into
 * /clipper/campaign/[id] directly. Browsing doesn't require a wallet (only
 * submitting a clip on the detail page does), so the list itself isn't
 * gated behind activeWallet — WalletBar is still shown for consistent page
 * chrome and so a visitor without a wallet yet sees the same onboarding
 * prompt they'd see on Profile.
 */
export default function ClipperCampaignsPage() {
  const wallet = useClipperWallet();

  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchCampaigns();
      setCampaigns(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load campaigns");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  return (
    <main className={styles.page}>
      <div className={styles.wrap}>
        <RoleNav role="clipper" active="campaigns" />
        <WalletBar {...wallet} />

        <header className={styles.header}>
          <h1 className={styles.title}>Open campaigns</h1>
          <p className={styles.subtitle}>Pick one and submit a tweet URL to start earning per view.</p>
        </header>

        <section className={styles.card}>
          {loading ? (
            <div className={styles.skeletonBlock}>Loading campaigns…</div>
          ) : error ? (
            <div className={styles.errorBanner}>{error}</div>
          ) : campaigns && campaigns.length === 0 ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyTitle}>No open campaigns right now</div>
              <p className={styles.emptyDesc}>Check back soon — new campaigns show up here as organizers fund them.</p>
            </div>
          ) : (
            <div className={styles.campaignList}>
              {campaigns?.map((c) => (
                <Link key={c.id} href={`/clipper/campaign/${c.id}`} className={styles.campaignRow}>
                  <div className={styles.campaignInfo}>
                    <div className={styles.campaignName}>
                      {c.name} <span className={styles.muted}>#{c.id}</span>
                    </div>
                    {c.status === "closed" ? (
                      <span className={styles.pillClosed}>Closed</span>
                    ) : (
                      <span className={styles.pillActive}>{c.status}</span>
                    )}
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
                  <div className={styles.campaignStat}>
                    <div className={styles.campaignColLabel}>Clips</div>
                    <div className={styles.campaignValue}>{c.clip_count}</div>
                  </div>
                  <div className={styles.campaignArrow}>→</div>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
