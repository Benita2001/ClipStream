/**
 * Real on-chain contract calls (createCampaign, topUp) signed through a
 * Circle User-Controlled Wallet's PIN-approval flow — the organizer-facing
 * counterpart to server/circleWallets.ts's wallet-creation flow. Extends
 * that flow rather than duplicating it: reuses getCircleClient() and the
 * same createUser/session/PIN-challenge endpoints for wallet creation
 * itself (see /circle-wallets/finalize's new owner_type param); this file
 * only adds what's genuinely new — starting and confirming a *contract
 * execution* challenge, which is a different Circle SDK method with
 * different confirmation semantics than CREATE_WALLET.
 *
 * Real method confirmed against the installed @circle-fin/user-controlled-
 * wallets package's own .d.ts files, not assumed from docs summaries:
 * `client.createUserTransactionContractExecutionChallenge(input)`, taking
 * `abiFunctionSignature` + `abiParameters` (or raw `callData`),
 * `contractAddress`, `amount` (payable value), a wallet reference
 * (walletId, or walletAddress+blockchain — this file uses the latter since
 * the frontend only persists a wallet address, not a Circle walletId), and
 * a required `fee` (FeeConfiguration<FeeLevel> — no default exists in the
 * SDK, so this file always sends `{type: 'level', config: {feeLevel:
 * 'MEDIUM'}}`). Returns a challengeId via the same PinData shape as
 * CREATE_WALLET challenges (`response.data?.challengeId`).
 */

import { Router, Request, Response } from "express";
import * as fs from "fs";
import * as path from "path";
import { getCircleClient } from "./circleWallets";
import { getConfiguredAgentAddress } from "./chain";

// Deliberately NOT USDC_DECIMALS (6) — see the doc comment below. This is
// the chain's real native-currency wei granularity, confirmed for real
// against the actual funded agent wallet's on-chain balance, not assumed.
const NATIVE_TOKEN_DECIMALS = 18;

/**
 * Circle's contract-execution `amount` field is a decimal-formatted
 * *native-token* amount — Circle converts it to the real msg.value wei
 * figure using the chain's actual native-currency decimals, a chain-level
 * protocol property. That is a different number from USDC_DECIMALS (6),
 * which is this app's own purely-cosmetic display convention layered on
 * top of raw wei counts (every direct-ethers script in this project,
 * e.g. scripts/arc-testnet-create-campaign.ts, sends `{value: 10000}` —
 * literally 10000 raw wei — and the app then just displays that integer
 * as if it were a 6-decimal USDC amount; Solidity's `uint256` has no
 * inherent notion of decimals at all). Confirmed for real, not assumed:
 * the agent wallet's actual on-chain balance read as 19985942184556800000
 * wei, which only resolves to a sane, round faucet-drip-sized number
 * (~19.99 tokens, i.e. a ~20-token drip minus real gas spent this
 * session) under the standard 18-decimal EVM interpretation — confirming
 * Arc's native currency uses 18 decimals at the raw wei/msg.value level,
 * same as any standard EVM chain, regardless of its "USDC" branding.
 * Getting this wrong doesn't just misplace a decimal point — it's a
 * literal 10^12x unit mismatch between what an organizer types in the
 * form (this app's own 6-decimal base units) and what would actually get
 * deposited on-chain (native-token amounts at 18-decimal granularity).
 * So: convert the base-units-string (which already directly equals the
 * intended raw wei count, per the project's established "1 wei = 1
 * display base unit" convention) into a decimal string at 18 decimal
 * places, not 6.
 */
function baseUnitsToDecimalString(baseUnits: string): string {
  const negative = baseUnits.startsWith("-");
  const digits = negative ? baseUnits.slice(1) : baseUnits;
  const padded = digits.padStart(NATIVE_TOKEN_DECIMALS + 1, "0");
  const whole = padded.slice(0, padded.length - NATIVE_TOKEN_DECIMALS);
  const fraction = padded.slice(padded.length - NATIVE_TOKEN_DECIMALS);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

interface Deployments {
  campaignEscrow: string;
}

function loadDeployments(): Deployments {
  const deploymentsPath = process.env.DEPLOYMENTS_OUT || path.join(__dirname, "..", "deployments.json");
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error(`No deployments file at ${deploymentsPath} — run the deploy script first.`);
  }
  return JSON.parse(fs.readFileSync(deploymentsPath, "utf-8")) as Deployments;
}

const MEDIUM_FEE = { type: "level" as const, config: { feeLevel: "MEDIUM" as const } };

export const circleTransactionsRouter = Router();

