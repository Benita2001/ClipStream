"use client";

import styles from "./WalletBar.module.css";
import WalletCreation from "./WalletCreation";
import { API_BASE, type CircleWalletOwnerType } from "@/lib/circleWallets";
import type { UseClipperWalletResult } from "@/lib/useClipperWallet";

const ROLE_LABEL: Record<CircleWalletOwnerType, string> = {
  clipper: "Clipper",
  organizer: "Organizer",
};

/**
 * Renders the same three-way wallet state (real Circle wallet bar / dev
 * override input / wallet-creation flow) on both roles' Profile and
 * Campaign pages. Takes useClipperWallet()/useOrganizerWallet()'s return
 * value directly as props — the two hooks share an identical shape
 * (UseClipperWalletResult), so one component serves both. `role` only
 * controls copy (the "Welcome, X" heading, WalletCreation's ownerType) —
 * the wallet-state logic itself is role-agnostic.
 */
export default function WalletBar(wallet: UseClipperWalletResult & { role?: CircleWalletOwnerType }) {
  const {
    circleWallet,
    checkedStorage,
    showDevOverride,
    setShowDevOverride,
    walletInput,
    setWalletInput,
    setDevOverrideWallet,
    setCircleWallet,
    role = "clipper",
  } = wallet;

  if (!checkedStorage) return null;

  if (circleWallet && !showDevOverride) {
    return (
      <div className={styles.walletBar}>
        <span className={styles.walletLabel}>Your wallet</span>
        <span className={styles.walletAddress}>{circleWallet.address}</span>
        <button type="button" className={styles.linkBtn} onClick={() => setShowDevOverride(true)}>
          or preview another wallet
        </button>
      </div>
    );
  }

  if (showDevOverride) {
    return (
      <div className={styles.devWalletBar}>
        <label htmlFor="devWallet" className={styles.devWalletLabel}>
          Previewing another wallet (dev)
        </label>
        <div className={styles.devWalletRow}>
          <input
            id="devWallet"
            className={styles.devWalletInput}
            value={walletInput}
            onChange={(e) => setWalletInput(e.target.value)}
          />
          <button type="button" className={`btn ${styles.smallBtn}`} onClick={() => setDevOverrideWallet(walletInput.trim())}>
            View
          </button>
          {circleWallet && (
            <button type="button" className={styles.linkBtn} onClick={() => setShowDevOverride(false)}>
              back to your wallet
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.onboardingWrap}>
      <div className={styles.onboardingInner}>
        <h1 className={styles.welcomeHeading}>Welcome, {ROLE_LABEL[role]}</h1>
        <WalletCreation
          ownerType={role}
          onCreated={(session) => {
            setCircleWallet(session);
            setShowDevOverride(false);
          }}
        />
        {/* Recovery only exists for clippers today — only clippers link an X
            account (for clip-ownership verification), which is the proven-
            ownership signal the recovery flow relies on. Organizers have no
            equivalent linked identity yet, so there's nothing to recover
            against for that role. See CLAUDE.md's Part 5 entry. */}
        {role === "clipper" && (
          <a href={`${API_BASE}/auth/x/start?mode=recover`} className={styles.recoverLink}>
            Already have a wallet? Recover it with X
          </a>
        )}
      </div>
    </div>
  );
}
