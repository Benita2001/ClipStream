"use client";

import { useState, type FormEvent } from "react";
import styles from "./TopUpForm.module.css";
import { topUpFlow } from "@/lib/circleTransactions";
import { parseUsdcToBaseUnits } from "@/lib/format";

export default function TopUpForm({
  contractCampaignId,
  onFunded,
}: {
  contractCampaignId: string;
  onFunded: () => void;
}) {
  const [amount, setAmount] = useState("5");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const amountBaseUnits = parseUsdcToBaseUnits(amount);
      if (BigInt(amountBaseUnits) === 0n) {
        throw new Error("Top-up amount must be greater than zero");
      }
      const { txHash } = await topUpFlow({
        contractCampaignId,
        amountBaseUnits,
        onStatus: setStatus,
      });
      setResult(txHash);
      onFunded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fund campaign");
    } finally {
      setSubmitting(false);
      setStatus(null);
    }
  }

  return (
    <div className={styles.card}>
      <h3 className={styles.title}>Add funds</h3>
      <form onSubmit={handleSubmit} className={styles.form}>
        <input
          className={styles.input}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={submitting}
          inputMode="decimal"
          placeholder="$ USDC"
        />
        <button type="submit" className={`btn ${styles.submitBtn}`} disabled={submitting}>
          {submitting ? status || "Working…" : "Top up"}
        </button>
      </form>
      {error && <div className={styles.error}>{error}</div>}
      {result && (
        <div className={styles.success}>
          Funded —{" "}
          <a
            href={`https://testnet.arcscan.app/tx/${result}`}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.successLink}
          >
            view transaction ↗
          </a>
        </div>
      )}
    </div>
  );
}
