-- ClipStream core schema. All CREATE statements are idempotent (IF NOT EXISTS)
-- so this file can be re-run safely against an existing database.
--
-- Storage convention: contract_campaign_id, settlement_id, and amount are TEXT
-- (also pending_settlements.view_delta and .computed_amount, and
-- campaigns.cpm_rate/.max_cpm and clips.per_clip_cap, ahead of their eventual
-- on-chain uint256 use in release()/recordPayout()). They hold Solidity
-- uint256/bytes32 values (or raw USDC base-unit integers) that can exceed
-- JS's Number.MAX_SAFE_INTEGER. Never store or compare them as INTEGER; only
-- convert to display decimals in the frontend layer. Note settlements.view_delta
-- is the one exception, kept INTEGER from an earlier pass — real per-poll
-- deltas are small enough for this to be safe in practice, but it's an
-- inconsistency worth knowing about.

-- cpm_rate/max_cpm are organizer-set: cpm_rate is USDC base units per 1,000
-- views, max_cpm is a hard ceiling on it enforced at creation time (see
-- db.ts's insertCampaign). base_rate is kept as-is (still mirrors the value
-- passed to CampaignEscrow's on-chain constructor) but is no longer what the
-- per-view payout is derived from — that's now cpm_rate / 1000, computed in
-- the View Poller.
CREATE TABLE IF NOT EXISTS campaigns (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  organizer_wallet      TEXT NOT NULL,
  contract_campaign_id  TEXT NOT NULL UNIQUE,
  base_rate             INTEGER NOT NULL,
  cpm_rate              TEXT NOT NULL,
  max_cpm               TEXT NOT NULL,
  max_duration          INTEGER NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'closed')),
  -- description/source_link are off-chain-only metadata, organizer-supplied
  -- at creation — the contract has no concept of either, same category as
  -- cpm_rate/max_cpm already being app-level-only pricing fields. Both
  -- nullable: neither existed before this campaign creation flow, and
  -- backfilling a value for already-indexed campaigns isn't possible.
  description           TEXT,
  source_link           TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- per_clip_cap is organizer-set (null = uncapped); is_capped is set once the
