/**
 * Circle User-Controlled Wallets integration for clippers — real SDK calls,
 * not raw REST. Method names/shapes below are copied from the actual
 * installed @circle-fin/user-controlled-wallets type definitions
 * (node_modules/@circle-fin/user-controlled-wallets/dist/types/...), not
 * guessed from docs summaries.
 *
 * Design (see CLAUDE.md for the full write-up): Circle's createUser({userId})
 * happens before any wallet address exists — the address is only produced
 * once the PIN+wallet-creation challenge completes client-side. So this
 * flow is temporally decoupled from our own `wallets` table:
 *   1. POST /circle-wallets/users     — create a Circle user (no address yet)
 *   2. POST /circle-wallets/session   — issue a session token for that user
 *   3. POST /circle-wallets/init-wallet — start the PIN+wallet challenge,
 *      returns a challengeId the frontend executes via the Web SDK
 *   4. POST /circle-wallets/finalize  — called after the challenge succeeds;
 *      lists the user's wallets to get the real address, then (and only
 *      then) registers it in our own `wallets` table (owner_type='clipper',
 *      wallet_type='user_controlled') and the new `circle_users` mapping
 *      table, via the same upsertWallet() the existing POST /wallets uses.
 *
 * accountType defaults to EOA: clippers only ever receive payouts in this
 * app today (the Settlement Worker pushes funds via release() — clippers
 * never sign an outbound transaction), so SCA's gas-sponsorship/abstraction
 * benefits don't apply yet. Revisit if clippers ever need to send their own
 * transactions.
 */

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { initiateUserControlledWalletsClient } from "@circle-fin/user-controlled-wallets";
import { upsertWallet, insertCircleUser, getWalletByAddress } from "../db/db";

/** Exported so server/circleTransactions.ts can reuse the same client construction rather than duplicating it. */
export function getCircleClient() {
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) {
    throw new Error("Set CIRCLE_API_KEY in .env");
  }
  return initiateUserControlledWalletsClient({ apiKey });
}

export const circleWalletsRouter = Router();

/** Creates a Circle user. We generate the userId ourselves — Circle just registers it. */
circleWalletsRouter.post("/circle-wallets/users", async (req: Request, res: Response) => {
  console.log("[circle-wallets] POST /circle-wallets/users");
  try {
    const client = getCircleClient();
    const userId = randomUUID();
    await client.createUser({ userId });
    console.log(`[circle-wallets] created user ${userId}`);
    res.status(201).json({ userId });
  } catch (err: any) {
    console.error(`[circle-wallets] createUser failed: ${err.message}`);
    res.status(502).json({ error: `Failed to create Circle user: ${err.message}` });
  }
});

/** Issues a session token (60 min expiry) for an existing Circle userId — used both at first signup and to resume a returning user's session. */
circleWalletsRouter.post("/circle-wallets/session", async (req: Request, res: Response) => {
  const { userId } = req.body ?? {};
  console.log(`[circle-wallets] POST /circle-wallets/session userId=${userId}`);
  if (typeof userId !== "string") {
    return res.status(400).json({ error: "userId (string) is required" });
  }
  try {
    const client = getCircleClient();
    const response = await client.createUserToken({ userId });
    const { userToken, encryptionKey } = response.data!;
    console.log(`[circle-wallets] issued session token for ${userId}`);
    res.json({ userToken, encryptionKey });
  } catch (err: any) {
    console.error(`[circle-wallets] createUserToken failed: ${err.message}`);
    res.status(502).json({ error: `Failed to create session token: ${err.message}` });
  }
});

/** Starts the PIN-setup + wallet-creation challenge. Returns a challengeId the frontend executes via the Web SDK's sdk.execute(). */
circleWalletsRouter.post("/circle-wallets/init-wallet", async (req: Request, res: Response) => {
  const { userToken, accountType } = req.body ?? {};
  console.log("[circle-wallets] POST /circle-wallets/init-wallet");
  if (typeof userToken !== "string") {
    return res.status(400).json({ error: "userToken (string) is required" });
  }
  try {
    const client = getCircleClient();
    const response = await client.createUserPinWithWallets({
      userToken,
      blockchains: ["ARC-TESTNET"],
      accountType: accountType === "SCA" ? "SCA" : "EOA",
    });
    const { challengeId } = response.data!;
    console.log(`[circle-wallets] started challenge ${challengeId}`);
    res.json({ challengeId });
  } catch (err: any) {
    console.error(`[circle-wallets] createUserPinWithWallets failed: ${err.message}`);
    res.status(502).json({ error: `Failed to start wallet creation challenge: ${err.message}` });
  }
});

