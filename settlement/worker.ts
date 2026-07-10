import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import {
  listPendingSettlementsByStatus,
  markPendingSettlementSettled,
  markPendingSettlementFailed,
  insertSettlement,
  getCampaignById,
  getClipById,
  getTotalSettledAmountForClip,
  setClipCapped,
  PendingSettlement,
} from "../db/db";
import { clampToRemainingCap } from "./pendingSettlement";
import { CampaignEscrow__factory } from "../typechain-types/factories/contracts/CampaignEscrow__factory";
import { PayoutRegistry__factory } from "../typechain-types/factories/contracts/PayoutRegistry__factory";
import type { CampaignEscrow, PayoutRegistry } from "../typechain-types";

/**
 * Settlement Worker: on a configurable interval, claims 'pending' rows from
 * pending_settlements and, for each, calls the two real on-chain writes —
 * CampaignEscrow.release() (the actual USDC transfer; this IS the
 * nanopayment, there is no separate Circle Gateway call here) and
 * PayoutRegistry.recordPayout() (the independently-verifiable audit log
 * entry) — then records the result. Rows are processed strictly
 * sequentially: these are real transactions from one signer (the
 * authorized agent), and concurrent sends from a single account need nonce
 * management this scale doesn't require yet.
 *
 * Same setInterval choice as the View Poller, for the same reason: this is
 * "check every N seconds," not a calendar schedule, so setInterval says
 * that directly without a cron-syntax dependency we'd only use for one job.
 */

interface Deployments {
  campaignEscrow: string;
  payoutRegistry: string;
}

function loadDeployments(): Deployments {
  const deploymentsPath = process.env.DEPLOYMENTS_OUT || path.join(__dirname, "..", "deployments.json");
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error(`No deployments file at ${deploymentsPath} — run the deploy script first.`);
  }
  return JSON.parse(fs.readFileSync(deploymentsPath, "utf-8")) as Deployments;
}

function loadProvider(): ethers.JsonRpcProvider {
  const rpcUrl = process.env.ARC_TESTNET_RPC_URL;
  if (!rpcUrl) {
    throw new Error("Set ARC_TESTNET_RPC_URL in .env");
  }
  return new ethers.JsonRpcProvider(rpcUrl);
}

function loadAgentWallet(provider: ethers.Provider): ethers.Wallet {
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "Set AGENT_PRIVATE_KEY in .env — this signs release() and recordPayout() as the authorized agent " +
        "for both CampaignEscrow (per-campaign) and PayoutRegistry (deployment-wide)."
    );
  }
  return new ethers.Wallet(key, provider);
}

/** Extracts a human-readable revert reason from an ethers v6 error, falling back sensibly. */
function describeError(err: any): string {
  return err.shortMessage || err.reason || err.message || String(err);
}

/**
 * Hands out sequentially incrementing nonces for one agent across a whole
 * settlement cycle. Fetched once per cycle rather than re-queried before
 * each send — ethers v6's JsonRpcProvider briefly caches getTransactionCount
 * results, so re-querying "latest" immediately after a `.wait()` can still
 * return a stale pre-mined value and collide with the send that just
 * confirmed. Since every send in this worker is already strictly sequential
 * (one signer, rows processed one at a time, .wait() before the next send),
 * a local counter is both simpler and correct without depending on the RPC
 * layer's freshness at all after the initial fetch.
 *
 * peek()/confirmBroadcast() are deliberately separate calls, not one
 * take()-and-advance — found for real, not hypothetical: a send whose gas
 * estimation reverts (ethers throws before ever broadcasting, e.g. a
 * pre-existing bad campaign/wallet in seed data) never actually consumes a
 * chain nonce, but an unconditional take()-and-advance still moved the local
 * counter past it. Every subsequent send in that cycle then requested a
 * nonce one higher than the chain's real next nonce — a permanent gap the
 * chain can never fill, so the next send sat in the mempool forever,
 * unconfirmable. Reproduced live against real Arc testnet: pending
 * settlement queued right after one that failed at gas estimation hung
 * indefinitely (process had to be killed; chain's pending nonce never moved
 * past latest, confirming the tx never actually broadcast). Fix: only
 * confirmBroadcast() once a send has genuinely returned a transaction
 * response (has a real hash) — a mined-but-reverted tx still broadcast and
 * still consumes a nonce, so that case still advances; a pre-broadcast
 * throw does not.
 */
class SequentialNonceTracker {
  private next: number;

  private constructor(startNonce: number) {
    this.next = startNonce;
  }

  static async forAgent(provider: ethers.Provider, address: string): Promise<SequentialNonceTracker> {
    const startNonce = await provider.getTransactionCount(address, "latest");
    return new SequentialNonceTracker(startNonce);
  }

  /** Returns the nonce to use for the next send. Does not advance — call confirmBroadcast() once the send is known to have gone out. */
  peek(): number {
    return this.next;
  }

  /** Call only after a send has actually returned a transaction response (a real hash) — i.e. it was genuinely broadcast and will consume this nonce on-chain regardless of eventual mining outcome. */
  confirmBroadcast(): void {
    this.next++;
  }
}

