"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./page.module.css";
import {
  fetchClipperProfile,
  fetchClipperSettlements,
  type ClipperProfile,
  type ClipperSettlement,
} from "@/lib/api";
import { formatUsdc, formatRatePerThousand, formatRelativeTime } from "@/lib/format";
import { useClipperWallet } from "@/lib/useClipperWallet";
import { clearStoredWallet, resumeRecoveredWallet } from "@/lib/circleWallets";
import WalletBar from "@/components/shared/WalletBar";
import RoleNav from "@/components/shared/RoleNav";

// Same base URL convention as lib/circleWallets.ts — needed here directly
// (rather than only inside lib/api.ts) because /auth/x/start is a full-page
// redirect link, not a fetch call.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3000";

export default function ClipperProfilePage() {
  const wallet = useClipperWallet();
  const { activeWallet, circleWallet, showDevOverride, setCircleWallet } = wallet;

  const [profile, setProfile] = useState<ClipperProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [settlements, setSettlements] = useState<ClipperSettlement[] | null>(null);
  const [settlementsLoading, setSettlementsLoading] = useState(true);
  const [settlementsError, setSettlementsError] = useState<string | null>(null);

  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [linkedHandle, setLinkedHandle] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  // Picks up the redirect back from server/oauth.ts's mode=recover flow
  // (see CLAUDE.md's Part 5 entry), and now also mode=link (the default
  // "Link your X account" flow below) — that used to respond with bare
  // JSON straight from /auth/x/callback instead of redirecting back here,
  // a real, confusing gap for a normal user linking X for the first time.
  // Both modes redirect to this same page now; the query param names tell
  // them apart. Read directly off window.location rather than Next.js's
  // useSearchParams() — this is a purely client-side, one-time, non-SEO-
  // relevant read, and avoids that hook's Suspense-boundary requirement
  // for a page that's otherwise fully static-eligible.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const recoveredWallet = params.get("recovered_wallet");
    const recoveredUserId = params.get("recovered_user_id");
    const recoveryErrorParam = params.get("recovery_error");
    const linkedHandleParam = params.get("linked_handle");
    const linkErrorParam = params.get("link_error");

    if (recoveredWallet && recoveredUserId) {
      resumeRecoveredWallet(recoveredWallet, recoveredUserId, "clipper")
        .then((session) => setCircleWallet(session))
        .catch((err) => setRecoveryError(err instanceof Error ? err.message : "Failed to resume the recovered wallet"))
        .finally(() => window.history.replaceState({}, "", window.location.pathname));
    } else if (recoveryErrorParam) {
      setRecoveryError(recoveryErrorParam);
      window.history.replaceState({}, "", window.location.pathname);
    } else if (linkedHandleParam) {
      // The link itself already happened server-side (upsertXAccount ran
      // before this redirect) — this param only drives a one-time success
      // banner; the "X account" section's actual linked state below comes
      // from the normal GET /clippers/:wallet/profile fetch, not from this.
      setLinkedHandle(linkedHandleParam);
      window.history.replaceState({}, "", window.location.pathname);
    } else if (linkErrorParam) {
      setLinkError(linkErrorParam);
      window.history.replaceState({}, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadProfile = useCallback(async () => {
    if (!activeWallet) {
      setProfile(null);
      setProfileLoading(false);
      return;
    }
    try {
      const data = await fetchClipperProfile(activeWallet);
      setProfile(data);
      setProfileError(null);
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "Failed to load profile");
    } finally {
      setProfileLoading(false);
    }
  }, [activeWallet]);

  const loadSettlements = useCallback(async () => {
    if (!activeWallet) {
      setSettlements(null);
      setSettlementsLoading(false);
      return;
    }
    try {
      const data = await fetchClipperSettlements(activeWallet);
      setSettlements(data);
      setSettlementsError(null);
    } catch (err) {
      setSettlementsError(err instanceof Error ? err.message : "Failed to load transaction history");
    } finally {
      setSettlementsLoading(false);
    }
  }, [activeWallet]);

  // Deliberately no auto-poll interval on this page — unlike the Clipper
  // Campaign page's live earnings ticker (which a clipper watches update
  // in real time right after submitting a clip), a profile page is a
  // snapshot someone visits and reads, not something stared at waiting for
  // numbers to move. Loads once per wallet change, plus a manual Refresh
  // button below for on-demand freshness.
  useEffect(() => {
    setProfileLoading(true);
    loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    setSettlementsLoading(true);
    loadSettlements();
  }, [loadSettlements]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    await Promise.all([loadProfile(), loadSettlements()]);
    setLastLoadedAt(Date.now());
    setRefreshing(false);
  }

  useEffect(() => {
    if (!profileLoading && !settlementsLoading) {
      setLastLoadedAt((prev) => prev ?? Date.now());
    }
  }, [profileLoading, settlementsLoading]);

  const isDevPreview = showDevOverride;

  return (
    <main className={styles.page}>
      <div className={styles.wrap}>
        <RoleNav role="clipper" active="profile" />
        {recoveryError && <div className={styles.errorBanner}>{recoveryError}</div>}
        {linkError && <div className={styles.errorBanner}>{linkError}</div>}
        {linkedHandle && (
          <div className={styles.successBanner}>Successfully linked X account @{linkedHandle}.</div>
        )}
        <WalletBar {...wallet} />

        {activeWallet && (
          <>
            <header className={styles.header}>
              <h1 className={styles.title}>Your profile</h1>
              <div className={styles.walletSubtitle}>{activeWallet}</div>
            </header>

            {/* X account link status */}
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>X account</h2>
              {profileLoading ? (
                <div className={styles.skeletonBlock}>Loading…</div>
              ) : profileError ? (
                <div className={styles.errorBanner}>{profileError}</div>
              ) : profile?.x_account.linked ? (
                <div className={styles.xLinked}>
                  <span className={styles.xCheck}>✓</span>
                  <span>
                    Linked to <strong>@{profile.x_account.x_handle}</strong>
                  </span>
                </div>
              ) : (
                <div className={styles.xPrompt}>
                  <p className={styles.xPromptText}>
                    Link your X account to submit clips — ownership is verified against your tweets before any
                    clip is accepted.
                  </p>
                  <a
                    href={`${API_BASE}/auth/x/start?wallet_address=${encodeURIComponent(activeWallet)}`}
                    className={`btn ${styles.linkXBtn}`}
                  >
                    Link your X account
                  </a>
                </div>
              )}
            </section>

            {/* Lifetime earnings */}
            <section className={styles.tickerCard}>
              <div className={styles.tickerHead}>
                <span className={styles.tickerLabel}>Lifetime earnings</span>
                <button type="button" className={styles.refreshBtn} onClick={handleRefresh} disabled={refreshing}>
                  {refreshing ? "Refreshing…" : "Refresh"}
                  {!refreshing && lastLoadedAt && (
                    <span className={styles.refreshedAt}> · as of {formatRelativeTime(new Date(lastLoadedAt).toISOString(), now)}</span>
                  )}
                </button>
              </div>
              {profileLoading || !profile ? (
                <div className={styles.skeletonBlockDark}>Loading earnings…</div>
              ) : profileError ? (
                <div className={styles.errorBanner}>{profileError}</div>
              ) : (
                <>
                  <div className={styles.tickerAmount}>{formatUsdc(profile.lifetime_earnings)}</div>
                  <div className={styles.tickerSub}>
                    across {profile.campaigns.length} campaign{profile.campaigns.length === 1 ? "" : "s"}, from{" "}
                    {profile.clips_submitted} clip{profile.clips_submitted === 1 ? "" : "s"} submitted
                  </div>
                </>
              )}
            </section>

            {/* Campaigns participated in */}
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>Your campaigns</h2>
              {profileLoading ? (
                <div className={styles.skeletonBlock}>Loading campaigns…</div>
              ) : profileError ? (
                <div className={styles.errorBanner}>{profileError}</div>
              ) : profile && profile.campaigns.length === 0 ? (
                <div className={styles.emptyState}>
                  <div className={styles.emptyTitle}>You haven&rsquo;t joined any campaigns yet</div>
                  <p className={styles.emptyDesc}>
                    Once you submit a clip to a campaign, it&rsquo;ll show up here with its own earnings
                    breakdown.
                  </p>
                </div>
              ) : (
                <div className={styles.campaignList}>
                  {profile?.campaigns.map((c) => (
                    <div key={c.campaign_id} className={styles.campaignRow}>
                      <div className={styles.campaignInfo}>
                        <div className={styles.campaignName}>Campaign #{c.campaign_id}</div>
                        <span className={c.status === "active" ? styles.pillActive : styles.pillClosed}>{c.status}</span>
                      </div>
                      <div className={styles.campaignStat}>
                        <div className={styles.campaignColLabel}>Rate</div>
                        <div className={styles.campaignValue}>{formatRatePerThousand(c.cpm_rate)}</div>
                      </div>
                      <div className={styles.campaignStat}>
                        <div className={styles.campaignColLabel}>Clips</div>
                        <div className={styles.campaignValue}>{c.clips_submitted}</div>
                      </div>
                      <div className={styles.campaignStat}>
                        <div className={styles.campaignColLabel}>Earned</div>
                        <div className={styles.campaignValueAccent}>{formatUsdc(c.earnings_in_campaign)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Payout / transaction history */}
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>Transaction history</h2>
              {settlementsLoading ? (
                <div className={styles.skeletonBlock}>Loading transaction history…</div>
              ) : settlementsError ? (
                <div className={styles.errorBanner}>{settlementsError}</div>
              ) : settlements && settlements.length === 0 ? (
                <div className={styles.emptyState}>
                  <div className={styles.emptyTitle}>No payouts yet</div>
                  <p className={styles.emptyDesc}>
                    Payouts appear here the moment a settlement lands on-chain — each links to a real Arc
                    Testnet transaction.
                  </p>
                </div>
              ) : (
                <div className={styles.txList}>
                  {settlements?.map((s) => (
                    <div key={s.id} className={styles.txRow}>
                      <div className={styles.txInfo}>
                        <div className={styles.txRef}>
                          Campaign #{s.campaign_id} · Clip #{s.clip_id}
                        </div>
                        <div className={styles.txMeta}>
                          {s.view_delta.toLocaleString()} views · {formatRelativeTime(s.created_at, now)}
                        </div>
                      </div>
                      <div className={styles.txAmount}>{formatUsdc(s.amount)}</div>
                      <div className={styles.txLinkCol}>
                        {s.tx_url ? (
                          <a href={s.tx_url} target="_blank" rel="noopener noreferrer" className={styles.txLink}>
                            View transaction ↗
                          </a>
                        ) : (
                          <span className={styles.muted}>no tx hash</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Minimal account settings */}
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>Account settings</h2>
              <div className={styles.settingsRow}>
                <div className={styles.settingsLabel}>Wallet address</div>
                <div className={styles.settingsValueMono}>{activeWallet}</div>
              </div>
              <div className={styles.settingsRow}>
                <div className={styles.settingsLabel}>Wallet type</div>
                <div className={styles.settingsValue}>
                  {isDevPreview ? "Preview (dev override)" : "Circle-managed (Arc Testnet)"}
                </div>
              </div>
              {circleWallet && !isDevPreview && (
                <div className={styles.settingsRow}>
                  <div className={styles.settingsLabel}>This device</div>
                  <button
                    type="button"
                    className={styles.forgetBtn}
                    onClick={() => {
                      clearStoredWallet();
                      setCircleWallet(null);
                    }}
                  >
                    Forget this wallet on this device
                  </button>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