/**
 * Starts a real createCampaign(uint256,uint256,address) payable challenge.
 * authorizedAgent is server-supplied from getConfiguredAgentAddress(), not
 * trusted from the request body — same defense-in-depth property POST
 * /campaigns already has (a client can't misrepresent which agent a
 * campaign authorizes, which would otherwise silently create a campaign
 * our own Settlement Worker could never release() against).
 */
circleTransactionsRouter.post("/circle-wallets/create-campaign/init", async (req: Request, res: Response) => {
  const { userToken, walletAddress, base_rate, max_duration, deposit_amount } = req.body ?? {};
  console.log(`[circle-transactions] POST /circle-wallets/create-campaign/init walletAddress=${walletAddress}`);
  if (
    typeof userToken !== "string" ||
    typeof walletAddress !== "string" ||
    typeof base_rate !== "number" ||
    typeof max_duration !== "number" ||
    typeof deposit_amount !== "string"
  ) {
    return res.status(400).json({
      error:
        "userToken (string), walletAddress (string), base_rate (number), max_duration (number), " +
        "deposit_amount (string, USDC base units) are required",
    });
  }
  try {
    const client = getCircleClient();
    const { campaignEscrow } = loadDeployments();
    const authorizedAgent = getConfiguredAgentAddress();
    const response = await client.createUserTransactionContractExecutionChallenge({
      userToken,
      walletAddress,
      blockchain: "ARC-TESTNET",
      contractAddress: campaignEscrow,
      abiFunctionSignature: "createCampaign(uint256,uint256,address)",
      abiParameters: [base_rate, max_duration, authorizedAgent],
      amount: baseUnitsToDecimalString(deposit_amount),
      fee: MEDIUM_FEE,
    });
    const challengeId = response.data?.challengeId;
    if (!challengeId) throw new Error("Circle response missing challengeId");
    console.log(`[circle-transactions] started createCampaign challenge ${challengeId}`);
    res.json({ challengeId });
  } catch (err: any) {
    console.error(`[circle-transactions] create-campaign/init failed: ${err.message}`);
    res.status(502).json({ error: `Failed to start createCampaign challenge: ${err.message}` });
  }
});

/** Starts a real topUp(uint256) payable challenge on an existing campaign. */
circleTransactionsRouter.post("/circle-wallets/top-up/init", async (req: Request, res: Response) => {
  const { userToken, walletAddress, contract_campaign_id, amount } = req.body ?? {};
  console.log(`[circle-transactions] POST /circle-wallets/top-up/init walletAddress=${walletAddress} contract_campaign_id=${contract_campaign_id}`);
  if (
    typeof userToken !== "string" ||
    typeof walletAddress !== "string" ||
    typeof contract_campaign_id !== "string" ||
    typeof amount !== "string"
  ) {
    return res.status(400).json({
      error: "userToken (string), walletAddress (string), contract_campaign_id (string), amount (string, USDC base units) are required",
    });
  }
  try {
    const client = getCircleClient();
    const { campaignEscrow } = loadDeployments();
    const response = await client.createUserTransactionContractExecutionChallenge({
      userToken,
      walletAddress,
      blockchain: "ARC-TESTNET",
      contractAddress: campaignEscrow,
      abiFunctionSignature: "topUp(uint256)",
      abiParameters: [contract_campaign_id],
      amount: baseUnitsToDecimalString(amount),
      fee: MEDIUM_FEE,
    });
    const challengeId = response.data?.challengeId;
    if (!challengeId) throw new Error("Circle response missing challengeId");
    console.log(`[circle-transactions] started topUp challenge ${challengeId}`);
    res.json({ challengeId });
  } catch (err: any) {
    console.error(`[circle-transactions] top-up/init failed: ${err.message}`);
    res.status(502).json({ error: `Failed to start topUp challenge: ${err.message}` });
  }
});

const CHALLENGE_POLL_ATTEMPTS = 10;
const CHALLENGE_POLL_DELAY_MS = 1500;
// Arc testnet block confirmation observed to take real, noticeable time
// earlier in this project (documented in CLAUDE.md) — a longer window than
// the wallet-creation challenge poll, which only ever needed one attempt.
const TX_POLL_ATTEMPTS = 40;
const TX_POLL_DELAY_MS = 2000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TERMINAL_SUCCESS_STATES = new Set(["COMPLETE", "CONFIRMED"]);
const TERMINAL_FAILURE_STATES = new Set(["FAILED", "DENIED", "CANCELLED"]);