export async function processPendingSettlement(
  pending: PendingSettlement,
  escrow: CampaignEscrow,
  registry: PayoutRegistry,
  nonceTracker: SequentialNonceTracker
): Promise<void> {
  // Defense in depth beyond runSettlementCycle's own 'pending'-only query: never
  // let a re-processed row overwrite a status it's already moved past. Without
  // this, a stray re-run against an already-settled row would revert on-chain
  // (correctly, no double-pay) but then clobber that row's correct 'settled'
  // record with an incorrect 'failed' one — the chain stays right, the DB goes
  // wrong. Caught by exactly this scenario during testing.
  if (pending.status !== "pending") {
    console.warn(
      `[settlement] pending #${pending.id}: skipping — status is '${pending.status}', not 'pending' (settlement_id ${pending.settlement_id})`
    );
    return;
  }

  const campaign = getCampaignById(pending.campaign_id);
  if (!campaign) {
    const reason = `no campaign row for id ${pending.campaign_id}`;
    markPendingSettlementFailed(pending.id, reason);
    console.error(`[settlement] pending #${pending.id}: FAILED — ${reason}`);
    return;
  }

  const onChainCampaignId = BigInt(campaign.contract_campaign_id);
  const requestedAmount = BigInt(pending.computed_amount);
  const viewDelta = BigInt(pending.view_delta);

  // A zero-delta poll (view count genuinely didn't move) produces a
  // legitimate computed_amount of 0. Handle this before the cap check below:
  // clampToRemainingCap({requestedAmount: 0n, cap: null}) also returns
  // payableAmount 0n, which the cap-check branch would otherwise mislabel as
  // "per-clip cap already reached" and incorrectly flip clips.is_capped on an
  // uncapped clip — found by exactly this scenario during testing (a real
  // zero-delta poll on an uncapped clip got marked capped).  There's simply
  // nothing to release here; it isn't a cap problem or an error.
  if (requestedAmount === 0n) {
    const reason = "computed_amount is zero (no new views this cycle) — nothing to release";
    markPendingSettlementFailed(pending.id, reason);
    console.log(`[settlement] pending #${pending.id}: SKIPPED — ${reason}`);
    return;
  }

  // Defensive rate-ceiling check. cpm_rate is enforced <= max_cpm at campaign
  // creation (db.ts's insertCampaign), which is the only enforcement point
  // today since nothing adjusts rates dynamically yet — but once the Pacing
  // Agent can adjust cpm_rate, a since-changed rate could have produced this
  // computed_amount under a now-invalid rate by the time the worker gets to
  // it. Rejecting (not clamping) on purpose: a per-clip-cap clamp has one
  // obviously correct value ("pay what's left"), but there's no equally clean
  // "correct" amount to clamp a rate-ceiling violation down to — the queued
  // amount was computed under a rate that shouldn't have been in effect at
  // all, so paying *some* recalculated amount would be paying for something
  // the Validation Engine never actually approved. Rejecting surfaces the
  // misconfiguration instead of quietly paying an invented number.
  if (viewDelta > 0n) {
    const effectiveRate = requestedAmount / viewDelta;
    const maxAllowedRate = BigInt(campaign.max_cpm) / 1000n;
    if (effectiveRate > maxAllowedRate) {
      const reason =
        `effective per-view rate ${effectiveRate} exceeds campaign max_cpm/1000 ceiling ${maxAllowedRate} ` +
        `(max_cpm=${campaign.max_cpm})`;
      markPendingSettlementFailed(pending.id, reason);
      console.error(`[settlement] pending #${pending.id}: FAILED (rate ceiling) — ${reason}`);
      return;
    }
  }

  // Per-clip cap enforcement. Recomputed from settlements every time
  // (correctness over performance at this scale) rather than trusting a
  // denormalized running total — clips.is_capped is only ever a hint for the
  // View Poller, never consulted here.
  const clip = getClipById(pending.clip_id);
  if (!clip) {
    const reason = `no clip row for id ${pending.clip_id}`;
    markPendingSettlementFailed(pending.id, reason);
    console.error(`[settlement] pending #${pending.id}: FAILED — ${reason}`);
    return;
  }

  const alreadyPaid = getTotalSettledAmountForClip(pending.clip_id);
  const cap = clip.per_clip_cap !== null ? BigInt(clip.per_clip_cap) : null;
  const { payableAmount, isCapped } = clampToRemainingCap({ requestedAmount, alreadyPaid, cap });

  if (payableAmount === 0n) {
    const reason = "per-clip cap already reached";
    markPendingSettlementFailed(pending.id, reason);
    setClipCapped(pending.clip_id, true);
    console.log(`[settlement] pending #${pending.id}: FAILED (cap) — ${reason} (clip ${pending.clip_id})`);
    return;
  }

  if (payableAmount < requestedAmount) {
    console.log(
      `[settlement] pending #${pending.id}: clamped ${requestedAmount} -> ${payableAmount} ` +
        `(clip ${pending.clip_id} per-clip cap ${cap})`
    );
  }

  const amount = payableAmount;
  const rationaleHash = ethers.keccak256(ethers.toUtf8Bytes(pending.validation_reason ?? ""));

  // CampaignEscrow.release() is the money movement — if this fails, nothing
  // happened on-chain, so it's safe to mark the row failed outright.
  let releaseReceipt: ethers.TransactionReceipt;
  try {
    console.log(
      `[settlement] pending #${pending.id}: releasing ${amount} to ${pending.clipper_wallet} ` +
        `(campaign ${onChainCampaignId}, settlement ${pending.settlement_id})`
    );
    const releaseTx = await escrow.release(onChainCampaignId, pending.clipper_wallet, amount, pending.settlement_id, {
      nonce: nonceTracker.peek(),
    });
    // escrow.release() returned a response object (a real tx hash) — the
    // send genuinely reached the mempool, so this nonce is consumed on-chain
    // now regardless of whether it eventually mines or reverts. Only safe to
    // advance past this point, not before it (see SequentialNonceTracker's
    // doc comment for the real bug this fixes).
    nonceTracker.confirmBroadcast();
    const receipt = await releaseTx.wait();
    if (!receipt) {
      throw new Error("release() transaction did not confirm (null receipt)");
    }
    releaseReceipt = receipt;
  } catch (err: any) {
    const reason = describeError(err);
    markPendingSettlementFailed(pending.id, reason);
    console.error(`[settlement] pending #${pending.id}: FAILED (release) — ${reason}`);
    return;
  }

  // release() succeeded — the payment is real and final (CampaignEscrow is the
  // source of truth for money movement). Record it as settled *before*
  // attempting the audit-log call, so a problem recording to PayoutRegistry
  // can never make an actual payment look like it failed. amount here is the
  // actual (possibly clamped) amount paid, not necessarily pending.computed_amount.
  insertSettlement({
    campaign_id: pending.campaign_id,
    clip_id: pending.clip_id,
    clipper_wallet: pending.clipper_wallet,
    view_delta: Number(viewDelta),
    amount: amount.toString(),
    settlement_id: pending.settlement_id,
    tx_hash: releaseReceipt.hash,
  });
  markPendingSettlementSettled(pending.id, releaseReceipt.hash);
  if (isCapped) {
    setClipCapped(pending.clip_id, true);
  }
  console.log(`[settlement] pending #${pending.id}: SETTLED — tx ${releaseReceipt.hash}`);

  try {
    const recordTx = await registry.recordPayout(
      pending.settlement_id,
      onChainCampaignId,
      pending.clipper_wallet,
      viewDelta,
      amount,
      rationaleHash,
      { nonce: nonceTracker.peek() }
    );
    nonceTracker.confirmBroadcast();
    await recordTx.wait();
    console.log(`[settlement] pending #${pending.id}: audit log recorded in PayoutRegistry`);
  } catch (err: any) {
    const reason = describeError(err);
    console.error(
      `[settlement] pending #${pending.id}: payment SETTLED (tx ${releaseReceipt.hash}) but ` +
        `PayoutRegistry.recordPayout FAILED — ${reason} — audit log entry missing, needs manual follow-up`
    );
  }
}

