# ClipStream Frontend Data Contract

This is the reference for anyone building frontend against ClipStream's backend. It covers two things: the raw SQLite tables the backend reads/writes (Part 1), and the REST endpoints actually available to a frontend today (Part 2). Column names, types, and examples are pulled directly from `db/schema.sql` and real seeded/live data — not reconstructed from memory.

## The one rule that matters most

**Several fields are TEXT columns holding integers too large for a JS `number`.** SQLite has no native bignum type; ClipStream stores anything that is (or could become) a Solidity `uint256` — or any USDC base-unit amount that could exceed `Number.MAX_SAFE_INTEGER` (2^53 - 1) — as `TEXT`, and the backend always does arithmetic on these as `BigInt` in JS, never as `Number`, and never via SQL `SUM()` (which coerces `TEXT` through floating point).

**If your frontend code ever does `Number(someBigintField) + Number(otherBigintField)` and then does math (not just display) with the result, you are reintroducing precision loss the backend went out of its way to avoid.** Use `BigInt(field)` for arithmetic, or a decimal library if you need fractional display math. It is fine to `Number()` these fields for direct, unmodified display (e.g. showing "9020" in a UI), just never for further computation.

Every table section below explicitly lists which fields this applies to.

---

## Part 1: Tables

### `campaigns`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | ClipStream's own row id — **not** the on-chain campaign id, see `contract_campaign_id` |
| `name` | TEXT | Organizer-supplied, **required** (`POST /campaigns` rejects a missing/empty value), off-chain-only — the primary headline everywhere a campaign is shown in the frontend (with `#id` as a small secondary label). Rows indexed before this column existed were backfilled to `"Untitled Campaign"` via the `ADD COLUMN ... DEFAULT` migration, not left blank. |
| `organizer_wallet` | TEXT | organizer's wallet address |
| `contract_campaign_id` | TEXT, UNIQUE | **bigint-as-text.** The on-chain `CampaignEscrow` campaign id (a `uint256`). Currently small integers-as-strings like `"0"`, but must never be parsed as `Number` and used in further math — pass it straight through to any contract read. |
| `base_rate` | INTEGER | Mirrors the value passed to the on-chain constructor at creation. **Not** what payouts are derived from — kept for historical/on-chain-parity reasons only. Ignore this for any rate display; use `cpm_rate`. |
| `cpm_rate` | TEXT | **bigint-as-text.** USDC base units per 1,000 views, organizer-set. |
| `max_cpm` | TEXT | **bigint-as-text.** Hard ceiling on `cpm_rate`, enforced at campaign creation (`cpm_rate` can never exceed this). |
| `max_duration` | INTEGER | seconds; campaign duration before `withdrawRemaining` becomes callable on-chain |
| `status` | TEXT | `'active'` \| `'closed'`. Not just a static label — the Settlement Worker (`settlement/worker.ts`) flips this to `'closed'` for real, right after a `release()` call, the moment a live on-chain read of that campaign's remaining balance comes back `0`. Nothing else in this codebase ever sets it to `'closed'`. |
| `description` | TEXT, **nullable** | Off-chain-only, organizer-supplied at creation (`POST /campaigns`). The contract has no concept of this — same category as `cpm_rate`/`max_cpm` being app-level-only. `null` if the organizer left it blank. |
| `source_link` | TEXT, **nullable** | Off-chain-only, organizer-supplied at creation. A URL the frontend renders as a real clickable link (opens in a new tab) — not validated server-side beyond "is it a string," so treat it as untrusted user input on render (e.g. don't blindly `dangerouslySetInnerHTML` it). `null` if the organizer left it blank. |
| `created_at` | TEXT | ISO 8601 UTC |

**Nullability:** `description` and `source_link` are nullable (see above); every other column is `NOT NULL`.

**Real example row:**
```json
{
  "id": 1,
  "name": "Launch Trailer Clips",
  "organizer_wallet": "0x8a69D789Dc390779D0D0BffB69583F11CC3adc3E",
  "contract_campaign_id": "0",
  "base_rate": 100,
  "cpm_rate": "100000",
  "max_cpm": "200000",
  "max_duration": 2592000,
  "status": "closed",
  "description": "Clip our launch trailer. Must include #ClipStreamLaunch in the tweet reply. No reposts of other clippers work.",
  "source_link": "https://x.com/0x_beni_/status/1981573317736771643",
  "created_at": "2026-07-06T13:41:01.268Z"
}
```
(Real row, taken after this campaign's balance was genuinely brought to `0` by a real settlement — `status` and `description`/`source_link` shown together to make clear these are independent fields, not mutually exclusive.)

**Not stored anywhere in this table**: the campaign's on-chain remaining balance. That requires a live contract read (`CampaignEscrow.getCampaignBalance(contract_campaign_id)`) — this is why `GET /campaigns` and `GET /campaigns/:id` exist as computed endpoints rather than the frontend reading this table directly.

---

### `clips`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `campaign_id` | INTEGER FK | → `campaigns.id` |
| `clipper_wallet` | TEXT | |
| `url` | TEXT | the submitted tweet URL, as given |
| `tweet_id` | TEXT | extracted numeric tweet id (or a test-fixture string in seeded data — see example row 2 below) |
| `per_clip_cap` | TEXT, **nullable** | **bigint-as-text when present.** `null` = uncapped (no per-clip earnings limit). A non-null value is the max USDC base units this clip can ever earn in total. |
| `is_capped` | INTEGER (0/1) | boolean, `true` once `per_clip_cap` has been reached. **This is a performance hint only** — the Settlement Worker always recomputes the true remaining cap itself before paying out; don't treat this flag as the authoritative "can this clip still earn" answer for anything beyond UI display. |
| `effective_cpm_rate` | TEXT, **nullable** | **bigint-as-text when present.** `null` means **"use the campaign's `cpm_rate` unchanged"** — this is the default before the Pacing Agent has ever adjusted this clip's rate. A non-null value is the clip's own paced rate (already clamped to the campaign's `max_cpm`), set by `pacing/agent.ts`/`pacing/llmAdvisor.ts`. **When displaying "this clip's current rate," always fall back to the parent campaign's `cpm_rate` when this is `null` — never show "no rate" or 0.** |
| `submitted_at` | TEXT | ISO 8601 UTC |

**Real example rows** (both real, from the same seeded campaign — note the different `effective_cpm_rate` states):
```json
{
  "id": 1,
  "campaign_id": 1,
  "clipper_wallet": "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "url": "https://x.com/0x_beni_/status/1981573317736771643?s=20",
  "tweet_id": "1981573317736771643",
  "per_clip_cap": null,
  "is_capped": 0,
  "effective_cpm_rate": null,
  "submitted_at": "2026-07-06T14:00:03.372Z"
}
```
```json
{
  "id": 4,
  "campaign_id": 1,
  "clipper_wallet": "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "url": "https://x.com/0x_beni_/status/9999999999999999999",
  "tweet_id": "test-cap-tweet-native-1",
  "per_clip_cap": "150",
  "is_capped": 1,
  "effective_cpm_rate": "200000",
  "submitted_at": "2026-07-06T19:26:28.836Z"
}
```

**Not stored in this table**: current view count and total earnings. Those come from `view_snapshots`/`settlements` respectively — see `GET /campaigns/:id/clips` and `GET /clips/:id/earnings`, which join this in for you.

---

### `wallets`

| Column | Type | Notes |
|---|---|---|
| `address` | TEXT PK | |
| `owner_type` | TEXT | `'clipper'` \| `'organizer'` |
| `wallet_type` | TEXT | `'user_controlled'` \| `'developer_controlled'` \| `'external'` |
| `created_at` | TEXT | ISO 8601 UTC |

**Nullability:** none.

**Real example row:**
```json
{
  "address": "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "owner_type": "clipper",
  "wallet_type": "user_controlled",
  "created_at": "2026-07-06T13:36:41.625Z"
}
```

---

### `x_accounts`

One row per wallet that has completed the one-time "Sign in with X" link (used only for clip-ownership verification at submission — never for reading view counts, which needs no user auth at all).

| Column | Type | Notes |
|---|---|---|
| `wallet_address` | TEXT PK, FK | → `wallets.address` |
| `x_user_id` | TEXT, UNIQUE | X's numeric user id |
| `x_handle` | TEXT | X handle, without the `@` |
| `linked_at` | TEXT | ISO 8601 UTC |

**Nullability:** none. A wallet either has a row here (linked) or doesn't (unlinked) — there's no partial/null state.

**Real example row:**
```json
{
  "wallet_address": "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "x_user_id": "1641713767225384962",
  "x_handle": "0x_beni_",
  "linked_at": "2026-07-06T13:59:54.888Z"
}
```

---

### `view_snapshots`

Append-only. One row per View Poller read of a clip's tweet. Never updated or deleted — the current view count for a clip is just its most recent row (`ORDER BY polled_at DESC LIMIT 1`).

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `clip_id` | INTEGER FK | → `clips.id` |
| `tweet_id` | TEXT | denormalized copy of `clips.tweet_id` at poll time |
| `impression_count` | INTEGER | X's raw `public_metrics.impression_count` at poll time — safe as a JS number at any realistic view count |
| `polled_at` | TEXT | ISO 8601 UTC |

**Nullability:** none. **No bigint-as-text fields** — `impression_count` is a real view count, safely within `Number` range even for viral tweets.

**Real example row (genuinely live-polled X data):**
```json
{
  "id": 7,
  "clip_id": 1,
  "tweet_id": "1981573317736771643",
  "impression_count": 107745,
  "polled_at": "2026-07-06T19:23:16.718Z"
}
```

---

### `pending_settlements`

The queue between the View Poller and the Settlement Worker. One row per validated view-delta waiting to be (or having been) paid out on-chain.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `clip_id` | INTEGER FK | → `clips.id` |
| `campaign_id` | INTEGER FK | → `campaigns.id` |
| `clipper_wallet` | TEXT | |
| `view_delta` | TEXT | **bigint-as-text.** Views gained between the two polls this settlement is based on. |
| `computed_amount` | TEXT | **bigint-as-text.** USDC base units this settlement is worth, before any per-clip-cap clamp. |
| `settlement_id` | TEXT, UNIQUE | the `bytes32` idempotency key, shared with `CampaignEscrow.usedSettlementIds` on-chain and `settlements.settlement_id` |
| `validation_reason` | TEXT, **nullable** | the Validation Engine's plausibility-check reason text at the time this was queued (always populated for rows that made it into this table, since only `APPROVED` deltas get queued at all — see `poller/viewPoller.ts`) |
| `status` | TEXT | `'pending'` \| `'settled'` \| `'failed'` |
| `tx_hash` | TEXT, **nullable** | populated once `status = 'settled'`; `null` while pending or if it failed before a tx was sent |
| `failure_reason` | TEXT, **nullable** | populated only when `status = 'failed'` — the real on-chain revert reason, a rate-ceiling rejection, or cap exhaustion. `null` otherwise. |
| `created_at` | TEXT | ISO 8601 UTC |
| `settled_at` | TEXT, **nullable** | `null` until `status` moves to `'settled'` |

**This table is not currently exposed via any GET endpoint** — it's an internal queue between two backend jobs, not a frontend read surface. If a future page needs "in-flight, not-yet-paid views," that would be a new endpoint reading this table; flag it if you need it.

**Real example row:**
```json
{
  "id": 21,
  "clip_id": 5,
  "campaign_id": 1,
  "clipper_wallet": "0xc33558f7Ebcfd128AED6F7ACf3130a7B07B61C0D",
  "view_delta": "10",
  "computed_amount": "630",
  "settlement_id": "0x3fefa9478bf7a6e82c5936a8deae72bd45febc048e639d3b96f8d32c02847d4c",
  "validation_reason": "real test: proving a settlement uses the paced (throttled) effective_cpm_rate, not the flat base rate",
  "status": "settled",
  "tx_hash": "0x83789ac8af148fe973a2b846d0e0f2bd2d5734b416c61f5b6e62d9948226f5cd",
  "failure_reason": null,
  "created_at": "2026-07-06T21:49:01.197Z",
  "settled_at": "2026-07-06T21:49:21.783Z"
}
```

---

### `settlements`

Append-only. One row per **actually released** nanopayment (real `CampaignEscrow.release()` + `PayoutRegistry.recordPayout()` calls already confirmed on-chain). This is the source of truth for "what has this clip/clipper/campaign actually been paid."

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `campaign_id` | INTEGER FK | → `campaigns.id` |
| `clip_id` | INTEGER FK | → `clips.id` |
| `clipper_wallet` | TEXT | |
| `view_delta` | **INTEGER** | ⚠️ **the one deliberate inconsistency in this schema** — every other view-delta/amount-shaped field in this database is `TEXT`, but this one column was kept `INTEGER` from an earlier pass. It's safe as a JS number in practice (real per-poll deltas are small), but don't copy this column's type as a pattern for anything else. |
| `amount` | TEXT | **bigint-as-text.** The actual USDC base units paid, exactly matching the on-chain transfer. |
| `settlement_id` | TEXT, UNIQUE | matches `CampaignEscrow.usedSettlementIds` on-chain and the originating `pending_settlements.settlement_id` |
| `tx_hash` | TEXT, **nullable** | the real `release()` transaction hash. Only `null` if a row was somehow inserted without a confirmed tx, which shouldn't happen in the current worker flow — treat a `null` here as worth investigating, not a normal state. |
| `created_at` | TEXT | ISO 8601 UTC |

**Real example row** (a real Arc testnet settlement — `tx_hash` is a genuine on-chain transaction, viewable at `testnet.arcscan.app/tx/<hash>`):
```json
{
  "id": 14,
  "campaign_id": 1,
  "clip_id": 5,
  "clipper_wallet": "0xc33558f7Ebcfd128AED6F7ACf3130a7B07B61C0D",
  "view_delta": 10,
  "amount": "630",
  "settlement_id": "0x3fefa9478bf7a6e82c5936a8deae72bd45febc048e639d3b96f8d32c02847d4c",
  "tx_hash": "0x83789ac8af148fe973a2b846d0e0f2bd2d5734b416c61f5b6e62d9948226f5cd",
  "created_at": "2026-07-06T21:49:21.524Z"
}
```

---

### `agent_decisions`

Append-only. Every rate/pacing decision the Pacing Agent makes, campaign-wide or scoped to one clip. Powers the organizer's live decision feed.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `campaign_id` | INTEGER FK | → `campaigns.id` |
| `clip_id` | INTEGER FK, **nullable** | `null` for a campaign-wide decision (e.g. `decision_type = 'pacing_skipped'` when a whole campaign has no clips to allocate between); non-null for a per-clip rate update |
| `decision_type` | TEXT | e.g. `'pacing_rate_update'`, `'pacing_skipped'` — free-text, not an enum, new values may appear as the agent layer grows |
| `rationale` | TEXT, **nullable** | human-readable explanation, shown directly to the organizer. When `llm_used = true`, this is Claude's actual generated text; otherwise it's the deterministic engine's own templated string. `null` only for decision types that never populate it (currently none do in practice). |
| `old_rate` | INTEGER, **nullable** | ⚠️ stored as SQLite `INTEGER`, **not** `TEXT` like `cpm_rate`/`effective_cpm_rate` elsewhere — an inherited inconsistency (this table predates the bigint-as-text convention being applied everywhere). At current hackathon-scale rate values this fits safely in a JS `Number`, but if campaign rates ever grow large, this column would need the same TEXT treatment. Flag before assuming it's always safe. `null` when a decision type has no old rate to report (e.g. `pacing_skipped`). |
| `new_rate` | INTEGER, **nullable** | same caveat as `old_rate`. |
| `llm_used` | INTEGER (0/1) | boolean. `true` = this decision's `rationale` came from the Claude-augmented layer (`pacing/llmAdvisor.ts`); `false` = the deterministic `pacingEngine.ts` template. **The LLM never sets `new_rate` unilaterally either way** — it can only ever propose a bounded adjustment on top of the deterministic rate, which is always re-clamped to `max_cpm` regardless of what it suggested. This flag is about which rationale text is showing, not an indicator of "less trustworthy math." |
| `created_at` | TEXT | ISO 8601 UTC |

**Real example rows** (one deterministic-only, one LLM-augmented — the deterministic one is a live row queryable in the dev DB right now; the LLM one is real Claude output from the isolated live-test run documented in `CLAUDE.md`, run against a temporary DB that was cleaned up afterward, so it is **not** currently queryable — `id`/`created_at` below are illustrative placeholders, but `rationale`/`old_rate`/`new_rate`/`llm_used` are the actual real values Claude produced, copied verbatim from that test's console output):
```json
{
  "id": 10,
  "campaign_id": 1,
  "clip_id": 4,
  "decision_type": "pacing_rate_update",
  "rationale": "Clip 4: velocity share 100.0% vs even split 20.0% → 3.00x multiplier → rate 200000 (base 100000, HIT ceiling 200000, clamped from 299970 to 200000). Campaign runway at 90.2%, no throttle applied.",
  "old_rate": 199980,
  "new_rate": 200000,
  "llm_used": 0,
  "created_at": "2026-07-06T21:54:04.112Z"
}
```
```json
{
  "id": 1,
  "campaign_id": 1,
  "clip_id": 1,
  "decision_type": "pacing_rate_update",
  "rationale": "This clip has a recent rate-ceiling rejection where the computed amount of 180000 exceeded the campaign max_cpm cap. The deterministic rate of 140900 is already close to the 150000 ceiling, and the observed settlement failure suggests the effective payout is being pushed beyond the cap. A modest downward adjustment to ~119765 reduces the risk of further ceiling rejections while still rewarding this clip's strong view velocity.",
  "old_rate": 100000,
  "new_rate": 119765,
  "llm_used": 1,
  "created_at": "2026-07-06T22:03:00.000Z"
}
```

---

## Part 2: REST endpoints

All endpoints are mounted on the single Express app in `server/app.ts` (`scripts/run-server.ts`, default port 3000 via `PORT`). All responses are JSON. All bigint-as-text fields from Part 1 pass through as strings in these responses too — the same rule applies.

### `POST /wallets`
Registers a wallet — the prerequisite step behind the Clipper/Organizer Profile page's "wallet connection state" and X-account linking (`/auth/x/start` 400s if the wallet isn't registered yet). Idempotent — safe to call every time a wallet connects.
```
Request:  { "address": "0xTestFrontendWallet0001", "owner_type": "clipper", "wallet_type": "user_controlled" }
Response: { "wallet": { "address": "0xTestFrontendWallet0001", "owner_type": "clipper",
                         "wallet_type": "user_controlled", "created_at": "2026-07-07T00:55:50.131Z" } }
```
`owner_type` must be `"clipper"` or `"organizer"`; `wallet_type` must be `"user_controlled"`, `"developer_controlled"`, or `"external"` — 400 otherwise.

### `GET /auth/x/start?wallet_address=` and `GET /auth/x/callback`
Pre-existing (built in an earlier phase, not new here) — the Clipper Profile page's "link X account" action. `/auth/x/start` redirects to X's real consent screen; `/auth/x/callback` is X's redirect target and completes the link, after which `GET /clippers/:wallet/profile`'s `x_account` reflects it. The frontend only ever needs to link to `/auth/x/start?wallet_address=<address>` as a full-page navigation (not a fetch) — it's a redirect flow, not a JSON API call.

### `POST /clips`
Clipper campaign page's submit-a-clip flow. Built in an earlier phase, included here for completeness since it's the one write endpoint that page needs. Requires the clipper's wallet to already have a linked X account (`GET /clippers/:wallet/profile`'s `x_account.linked`) — the tweet's real author (an app-only X API read, no user auth) must match that linked account.
```
Request:  { "campaign_id": 1, "clipper_wallet": "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
            "url": "https://x.com/handle/status/1234567890" }
Response (201): { "clip": { "id": 8, "campaign_id": 1, ... }, "ownership": "tweet ...'s author matches linked account @handle" }
```
Real rejections: `400` no tweet id extractable from the URL; `404` campaign doesn't exist; `409` that tweet was already submitted as a clip; `403` the tweet's author doesn't match the submitting wallet's linked X account (includes both real author ids in the message, per the ownership-check design).

### `GET /campaigns`
Clipper browse view: **every** campaign regardless of `status`, each enriched with a live on-chain balance read. Deliberately not filtered to `status = 'active'` — an earlier version of this endpoint excluded depleted campaigns (`remaining_balance == 0`) entirely, which made a fully-funded, successfully-run campaign vanish the instant it ran out of budget rather than reading as "closed." Now a closed campaign stays in this list with `status: "closed"`; the frontend renders a muted "Closed" badge for it (still listed, still clickable through to its detail page) instead of removing it — see `app/clipper/campaigns/page.tsx`.
```json
{
  "campaigns": [
    {
      "id": 1,
      "name": "Launch Trailer Clips",
      "contract_campaign_id": "0",
      "organizer_wallet": "0x8a69D789Dc390779D0D0BffB69583F11CC3adc3E",
      "cpm_rate": "100000",
      "max_cpm": "200000",
      "max_duration": 2592000,
      "status": "closed",
      "description": null,
      "source_link": null,
      "created_at": "2026-07-06T13:41:01.268Z",
      "remaining_balance": "0",
      "total_settled": "10000",
      "total_budget": "10000",
      "runway_percent": 0,
      "clip_count": 6,
      "spend_velocity_last_hour": "0"
    }
  ]
}
```
`remaining_balance`, `total_settled`, `total_budget`, `spend_velocity_last_hour` are bigint-as-text. `runway_percent` is a pre-rounded display number (1 decimal) — safe to use directly, do not recompute it from the bigint fields on the frontend. `spend_velocity_last_hour` is the sum of `settlements.amount` for this campaign in the trailing 60 minutes (Organizer campaign page's spend-velocity metric) — `"0"` simply means nothing settled in the last hour, not an error. `description`/`source_link` are `null` unless the organizer supplied them at creation (see `POST /campaigns` below). `name` is never `null` — rows indexed before it existed were backfilled to `"Untitled Campaign"`.

### `GET /campaigns/:id`
Same shape as one entry above, wrapped as `{ "campaign": {...} }`. 404 with `{"error": "..."}` if the id doesn't exist. Not filtered by status either — this returns a closed campaign's true state just as readily as an active one's.

### `POST /campaigns`
Organizer campaign-creation flow. **The organizer's own wallet has already called `CampaignEscrow.createCampaign` on-chain directly** (client-side signing via Circle User-Controlled Wallets — this backend never holds organizer funds or signs on their behalf). This endpoint indexes the resulting on-chain campaign into SQLite and attaches the off-chain-only `name`/`cpm_rate`/`max_cpm`/`description`/`source_link` fields the contract itself has no concept of.
```
Request:  { "name": "Launch Trailer Clips", "contract_campaign_id": "1", "cpm_rate": "80000", "max_cpm": "150000",
            "description": "Clip our launch trailer...", "source_link": "https://x.com/..." }
Response: { "campaign": { "id": 3, "name": "Launch Trailer Clips", "contract_campaign_id": "1",
                          "organizer_wallet": "0x8a69D789Dc390779D0D0BffB69583F11CC3adc3E",
                          "cpm_rate": "80000", "max_cpm": "150000", "max_duration": 2592000,
                          "status": "active", "description": "Clip our launch trailer...",
                          "source_link": "https://x.com/...", "created_at": "2026-07-07T00:56:55.708Z",
                          "remaining_balance": "5000", "total_settled": "0", "total_budget": "5000",
                          "runway_percent": 100, "clip_count": 0, "spend_velocity_last_hour": "0" } }
```
`organizer_wallet`, `base_rate`, and `max_duration` are **not** taken from the request body — they're read from the chain itself (`CampaignEscrow.getCampaignDetails`), the actual source of truth, so a client can't misrepresent who the organizer is or what was actually deposited. `name`/`description`/`source_link` are the opposite case: purely off-chain metadata with no on-chain value to defend against, so they're accepted directly from the request body. Unlike `description`/`source_link` (both optional — omit, or pass `null`/a string), `name` is **required**: a missing or empty/whitespace-only value gets a `400`. Real rejection cases, all tested against genuine on-chain campaigns:
- `400` if `name` is missing, not a string, or empty/whitespace-only.
- `409` if `contract_campaign_id` is already indexed.
- `404` if no on-chain campaign with that id exists (surfaces the real Solidity revert reason, e.g. `"execution reverted: CampaignDoesNotExist()"`).
- `400` if `cpm_rate > max_cpm`.
- `400` if `description` or `source_link` is present but not a string.
- `400` if the on-chain campaign's `authorizedAgent` isn't ClipStream's own configured Settlement Agent address — such a campaign would exist on-chain but our worker could never call `release()` on it (`NotAuthorizedAgent`), silently never paying out; rejected at creation time instead of failing invisibly later.

### `GET /campaigns/:id/clips?clipper_wallet=`
Organizer view: every clip in a campaign, with current view count and total earnings joined in. The optional `?clipper_wallet=` filter turns this into the Clipper campaign page's "this clipper's clips in this campaign" live ticker — same rich per-clip shape, just scoped to one wallet.
```json
{
  "clips": [
    {
      "id": 5,
      "campaign_id": 1,
      "clipper_wallet": "0xc33558f7Ebcfd128AED6F7ACf3130a7B07B61C0D",
      "url": "https://x.com/0x_beni_/status/9999999999999999999",
      "tweet_id": "arc-testnet-real-test-1",
      "per_clip_cap": null,
      "is_capped": false,
      "effective_cpm_rate": "50020",
      "submitted_at": "2026-07-06T20:29:47.342Z",
      "current_view_count": 20050,
      "last_polled_at": "2026-07-06T21:36:37.544Z",
      "total_earnings": "830"
    }
  ]
}
```
`current_view_count`/`last_polled_at` are `null` if the clip has never been polled yet. `total_earnings` is bigint-as-text.

### `GET /campaigns/:id/agent-decisions?limit=50`
Organizer decision feed, most-recent-first (default limit 50, override with `?limit=`).
```json
{
  "agent_decisions": [
    {
      "id": 10, "campaign_id": 1, "clip_id": 4, "decision_type": "pacing_rate_update",
      "rationale": "...", "old_rate": 199980, "new_rate": 200000, "llm_used": false,
      "created_at": "2026-07-06T21:54:04.112Z"
    }
  ]
}
```

### `GET /clippers/:wallet/profile`
```json
{
  "wallet_address": "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "x_account": { "linked": true, "x_handle": "0x_beni_", "x_user_id": "1641713767225384962" },
  "lifetime_earnings": "100",
  "clips_submitted": 2,
  "campaigns": [
    { "campaign_id": 1, "contract_campaign_id": "0", "cpm_rate": "100000", "max_cpm": "200000",
      "status": "active", "clips_submitted": 2, "earnings_in_campaign": "100" }
  ]
}
```
An unlinked wallet gets `"x_account": { "linked": false }` (no `x_handle`/`x_user_id` keys at all — check `linked` first). `lifetime_earnings`/`earnings_in_campaign` are bigint-as-text.

### `GET /clippers/:wallet/settlements`
Full payout history for one clipper, most-recent-first, including a real, clickable tx explorer link.
```json
{
  "wallet_address": "0xc33558f7Ebcfd128AED6F7ACf3130a7B07B61C0D",
  "settlements": [
    { "id": 14, "campaign_id": 1, "clip_id": 5, "view_delta": 10, "amount": "630",
      "settlement_id": "0x3fefa9478bf7a6e82c5936a8deae72bd45febc048e639d3b96f8d32c02847d4c",
      "tx_hash": "0x83789ac8af148fe973a2b846d0e0f2bd2d5734b416c61f5b6e62d9948226f5cd",
      "tx_url": "https://testnet.arcscan.app/tx/0x83789ac8af148fe973a2b846d0e0f2bd2d5734b416c61f5b6e62d9948226f5cd",
      "created_at": "2026-07-06T21:49:21.524Z" }
  ]
}
```
`tx_url` is server-constructed (Arc testnet Blockscout base + `tx_hash`) — use it directly as a link `href`, don't reconstruct it client-side. `null` if `tx_hash` is `null` (shouldn't happen in the current worker flow, but don't assume).

### `GET /clips/:id/earnings`
The Clipper campaign page's live earnings ticker: one clip's running total plus recent settlement history (last 20), each with the same `tx_url` convenience field.
```json
{
  "clip_id": 5,
  "campaign_id": 1,
  "clipper_wallet": "0xc33558f7Ebcfd128AED6F7ACf3130a7B07B61C0D",
  "effective_cpm_rate": "50020",
  "total_earnings": "830",
  "current_view_count": 20050,
  "last_polled_at": "2026-07-06T21:36:37.544Z",
  "recent_settlements": [
    { "id": 14, "view_delta": 10, "amount": "630",
      "settlement_id": "0x3fefa9478bf7a6e82c5936a8deae72bd45febc048e639d3b96f8d32c02847d4c",
      "tx_hash": "0x83789ac8af148fe973a2b846d0e0f2bd2d5734b416c61f5b6e62d9948226f5cd",
      "tx_url": "https://testnet.arcscan.app/tx/0x83789ac8af148fe973a2b846d0e0f2bd2d5734b416c61f5b6e62d9948226f5cd",
      "created_at": "2026-07-06T21:49:21.524Z" }
  ]
}
```

### `GET /organizers/:wallet/campaigns`
**Not explicitly requested** — added because CLAUDE.md's page structure reference names an Organizer Profile page, and this is the natural data it needs: list of campaigns this organizer created, plus an aggregate spend figure across all of them (the Organizer Profile page's headline number).
```json
{
  "organizer_wallet": "0x8a69D789Dc390779D0D0BffB69583F11CC3adc3E",
  "aggregate_spend": "980",
  "campaigns": [ /* same shape as GET /campaigns */ ]
}
```
`aggregate_spend` is bigint-as-text — the sum of `total_settled` across every campaign this organizer created.

---

## Part 3: Live-updating data — polling is right, at a tuned interval

The two "live" surfaces — the clip earnings ticker (`GET /clips/:id/earnings`) and the agent decision feed (`GET /campaigns/:id/agent-decisions`) — are both downstream of scheduled backend jobs, not real-time streams. Their actual update cadence, from `.env.example`:

- View Poller: `VIEW_POLL_INTERVAL_SECONDS=60` — view counts change at most once a minute
- Settlement Worker: `SETTLEMENT_INTERVAL_SECONDS=60` — earnings totals change at most once a minute
- Pacing Agent: `PACING_INTERVAL_SECONDS=120` — rates/decisions change at most once every two minutes

**Recommendation: simple polling, but at ~15–20s for the earnings ticker and ~30s for the decision feed — not 5–10s.** Polling every 5–10s against data that only changes every 60–120s wastes roughly 6–12x the requests for no additional freshness; the frontend would just be re-fetching the same values repeatedly. 15–20s keeps the ticker feeling responsive (worst case ~20s of staleness against a 60s source) without the waste, and the decision feed can poll slower still since its source only moves every 2 minutes.

**SSE/websockets are not warranted here.** That complexity earns its keep when updates are frequent and push-driven (sub-second, or genuinely event-triggered rather than polling-cadence-bound). Here, the ceiling on freshness is set by a 60–120s backend job either way — a websocket connection would still only ever have something new to say once a minute, so it buys latency precision the underlying data can't use, at the cost of connection lifecycle management, reconnect logic, and server-side fan-out the hackathon timeline doesn't need. Agree with the polling-is-fine default; just tune the interval to the real cadence above rather than an arbitrary 5–10s guess.