/**
 * Generic finalize for any contract-execution challenge (createCampaign or
 * topUp) — one endpoint, not duplicated per call type, since both reduce to
 * "wait until this challenge's transaction is genuinely confirmed on-chain
 * and give me the tx hash."
 *
 * Two-layer poll, the same real lesson from the wallet-creation finalize
 * race documented in CLAUDE.md: a challenge reporting COMPLETE only means
 * the user's PIN approval finished client-side, not that the underlying
 * blockchain transaction has actually been broadcast and mined. Layer 1
 * polls the challenge; layer 2 polls the resulting transaction itself
 * until it reaches a terminal on-chain state.
 *
 * Layer 1 -> transaction id: the SDK's own Challenge.correlationIds doc
 * comment only explicitly names CREATE_TRANSACTION/ACCELERATE_TRANSACTION/
 * CANCEL_TRANSACTION as populating it — CONTRACT_EXECUTION challenges are
 * not explicitly listed, so this does not assume correlationIds works the
 * same way here just because it's transaction-shaped. It tries
 * correlationIds first; if empty, falls back to the most recent
 * CONTRACT_EXECUTION transaction for this user via listTransactions
 * (filtered by operation + most-recent-first, not by walletId — this app
 * never persists a Circle walletId client-side, only a wallet address, and
 * each Circle user in this app maps to exactly one wallet, so recency +
 * operation type is unambiguous in practice).
 */
circleTransactionsRouter.post("/circle-wallets/transactions/finalize", async (req: Request, res: Response) => {
  const { userToken, challengeId } = req.body ?? {};
  console.log(`[circle-transactions] POST /circle-wallets/transactions/finalize challengeId=${challengeId}`);
  if (typeof userToken !== "string" || typeof challengeId !== "string") {
    return res.status(400).json({ error: "userToken (string) and challengeId (string) are required" });
  }
  try {
    const client = getCircleClient();

    let transactionId: string | undefined;
    for (let attempt = 1; attempt <= CHALLENGE_POLL_ATTEMPTS; attempt++) {
      const challengeResponse = await client.getUserChallenge({ userToken, challengeId });
      const challenge = challengeResponse.data!.challenge;
      console.log(`[circle-transactions] challenge ${challengeId} status=${challenge.status} (attempt ${attempt}/${CHALLENGE_POLL_ATTEMPTS})`);
      if (challenge.status === "COMPLETE") {
        transactionId = challenge.correlationIds?.[0];
        break;
      }
      if (challenge.status === "FAILED" || challenge.status === "EXPIRED") {
        return res.status(502).json({ error: `Transaction challenge ${challenge.status.toLowerCase()}: ${challenge.errorMessage ?? "no further detail"}` });
      }
      await sleep(CHALLENGE_POLL_DELAY_MS);
    }

    if (!transactionId) {
      const listResponse = await client.listTransactions({ userToken, operation: "CONTRACT_EXECUTION", order: "DESC" });
      const transactions = listResponse.data?.transactions;
      console.log(`[circle-transactions] fallback listTransactions returned ${transactions?.length ?? 0} transaction(s)`);
      if (!transactions || transactions.length === 0) {
        return res.status(502).json({ error: "Challenge completed but no resulting transaction could be found" });
      }
      transactionId = transactions[0].id;
    }

    for (let attempt = 1; attempt <= TX_POLL_ATTEMPTS; attempt++) {
      const txResponse = await client.getTransaction({ id: transactionId, userToken });
      const tx = txResponse.data?.transaction;
      if (!tx) {
        return res.status(502).json({ error: `Transaction ${transactionId} not found` });
      }
      console.log(
        `[circle-transactions] transaction ${transactionId} state=${tx.state} txHash=${tx.txHash ?? "(none yet)"} ` +
          `(attempt ${attempt}/${TX_POLL_ATTEMPTS})`
      );
      if (TERMINAL_SUCCESS_STATES.has(tx.state)) {
        if (!tx.txHash) {
          return res.status(502).json({ error: `Transaction reached ${tx.state} state but has no txHash` });
        }
        console.log(`[circle-transactions] transaction ${transactionId} confirmed: ${tx.txHash}`);
        return res.json({ tx_hash: tx.txHash, state: tx.state });
      }
      if (TERMINAL_FAILURE_STATES.has(tx.state)) {
        return res.status(502).json({ error: `Transaction ${tx.state.toLowerCase()}: ${tx.errorReason ?? "no further detail"}` });
      }
      await sleep(TX_POLL_DELAY_MS);
    }

    res.status(502).json({ error: "Transaction did not confirm within the polling window — it may still complete; check back shortly" });
  } catch (err: any) {
    console.error(`[circle-transactions] finalize failed: ${err.message}`);
    res.status(502).json({ error: `Failed to finalize transaction: ${err.message}` });
  }
});
