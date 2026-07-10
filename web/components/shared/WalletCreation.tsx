"use client";

import { useState } from "react";
import { createCircleWallet, type CircleWalletSession, type CircleWalletOwnerType } from "@/lib/circleWallets";
import styles from "./WalletCreation.module.css";

/**
 * Shared by both roles — ownerType controls both the copy below and which
 * role the resulting wallet is tagged with server-side. Moved here from
 * components/clipper/ once the organizer role started using it too (nothing
 * in here was ever actually clipper-specific).
 */
export default function WalletCreation({
  onCreated,
  ownerType = "clipper",
}: {
  onCreated: (session: CircleWalletSession) => void;
  ownerType?: CircleWalletOwnerType;
}) {
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      const session = await createCircleWallet(setStatus, ownerType);
      onCreated(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet creation failed");
    } finally {
      setCreating(false);
      setStatus(null);
    }
  }

  return (
    <div className={styles.card}>
      <h2 className={styles.title}>Create your wallet</h2>
      <p className={styles.desc}>
        {ownerType === "organizer"
          ? "A Circle-managed wallet on Arc Testnet — no seed phrase, secured with a PIN you set. This is the wallet you'll sign campaign creation and funding transactions with."
          : "A Circle-managed wallet on Arc Testnet — no seed phrase, secured with a PIN you set. This is where your campaign earnings get paid out."}
      </p>
      <button type="button" className="btn" onClick={handleCreate} disabled={creating}>
        {creating ? status || "Working…" : "Create your wallet"}
      </button>
      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}