const CHALLENGE_POLL_ATTEMPTS = 10;
const CHALLENGE_POLL_DELAY_MS = 1500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Called after the frontend's sdk.execute(challengeId, ...) callback fires
 * successfully. That callback only reflects the client-side PIN interaction
 * finishing — the server-side challenge (and the wallet it creates) can
 * still be PENDING/IN_PROGRESS at that instant. Confirmed for real: an
 * end-to-end test hit exactly this race (finalize's old immediate
 * listWallets() call came back empty even though the user had genuinely
 * completed the PIN flow), traced via the installed SDK's own type defs —
 * Challenge.correlationIds is documented as "For type CREATE_WALLET, the
 * wallet id associated with the request." So: poll getUserChallenge() until
 * it leaves PENDING/IN_PROGRESS, then fetch the wallet by the id in
 * correlationIds (falling back to listWallets only if that's ever empty).
 */
circleWalletsRouter.post("/circle-wallets/finalize", async (req: Request, res: Response) => {
  const { userToken, userId, challengeId, owner_type } = req.body ?? {};
  console.log(`[circle-wallets] POST /circle-wallets/finalize userId=${userId} challengeId=${challengeId} owner_type=${owner_type ?? "clipper"}`);
  if (typeof userToken !== "string" || typeof userId !== "string" || typeof challengeId !== "string") {
    return res.status(400).json({ error: "userToken (string), userId (string), and challengeId (string) are required" });
  }
  // Same wallet-creation flow serves both roles — only what happens after
  // differs (clippers just get an address; organizers go on to sign
  // contract calls). owner_type is optional and defaults to 'clipper' so
  // the existing Clipper flow (which never sends it) is unaffected.
  const ownerType = owner_type === "organizer" ? "organizer" : "clipper";
  try {
    const client = getCircleClient();

    let walletId: string | undefined;
    for (let attempt = 1; attempt <= CHALLENGE_POLL_ATTEMPTS; attempt++) {
      const challengeResponse = await client.getUserChallenge({ userToken, challengeId });
      const challenge = challengeResponse.data!.challenge;
      console.log(`[circle-wallets] challenge ${challengeId} status=${challenge.status} (attempt ${attempt}/${CHALLENGE_POLL_ATTEMPTS})`);

      if (challenge.status === "COMPLETE") {
        walletId = challenge.correlationIds?.[0];
        break;
      }
      if (challenge.status === "FAILED" || challenge.status === "EXPIRED") {
        return res.status(502).json({ error: `Wallet creation challenge ${challenge.status.toLowerCase()}: ${challenge.errorMessage ?? "no further detail"}` });
      }
      await sleep(CHALLENGE_POLL_DELAY_MS);
    }

    if (!walletId) {
      // Challenge reported COMPLETE with no correlationId, or never left PENDING/IN_PROGRESS
      // in time — fall back to a direct list as a last resort before giving up.
      const listResponse = await client.listWallets({ userToken, blockchain: "ARC-TESTNET" });
      const wallets = listResponse.data!.wallets;
      console.log(`[circle-wallets] fallback listWallets returned ${wallets?.length ?? 0} wallet(s) for ${userId}`);
      if (!wallets || wallets.length === 0) {
        return res.status(502).json({ error: "Wallet creation is still processing — please try again in a few seconds" });
      }
      walletId = wallets[0].id;
    }

    const walletResponse = await client.getWallet({ id: walletId, userToken });
    const wallet = walletResponse.data!.wallet;
    const address = wallet.address;

    if (!getWalletByAddress(address)) {
      upsertWallet({ address, owner_type: ownerType, wallet_type: "user_controlled" });
      insertCircleUser({ wallet_address: address, circle_user_id: userId });
      console.log(`[circle-wallets] registered new ${ownerType} wallet ${address} for user ${userId}`);
    } else {
      console.log(`[circle-wallets] wallet ${address} already registered`);
    }

    res.status(201).json({ address, walletId: wallet.id });
  } catch (err: any) {
    console.error(`[circle-wallets] finalize failed: ${err.message}`);
    res.status(502).json({ error: `Failed to finalize wallet: ${err.message}` });
  }
});

/**
 * Real gap this closes: a freshly-created Circle wallet has zero balance —
 * confirmed for real during organizer create-campaign testing, where a
 * brand-new organizer wallet correctly rejected its first createCampaign
 * attempt with "the asset amount owned by the wallet is insufficient for
 * the transaction." Circle's SDK has a real testnet faucet method
 * (`client.requestTestnetTokens`, confirmed against the installed
 * package's own .d.ts, not guessed) that supports ARC-TESTNET as a named
 * blockchain and can request native tokens specifically — exactly what's
 * needed here, since USDC is Arc's native gas currency, not a separate
 * token to request. No userToken needed — this is an API-key-level call,
 * not a per-user challenge.
 */
circleWalletsRouter.post("/circle-wallets/faucet", async (req: Request, res: Response) => {
  const { address } = req.body ?? {};
  console.log(`[circle-wallets] POST /circle-wallets/faucet address=${address}`);
  if (typeof address !== "string") {
    return res.status(400).json({ error: "address (string) is required" });
  }
  try {
    const client = getCircleClient();
    await client.requestTestnetTokens({ address, blockchain: "ARC-TESTNET", native: true });
    console.log(`[circle-wallets] requested testnet tokens for ${address}`);
    res.status(202).json({ requested: true });
  } catch (err: any) {
    console.error(`[circle-wallets] faucet request failed: ${err.message}`);
    res.status(502).json({ error: `Failed to request testnet tokens: ${err.message}` });
  }
});