-- cap is reached so the View Poller can cheaply skip queueing further
-- settlements for this clip without recomputing the running total on every
-- poll. It is a performance hint only — the Settlement Worker always
-- recomputes the true remaining cap itself and is the actual source of truth.
CREATE TABLE IF NOT EXISTS clips (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id     INTEGER NOT NULL REFERENCES campaigns(id),
  clipper_wallet  TEXT NOT NULL,
  url             TEXT NOT NULL,
  tweet_id            TEXT NOT NULL,
  per_clip_cap        TEXT,
  is_capped           INTEGER NOT NULL DEFAULT 0,
  -- NULL means "use the campaign's base cpm_rate unchanged" — the default
  -- before the Pacing Agent has ever run for this clip. Once it runs, this
  -- holds a real value, pre-clamped to the campaign's max_cpm.
  effective_cpm_rate  TEXT,
  submitted_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_clips_campaign_id ON clips(campaign_id);
CREATE INDEX IF NOT EXISTS idx_clips_clipper_wallet ON clips(clipper_wallet);
CREATE INDEX IF NOT EXISTS idx_clips_tweet_id ON clips(tweet_id);

CREATE TABLE IF NOT EXISTS wallets (
  address       TEXT PRIMARY KEY,
  owner_type    TEXT NOT NULL
                  CHECK (owner_type IN ('clipper', 'organizer')),
  wallet_type   TEXT NOT NULL
                  CHECK (wallet_type IN ('user_controlled', 'developer_controlled', 'external')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One-time "Sign in with X" OAuth 2.0 link (users.read, tweet.read scopes only),
-- made once at clipper Profile setup. Used solely to verify clip ownership on
-- submission (tweet author must match the linked x_user_id) — reading public
-- view counts needs no user auth at all and does not touch this table.
CREATE TABLE IF NOT EXISTS x_accounts (
  wallet_address  TEXT NOT NULL REFERENCES wallets(address),
  x_user_id       TEXT NOT NULL UNIQUE,
  x_handle        TEXT NOT NULL,
  linked_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (wallet_address)
);

-- Maps our own wallets.address to Circle's userId for a Circle
-- User-Controlled Wallet. Circle's createUser({userId}) happens before any
-- wallet address exists (the address is only produced once the PIN+wallet
-- creation challenge completes) — this table exists so a returning clipper
-- can resume their existing Circle user (re-issue a session token, re-list
-- their wallet) instead of a new Circle user getting created every visit.
-- Mirrors x_accounts's shape/pattern deliberately.
CREATE TABLE IF NOT EXISTS circle_users (
  wallet_address  TEXT NOT NULL REFERENCES wallets(address),
  circle_user_id  TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (wallet_address)
);

-- Append-only: one row per View Poller read of a clip's tweet. Never UPDATE or
-- DELETE rows here; the settlement worker diffs consecutive snapshots per clip
-- to compute the impression_count delta that gets validated and paid out.
CREATE TABLE IF NOT EXISTS view_snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  clip_id           INTEGER NOT NULL REFERENCES clips(id),
  tweet_id          TEXT NOT NULL,
  impression_count  INTEGER NOT NULL,
  polled_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_view_snapshots_clip_polled
  ON view_snapshots(clip_id, polled_at);

-- Queue between the View Poller and the Settlement Worker. The poller inserts
-- a 'pending' row whenever validateViewDelta APPROVES a delta; the worker
-- claims 'pending' rows, calls the on-chain contracts, and moves each row to
-- 'settled' or 'failed'. settlement_id is deterministic (derived from
-- clip_id + polled_at) and UNIQUE so re-running a poll cycle can't produce
-- two different ids for the same event, and mirrors the same value used as
-- the bytes32 idempotency key in CampaignEscrow.usedSettlementIds on-chain.
--
-- validation_reason is not part of the original column list this table was
-- specced with, but the Settlement Worker needs the Validation Engine's
-- reason text to compute agentRationaleHash (keccak256 of the reason) for
-- PayoutRegistry.recordPayout — added so that requirement is actually
-- satisfiable rather than silently unimplementable.
CREATE TABLE IF NOT EXISTS pending_settlements (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  clip_id            INTEGER NOT NULL REFERENCES clips(id),
  campaign_id        INTEGER NOT NULL REFERENCES campaigns(id),
  clipper_wallet     TEXT NOT NULL,
  view_delta         TEXT NOT NULL,
  computed_amount    TEXT NOT NULL,
  settlement_id      TEXT NOT NULL UNIQUE,
  validation_reason  TEXT,
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'settled', 'failed')),
  tx_hash            TEXT,
  failure_reason     TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  settled_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_settlements_status ON pending_settlements(status);
CREATE INDEX IF NOT EXISTS idx_pending_settlements_campaign_id ON pending_settlements(campaign_id);

-- Append-only: one row per released nanopayment. settlement_id mirrors the
-- bytes32 tracked in CampaignEscrow.usedSettlementIds on-chain.
CREATE TABLE IF NOT EXISTS settlements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id     INTEGER NOT NULL REFERENCES campaigns(id),
  clip_id         INTEGER NOT NULL REFERENCES clips(id),
  clipper_wallet  TEXT NOT NULL,
  view_delta      INTEGER NOT NULL,
  amount          TEXT NOT NULL,
  settlement_id   TEXT NOT NULL UNIQUE,
  tx_hash         TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_settlements_campaign_id ON settlements(campaign_id);
CREATE INDEX IF NOT EXISTS idx_settlements_clipper_wallet ON settlements(clipper_wallet);

-- Append-only: every rate/pacing decision the Settlement/Pacing Agent makes,
-- campaign-wide or scoped to one clip. Powers the organizer's live decision feed.
-- llm_used: whether this decision's rationale came from the Claude-augmented
-- pacing layer (pacing/llmAdvisor.ts) or the deterministic pacingEngine
-- template alone. The LLM never has final say over the rate itself (see
-- llmAdvisor.ts's top-of-file comment) — this column only records which
-- rationale text is being shown, for transparency in the organizer's feed.
CREATE TABLE IF NOT EXISTS agent_decisions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id    INTEGER NOT NULL REFERENCES campaigns(id),
  clip_id        INTEGER REFERENCES clips(id),
  decision_type  TEXT NOT NULL,
  rationale      TEXT,
  old_rate       INTEGER,
  new_rate       INTEGER,
  llm_used       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_decisions_campaign_id ON agent_decisions(campaign_id);