let isRunning = false;

export async function runSettlementCycle(): Promise<void> {
  if (isRunning) {
    console.warn("[settlement] previous cycle still running, skipping this tick");
    return;
  }
  isRunning = true;
  try {
    const pendingRows = listPendingSettlementsByStatus("pending");
    if (pendingRows.length === 0) {
      console.log("[settlement] no pending settlements");
      return;
    }

    const deployments = loadDeployments();
    const provider = loadProvider();
    const agent = loadAgentWallet(provider);
    const escrow = CampaignEscrow__factory.connect(deployments.campaignEscrow, agent);
    const registry = PayoutRegistry__factory.connect(deployments.payoutRegistry, agent);
    const nonceTracker = await SequentialNonceTracker.forAgent(provider, agent.address);

    console.log(`[settlement] processing ${pendingRows.length} pending settlement(s), sequentially`);
    for (const pending of pendingRows) {
      await processPendingSettlement(pending, escrow, registry, nonceTracker);
    }
  } finally {
    isRunning = false;
  }
}

const DEFAULT_INTERVAL_SECONDS = 60;

export function getSettlementIntervalSeconds(): number {
  const raw = process.env.SETTLEMENT_INTERVAL_SECONDS;
  const parsed = raw ? Number(raw) : DEFAULT_INTERVAL_SECONDS;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`SETTLEMENT_INTERVAL_SECONDS must be a positive number, got: ${raw}`);
  }
  return parsed;
}

export function startSettlementWorker(intervalSeconds: number = getSettlementIntervalSeconds()): NodeJS.Timeout {
  console.log(`[settlement] starting, checking every ${intervalSeconds}s`);
  void runSettlementCycle();
  return setInterval(() => void runSettlementCycle(), intervalSeconds * 1000);
}
