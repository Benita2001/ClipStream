import Database from "better-sqlite3";
import * as path from "path";

const DEFAULT_DB_PATH = process.env.CLIPSTREAM_DB_PATH || path.join(__dirname, "..", "clipstream.db");

let db: Database.Database | null = null;

/// Opens (or returns the already-open) singleton connection, with WAL mode
/// and foreign keys enabled. Call once per process; every function below
/// reuses this connection.
export function getDb(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  if (!db) {
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  }
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

// ---------------------------------------------------------------------------
// campaigns
// ---------------------------------------------------------------------------

export type CampaignStatus = "active" | "closed";

export interface Campaign {
  id: number;
  organizer_wallet: string;
  contract_campaign_id: string; // uint256 as string — see storage convention note in schema.sql
  base_rate: number;
  cpm_rate: string; // USDC base units per 1,000 views — see storage convention note in schema.sql
  max_cpm: string; // hard ceiling on cpm_rate, enforced here at creation time
  max_duration: number;
  status: CampaignStatus;
  description: string | null; // off-chain-only, organizer-supplied at creation — the contract has no concept of this
  source_link: string | null; // off-chain-only, organizer-supplied at creation — same category as description
  created_at: string;
}

export class CpmRateExceedsMaxError extends Error {
  constructor(cpmRate: string, maxCpm: string) {
    super(`cpm_rate (${cpmRate}) exceeds max_cpm (${maxCpm}) — reduce cpm_rate or raise max_cpm`);
    this.name = "CpmRateExceedsMaxError";
  }
}

/// Rejects creation if cpm_rate > max_cpm. This is the only enforcement point
/// for the ceiling right now, since nothing dynamically adjusts the rate yet —
/// the Settlement Worker adds a second, defensive check for once the Pacing
/// Agent starts adjusting rates later.
export function insertCampaign(input: {
  organizer_wallet: string;
  contract_campaign_id: string;
  base_rate: number;
  cpm_rate: string;
  max_cpm: string;
  max_duration: number;
  status?: CampaignStatus;
  description?: string | null;
  source_link?: string | null;
}): Campaign {
  if (BigInt(input.cpm_rate) > BigInt(input.max_cpm)) {
    throw new CpmRateExceedsMaxError(input.cpm_rate, input.max_cpm);
  }

  const stmt = getDb().prepare(`
    INSERT INTO campaigns (organizer_wallet, contract_campaign_id, base_rate, cpm_rate, max_cpm, max_duration, status, description, source_link)
    VALUES (@organizer_wallet, @contract_campaign_id, @base_rate, @cpm_rate, @max_cpm, @max_duration, @status, @description, @source_link)
  `);
  const info = stmt.run({ status: "active", description: null, source_link: null, ...input });
  return getCampaignById(Number(info.lastInsertRowid))!;
}

export function getCampaignById(id: number): Campaign | undefined {
  return getDb().prepare(`SELECT * FROM campaigns WHERE id = ?`).get(id) as Campaign | undefined;
}

export function getCampaignByContractId(contractCampaignId: string): Campaign | undefined {
  return getDb()
    .prepare(`SELECT * FROM campaigns WHERE contract_campaign_id = ?`)
    .get(contractCampaignId) as Campaign | undefined;
}

export function listCampaignsByOrganizer(organizerWallet: string): Campaign[] {
  return getDb()
    .prepare(`SELECT * FROM campaigns WHERE organizer_wallet = ? ORDER BY created_at DESC`)
    .all(organizerWallet) as Campaign[];
}

/// What the Pacing Agent iterates over each cycle.
export function listActiveCampaigns(): Campaign[] {
  return getDb().prepare(`SELECT * FROM campaigns WHERE status = 'active' ORDER BY id ASC`).all() as Campaign[];
}

/// Every campaign regardless of status — the Clipper browse view (GET
/// /campaigns). Deliberately not filtered to 'active' like
/// listActiveCampaigns(): a closed campaign should stay visible with a
/// "Closed" badge on the frontend, not disappear as if it never existed.
export function listAllCampaigns(): Campaign[] {
  return getDb().prepare(`SELECT * FROM campaigns ORDER BY id ASC`).all() as Campaign[];
}

export function updateCampaignStatus(id: number, status: CampaignStatus): void {
  getDb().prepare(`UPDATE campaigns SET status = ? WHERE id = ?`).run(status, id);
}

// ---------------------------------------------------------------------------
// clips
// ---------------------------------------------------------------------------

export interface Clip {
  id: number;
  campaign_id: number;
  clipper_wallet: string;
  url: string;
  tweet_id: string;
  per_clip_cap: string | null; // USDC base units, null = uncapped — see storage convention note in schema.sql
  is_capped: boolean; // performance hint for the View Poller; Settlement Worker always recomputes the real total
  effective_cpm_rate: string | null; // null = use campaign.cpm_rate; set by the Pacing Agent, pre-clamped to max_cpm
  submitted_at: string;
}

/// SQLite has no native boolean — is_capped is stored as 0/1. This is the one
/// place that mapping happens, so every function returning a Clip goes through it.
function mapClipRow(row: any): Clip {
  return { ...row, is_capped: Boolean(row.is_capped) };
}

export function insertClip(input: {
  campaign_id: number;
  clipper_wallet: string;
  url: string;
  tweet_id: string;
  per_clip_cap?: string | null;
}): Clip {
  const stmt = getDb().prepare(`
    INSERT INTO clips (campaign_id, clipper_wallet, url, tweet_id, per_clip_cap)
    VALUES (@campaign_id, @clipper_wallet, @url, @tweet_id, @per_clip_cap)
  `);
  const info = stmt.run({ per_clip_cap: null, ...input });
  return getClipById(Number(info.lastInsertRowid))!;
}

export function getClipById(id: number): Clip | undefined {
  const row = getDb().prepare(`SELECT * FROM clips WHERE id = ?`).get(id);
  return row ? mapClipRow(row) : undefined;
}

export function getClipByTweetId(tweetId: string): Clip | undefined {
  const row = getDb().prepare(`SELECT * FROM clips WHERE tweet_id = ?`).get(tweetId);
  return row ? mapClipRow(row) : undefined;
}

export function listClipsByCampaign(campaignId: number): Clip[] {
  const rows = getDb()
    .prepare(`SELECT * FROM clips WHERE campaign_id = ? ORDER BY submitted_at DESC`)
    .all(campaignId);
  return rows.map(mapClipRow);
}

export function listClipsByClipper(clipperWallet: string): Clip[] {
  const rows = getDb()
    .prepare(`SELECT * FROM clips WHERE clipper_wallet = ? ORDER BY submitted_at DESC`)
    .all(clipperWallet);
  return rows.map(mapClipRow);
}

/// Clips belonging to a campaign whose status is still 'active' — what the
/// View Poller iterates over each cycle. There is no separate per-clip status
/// column; "active" is entirely a function of the parent campaign's status.
export function listActiveClipsForPolling(): Clip[] {
  const rows = getDb()
    .prepare(
      `SELECT clips.* FROM clips
       JOIN campaigns ON campaigns.id = clips.campaign_id
       WHERE campaigns.status = 'active'
       ORDER BY clips.id ASC`
    )
    .all();
  return rows.map(mapClipRow);
}

/// Clip count for a campaign — used by the GET /campaigns and
/// GET /campaigns/:id read endpoints. A dedicated COUNT query rather than
/// listClipsByCampaign(...).length so the frontend list endpoint doesn't pull
/// every clip row (url, tweet_id, etc.) just to report a number.
export function countClipsByCampaign(campaignId: number): number {
  const row = getDb().prepare(`SELECT COUNT(*) as count FROM clips WHERE campaign_id = ?`).get(campaignId) as {
    count: number;
  };
  return row.count;
}

/// Marks a clip's per-clip cap as reached. See the is_capped column comment
/// in schema.sql — this is a performance hint for the View Poller only.
export function setClipCapped(clipId: number, isCapped: boolean = true): void {
  getDb()
    .prepare(`UPDATE clips SET is_capped = ? WHERE id = ?`)
    .run(isCapped ? 1 : 0, clipId);
}

/// Written by the Pacing Agent. `rate: null` reverts the clip to the
/// campaign's base cpm_rate (see effective_cpm_rate's column comment in schema.sql).
export function setClipEffectiveCpmRate(clipId: number, rate: string | null): void {
  getDb().prepare(`UPDATE clips SET effective_cpm_rate = ? WHERE id = ?`).run(rate, clipId);
}

/// Most recent `limit` snapshots for a clip, ascending by polled_at — what
/// the Pacing Agent diffs (latest - earliest) to get recent view velocity.
export function getRecentViewSnapshotsForClip(clipId: number, limit: number): ViewSnapshot[] {
  const rows = getDb()
    .prepare(`SELECT * FROM view_snapshots WHERE clip_id = ? ORDER BY polled_at DESC LIMIT ?`)
    .all(clipId, limit) as ViewSnapshot[];
  return rows.reverse();
}

// ---------------------------------------------------------------------------
// wallets
// ---------------------------------------------------------------------------

export type WalletOwnerType = "clipper" | "organizer";
export type WalletKind = "user_controlled" | "developer_controlled" | "external";

export interface Wallet {
  address: string;
  owner_type: WalletOwnerType;
  wallet_type: WalletKind;
  created_at: string;
}

/// Wallets are keyed by address; re-registering the same address is a no-op
/// rather than an error, since ingestion can see the same wallet repeatedly.
export function upsertWallet(input: { address: string; owner_type: WalletOwnerType; wallet_type: WalletKind }): Wallet {
  getDb()
    .prepare(
      `INSERT INTO wallets (address, owner_type, wallet_type)
       VALUES (@address, @owner_type, @wallet_type)
       ON CONFLICT(address) DO NOTHING`
    )
    .run(input);
  return getWalletByAddress(input.address)!;
}

export function getWalletByAddress(address: string): Wallet | undefined {
  return getDb().prepare(`SELECT * FROM wallets WHERE address = ?`).get(address) as Wallet | undefined;
}

// ---------------------------------------------------------------------------
// x_accounts — one-time "Sign in with X" link, used only for ownership
// verification on clip submission. Reading public view counts needs none of this.
// ---------------------------------------------------------------------------

export interface XAccount {
  wallet_address: string;
  x_user_id: string;
  x_handle: string;
  linked_at: string;
}

/**
 * x_accounts has two independent uniqueness constraints (wallet_address as
 * PK, x_user_id UNIQUE) — a plain ON CONFLICT(wallet_address) upsert only
 * handles one direction (same wallet re-linking to a new X account) and
 * throws on the other (same X account re-linking to a new wallet), which is
 * a real flow: a clipper authenticates with the same X account again after
 * switching wallets (e.g. moving from a placeholder/dev wallet to a real
 * Circle wallet). Since re-linking always requires a fresh X OAuth consent
 * screen, moving the binding is safe — it can't be done without proving
 * ownership of the X account each time. So: clear out any existing row for
 * this x_user_id under a different wallet first, then upsert as normal.
 */
export function upsertXAccount(input: { wallet_address: string; x_user_id: string; x_handle: string }): XAccount {
  const db = getDb();
  const run = db.transaction((row: typeof input) => {
    db.prepare(`DELETE FROM x_accounts WHERE x_user_id = ? AND wallet_address != ?`).run(row.x_user_id, row.wallet_address);
    db.prepare(
      `INSERT INTO x_accounts (wallet_address, x_user_id, x_handle)
       VALUES (@wallet_address, @x_user_id, @x_handle)
       ON CONFLICT(wallet_address) DO UPDATE SET x_user_id = excluded.x_user_id, x_handle = excluded.x_handle`
    ).run(row);
  });
  run(input);
  return getXAccountByWallet(input.wallet_address)!;
}

export function getXAccountByWallet(walletAddress: string): XAccount | undefined {
  return getDb()
    .prepare(`SELECT * FROM x_accounts WHERE wallet_address = ?`)
    .get(walletAddress) as XAccount | undefined;
}

export function getXAccountByXUserId(xUserId: string): XAccount | undefined {
  return getDb().prepare(`SELECT * FROM x_accounts WHERE x_user_id = ?`).get(xUserId) as XAccount | undefined;
}

// ---------------------------------------------------------------------------
// circle_users — maps our wallets.address to a Circle User-Controlled
// Wallet's userId, so a returning clipper can resume their existing Circle
// user instead of a new one being created every visit. See schema.sql's
// comment for why this is a separate table from `wallets` (Circle's
// createUser happens before any address exists).
// ---------------------------------------------------------------------------

export interface CircleUser {
  wallet_address: string;
  circle_user_id: string;
  created_at: string;
}

export function insertCircleUser(input: { wallet_address: string; circle_user_id: string }): CircleUser {
  getDb()
    .prepare(
      `INSERT INTO circle_users (wallet_address, circle_user_id)
       VALUES (@wallet_address, @circle_user_id)`
    )
    .run(input);
  return getCircleUserByWallet(input.wallet_address)!;
}

export function getCircleUserByWallet(walletAddress: string): CircleUser | undefined {
  return getDb()
    .prepare(`SELECT * FROM circle_users WHERE wallet_address = ?`)
    .get(walletAddress) as CircleUser | undefined;
}

// ---------------------------------------------------------------------------
// view_snapshots (append-only)
// ---------------------------------------------------------------------------

export interface ViewSnapshot {
  id: number;
  clip_id: number;
  tweet_id: string;
  impression_count: number;
  polled_at: string;
}

export function insertViewSnapshot(input: { clip_id: number; tweet_id: string; impression_count: number }): ViewSnapshot {
  const stmt = getDb().prepare(`
    INSERT INTO view_snapshots (clip_id, tweet_id, impression_count)
    VALUES (@clip_id, @tweet_id, @impression_count)
  `);
  const info = stmt.run(input);
  return getDb()
    .prepare(`SELECT * FROM view_snapshots WHERE id = ?`)
    .get(Number(info.lastInsertRowid)) as ViewSnapshot;
}

/// Ordered by polled_at — this is the shape the settlement worker diffs
/// consecutive pairs of, backed by idx_view_snapshots_clip_polled.
export function listViewSnapshotsForClip(clipId: number, sinceIso?: string): ViewSnapshot[] {
  if (sinceIso) {
    return getDb()
      .prepare(`SELECT * FROM view_snapshots WHERE clip_id = ? AND polled_at > ? ORDER BY polled_at ASC`)
      .all(clipId, sinceIso) as ViewSnapshot[];
  }
  return getDb()
    .prepare(`SELECT * FROM view_snapshots WHERE clip_id = ? ORDER BY polled_at ASC`)
    .all(clipId) as ViewSnapshot[];
}

/// Most recent snapshot for a clip — the Settlement Worker diffs this against
/// the newly-polled reading to get the delta to validate and pay out.
export function getLatestViewSnapshotForClip(clipId: number): ViewSnapshot | undefined {
  return getDb()
    .prepare(`SELECT * FROM view_snapshots WHERE clip_id = ? ORDER BY polled_at DESC LIMIT 1`)
    .get(clipId) as ViewSnapshot | undefined;
}

// ---------------------------------------------------------------------------
// pending_settlements — queue between the View Poller and Settlement Worker
// ---------------------------------------------------------------------------

export type PendingSettlementStatus = "pending" | "settled" | "failed";

export interface PendingSettlement {
  id: number;
  clip_id: number;
  campaign_id: number;
  clipper_wallet: string;
  view_delta: string; // USDC-base-unit-scale TEXT convention, see schema.sql
  computed_amount: string;
  settlement_id: string;
  validation_reason: string | null;
  status: PendingSettlementStatus;
  tx_hash: string | null;
  failure_reason: string | null;
  created_at: string;
  settled_at: string | null;
}

export function insertPendingSettlement(input: {
  clip_id: number;
  campaign_id: number;
  clipper_wallet: string;
  view_delta: string;
  computed_amount: string;
  settlement_id: string;
  validation_reason?: string | null;
}): PendingSettlement {
  const stmt = getDb().prepare(`
    INSERT INTO pending_settlements
      (clip_id, campaign_id, clipper_wallet, view_delta, computed_amount, settlement_id, validation_reason)
    VALUES
      (@clip_id, @campaign_id, @clipper_wallet, @view_delta, @computed_amount, @settlement_id, @validation_reason)
  `);
  const info = stmt.run({ validation_reason: null, ...input });
  return getPendingSettlementById(Number(info.lastInsertRowid))!;
}

export function getPendingSettlementById(id: number): PendingSettlement | undefined {
  return getDb().prepare(`SELECT * FROM pending_settlements WHERE id = ?`).get(id) as
    | PendingSettlement
    | undefined;
}

export function getPendingSettlementBySettlementId(settlementId: string): PendingSettlement | undefined {
  return getDb()
    .prepare(`SELECT * FROM pending_settlements WHERE settlement_id = ?`)
    .get(settlementId) as PendingSettlement | undefined;
}

/// What the Settlement Worker polls — rows still awaiting an on-chain attempt.
export function listPendingSettlementsByStatus(status: PendingSettlementStatus): PendingSettlement[] {
  return getDb()
    .prepare(`SELECT * FROM pending_settlements WHERE status = ? ORDER BY created_at ASC`)
    .all(status) as PendingSettlement[];
}

export function markPendingSettlementSettled(id: number, txHash: string): void {
  getDb()
    .prepare(
      `UPDATE pending_settlements
       SET status = 'settled', tx_hash = @tx_hash, failure_reason = NULL,
           settled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = @id`
    )
    .run({ id, tx_hash: txHash });
}

/// Marks a row failed with the real revert/error reason. No automatic retry —
/// a failed settlement waits for a human or an explicit future retry path.
export function markPendingSettlementFailed(id: number, failureReason: string): void {
  getDb()
    .prepare(`UPDATE pending_settlements SET status = 'failed', failure_reason = @failure_reason WHERE id = @id`)
    .run({ id, failure_reason: failureReason });
}

/// The Validation Engine's own rejections (validateViewDelta returning
/// non-APPROVED) are never persisted anywhere — the View Poller only logs
/// them to the console and returns without writing a row (see
/// poller/viewPoller.ts). So "recent anomaly flags" has no real backing data
/// at that layer. The closest real, queryable anomaly signal is a
/// pending_settlements row that *did* get created (validation approved it)
/// but then failed downstream — a rate-ceiling defense reject, a cap
/// exhaustion, or an on-chain revert, recorded in failure_reason by
/// markPendingSettlementFailed. Used by pacing/llmAdvisor.ts to give Claude
/// real context instead of inventing a "Validation Engine flags" field that
/// doesn't exist.
export function getRecentFailedSettlementReasonsForClip(clipId: number, limit: number): string[] {
  const rows = getDb()
    .prepare(
      `SELECT failure_reason FROM pending_settlements
       WHERE clip_id = ? AND status = 'failed' AND failure_reason IS NOT NULL
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(clipId, limit) as { failure_reason: string }[];
  return rows.map((r) => r.failure_reason);
}

// ---------------------------------------------------------------------------
// settlements (append-only)
// ---------------------------------------------------------------------------

export interface Settlement {
  id: number;
  campaign_id: number;
  clip_id: number;
  clipper_wallet: string;
  view_delta: number;
  amount: string; // USDC base units as string — see storage convention note in schema.sql
  settlement_id: string; // matches CampaignEscrow.usedSettlementIds key on-chain
  tx_hash: string | null;
  created_at: string;
}

export function insertSettlement(input: {
  campaign_id: number;
  clip_id: number;
  clipper_wallet: string;
  view_delta: number;
  amount: string;
  settlement_id: string;
  tx_hash?: string | null;
}): Settlement {
  const stmt = getDb().prepare(`
    INSERT INTO settlements (campaign_id, clip_id, clipper_wallet, view_delta, amount, settlement_id, tx_hash)
    VALUES (@campaign_id, @clip_id, @clipper_wallet, @view_delta, @amount, @settlement_id, @tx_hash)
  `);
  const info = stmt.run({ tx_hash: null, ...input });
  return getDb()
    .prepare(`SELECT * FROM settlements WHERE id = ?`)
    .get(Number(info.lastInsertRowid)) as Settlement;
}

export function getSettlementBySettlementId(settlementId: string): Settlement | undefined {
  return getDb()
    .prepare(`SELECT * FROM settlements WHERE settlement_id = ?`)
    .get(settlementId) as Settlement | undefined;
}

export function listSettlementsByCampaign(campaignId: number): Settlement[] {
  return getDb()
    .prepare(`SELECT * FROM settlements WHERE campaign_id = ? ORDER BY created_at DESC`)
    .all(campaignId) as Settlement[];
}

export function listSettlementsByClipper(clipperWallet: string): Settlement[] {
  return getDb()
    .prepare(`SELECT * FROM settlements WHERE clipper_wallet = ? ORDER BY created_at DESC`)
    .all(clipperWallet) as Settlement[];
}

/// Settlement history for a single clip — the GET /clips/:id/earnings live
/// ticker's "recent settlement history." listSettlementsByCampaign and
/// listSettlementsByClipper already existed at the campaign/clipper grain;
/// this is the missing clip grain.
export function listSettlementsByClip(clipId: number): Settlement[] {
  return getDb()
    .prepare(`SELECT * FROM settlements WHERE clip_id = ? ORDER BY created_at DESC`)
    .all(clipId) as Settlement[];
}

/// Total already paid out for a clip, for per-clip-cap enforcement. Deliberately
/// not SQL SUM(amount) — amount is stored as TEXT precisely because it can
/// exceed Number.MAX_SAFE_INTEGER, and SQLite's SUM() coerces TEXT operands
/// through floating point, which would silently reintroduce the precision loss
/// that TEXT storage exists to avoid. Summed as BigInt in JS instead —
/// correctness over performance, matching the scale this runs at.
export function getTotalSettledAmountForClip(clipId: number): bigint {
  const rows = getDb().prepare(`SELECT amount FROM settlements WHERE clip_id = ?`).all(clipId) as {
    amount: string;
  }[];
  return rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
}

/// Total ever released for a campaign. Used by the Pacing Agent to derive
/// totalBudget without a separate on-chain event query or a denormalized
/// running total: CampaignEscrow's balance only ever moves via deposits
/// (+) and release() (-), so for an still-open campaign,
/// totalBudget == remainingBalance (read on-chain) + totalReleased (this).
/// Same BigInt-in-JS approach as getTotalSettledAmountForClip, for the same
/// reason — not SQL SUM() over a TEXT column.
export function getTotalSettledAmountForCampaign(campaignId: number): bigint {
  const rows = getDb().prepare(`SELECT amount FROM settlements WHERE campaign_id = ?`).all(campaignId) as {
    amount: string;
  }[];
  return rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
}

/// Amount settled for a campaign since a given ISO timestamp — the Organizer
/// campaign page's "spend velocity" metric (e.g. spend in the last hour).
/// Same BigInt-in-JS approach as the other getTotalSettledAmountFor*
/// functions, for the same reason — not SQL SUM() over a TEXT column.
export function getSettledAmountSince(campaignId: number, sinceIso: string): bigint {
  const rows = getDb()
    .prepare(`SELECT amount FROM settlements WHERE campaign_id = ? AND created_at >= ?`)
    .all(campaignId, sinceIso) as { amount: string }[];
  return rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
}

/// Lifetime earnings across every campaign for one clipper — the GET
/// /clippers/:wallet/profile page's headline number. Same BigInt-in-JS
/// approach as the other getTotalSettledAmountFor* functions, for the same
/// reason — not SQL SUM() over a TEXT column.
export function getTotalSettledAmountForClipper(clipperWallet: string): bigint {
  const rows = getDb().prepare(`SELECT amount FROM settlements WHERE clipper_wallet = ?`).all(clipperWallet) as {
    amount: string;
  }[];
  return rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
}

// ---------------------------------------------------------------------------
// agent_decisions (append-only)
// ---------------------------------------------------------------------------

export interface AgentDecision {
  id: number;
  campaign_id: number;
  clip_id: number | null;
  decision_type: string;
  rationale: string | null;
  old_rate: number | null;
  new_rate: number | null;
  /// True when this decision's rationale came from the Claude-augmented
  /// pacing layer (pacing/llmAdvisor.ts); false when it's the deterministic
  /// pacingEngine's own templated rationale (either because the LLM step was
  /// never invoked for this decision_type, or it was invoked and fell back).
  llm_used: boolean;
  created_at: string;
}

/// SQLite has no native boolean — llm_used is stored as 0/1, same convention
/// as clips.is_capped (see mapClipRow above).
function mapAgentDecisionRow(row: any): AgentDecision {
  return { ...row, llm_used: Boolean(row.llm_used) };
}

export function insertAgentDecision(input: {
  campaign_id: number;
  clip_id?: number | null;
  decision_type: string;
  rationale?: string | null;
  old_rate?: number | null;
  new_rate?: number | null;
  llm_used?: boolean;
}): AgentDecision {
  const stmt = getDb().prepare(`
    INSERT INTO agent_decisions (campaign_id, clip_id, decision_type, rationale, old_rate, new_rate, llm_used)
    VALUES (@campaign_id, @clip_id, @decision_type, @rationale, @old_rate, @new_rate, @llm_used)
  `);
  const { llm_used, ...rest } = { clip_id: null, rationale: null, old_rate: null, new_rate: null, llm_used: false, ...input };
  const info = stmt.run({ ...rest, llm_used: llm_used ? 1 : 0 });
  return mapAgentDecisionRow(
    getDb().prepare(`SELECT * FROM agent_decisions WHERE id = ?`).get(Number(info.lastInsertRowid))
  );
}

/// Powers the organizer's live decision feed — newest first.
export function listAgentDecisionsByCampaign(campaignId: number): AgentDecision[] {
  const rows = getDb()
    .prepare(`SELECT * FROM agent_decisions WHERE campaign_id = ? ORDER BY created_at DESC`)
    .all(campaignId) as any[];
  return rows.map(mapAgentDecisionRow);
}
