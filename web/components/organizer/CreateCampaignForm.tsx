"use client";

import { useState, type FormEvent } from "react";
import styles from "./CreateCampaignForm.module.css";
import { createCampaignFlow } from "@/lib/circleTransactions";
import { indexCampaign } from "@/lib/api";
import { parseUsdcToBaseUnits } from "@/lib/format";

const SECONDS_PER_DAY = 86400;

export default function CreateCampaignForm({
  onCreated,
}: {
  onCreated: (campaignId: number, organizerWallet: string) => void;
}) {
  const [cpmRate, setCpmRate] = useState("0.10");
  const [maxCpm, setMaxCpm] = useState("0.20");
  const [durationDays, setDurationDays] = useState("30");
  const [depositAmount, setDepositAmount] = useState("10");
  const [description, setDescription] = useState("");
  const [sourceLink, setSourceLink] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ txHash: string; campaignId: number } | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const cpmRateBaseUnits = parseUsdcToBaseUnits(cpmRate);
      const maxCpmBaseUnits = parseUsdcToBaseUnits(maxCpm);
      const depositBaseUnits = parseUsdcToBaseUnits(depositAmount);
      if (BigInt(cpmRateBaseUnits) > BigInt(maxCpmBaseUnits)) {
        throw new Error("Rate cannot exceed the max rate ceiling");
      }
      if (BigInt(depositBaseUnits) === 0n) {
        throw new Error("Initial deposit must be greater than zero");
      }
      const durationSeconds = Math.round(Number(durationDays) * SECONDS_PER_DAY);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new Error("Duration must be a positive number of days");
      }
      // base_rate is the on-chain constructor's informational rate field —
      // payouts are always derived from cpm_rate, never this. Mirrors
      // cpm_rate/1000 per the convention already established by the real
      // scripts/arc-testnet-create-campaign.ts deployment (baseRate 100
      // alongside cpmRate 100000), rather than asking the organizer to
      // understand and separately fill in a legacy field.
      const baseRate = Math.floor(Number(cpmRateBaseUnits) / 1000);

      const { txHash, contractCampaignId, organizerWallet } = await createCampaignFlow({
        baseRate,
        maxDuration: durationSeconds,
        depositAmountBaseUnits: depositBaseUnits,
        onStatus: setStatus,
      });

      setStatus("Indexing the campaign…");
      const campaign = await indexCampaign({
        contract_campaign_id: contractCampaignId,
        cpm_rate: cpmRateBaseUnits,
        max_cpm: maxCpmBaseUnits,
        description: description.trim() || null,
        source_link: sourceLink.trim() || null,
      });

      setResult({ txHash, campaignId: campaign.id });
      onCreated(campaign.id, organizerWallet);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create campaign");
    } finally {
      setSubmitting(false);
      setStatus(null);
    }
  }

  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>Create a campaign</h2>
      <form onSubmit={handleSubmit} className={styles.form}>
        <label className={styles.field}>
          <span className={styles.label}>Rate ($ per 1,000 views)</span>
          <input
            className={styles.input}
            value={cpmRate}
            onChange={(e) => setCpmRate(e.target.value)}
            disabled={submitting}
            inputMode="decimal"
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Max rate ceiling ($ per 1,000 views)</span>
          <input
            className={styles.input}
            value={maxCpm}
            onChange={(e) => setMaxCpm(e.target.value)}
            disabled={submitting}
            inputMode="decimal"
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Duration (days)</span>
          <input
            className={styles.input}
            value={durationDays}
            onChange={(e) => setDurationDays(e.target.value)}
            disabled={submitting}
            inputMode="numeric"
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Initial deposit ($ USDC)</span>
          <input
            className={styles.input}
            value={depositAmount}
            onChange={(e) => setDepositAmount(e.target.value)}
            disabled={submitting}
            inputMode="decimal"
          />
        </label>
        <label className={`${styles.field} ${styles.fieldWide}`}>
          <span className={styles.label}>Description / Rules (optional)</span>
          <textarea
            className={styles.textarea}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={submitting}
            placeholder="What clippers should know before joining — content rules, required hashtags, anything relevant."
            rows={4}
          />
        </label>
        <label className={`${styles.field} ${styles.fieldWide}`}>
          <span className={styles.label}>Source link (optional)</span>
          <input
            className={styles.input}
            value={sourceLink}
            onChange={(e) => setSourceLink(e.target.value)}
            disabled={submitting}
            type="url"
            placeholder="https://…"
          />
        </label>
        <button type="submit" className={`btn ${styles.submitBtn}`} disabled={submitting}>
          {submitting ? status || "Working…" : "Create campaign"}
        </button>
      </form>
      {error && <div className={styles.error}>{error}</div>}
      {result && (
        <div className={styles.success}>
          Campaign #{result.campaignId} created —{" "}
          <a
            href={`https://testnet.arcscan.app/tx/${result.txHash}`}
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
