import { Router, Request, Response } from "express";
import { generateCodeVerifier, generateCodeChallenge, generateState } from "./pkce";
import { X_OAUTH_AUTHORIZE_URL, loadXOAuthConfig, exchangeCodeForToken, getAuthenticatedUser } from "./xApi";
import { upsertXAccount, getWalletByAddress } from "../db/db";

/** Minimal scopes only — no posting permission is ever requested. */
const OAUTH_SCOPES = ["users.read", "tweet.read"];

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete the X consent screen

interface PendingOAuthState {
  codeVerifier: string;
  walletAddress: string;
  createdAt: number;
}

/**
 * In-memory store of in-flight OAuth attempts, keyed by the `state` param.
 * Fine for a single-process hackathon deployment; a multi-instance deployment
 * would need this in a shared store (e.g. the SQLite DB itself) instead.
 */
const pendingStates = new Map<string, PendingOAuthState>();

function sweepExpiredStates(): void {
  const now = Date.now();
  for (const [state, entry] of pendingStates) {
    if (now - entry.createdAt > STATE_TTL_MS) {
      pendingStates.delete(state);
    }
  }
}

export const oauthRouter = Router();

/**
 * Kicks off the "Sign in with X" flow. The clipper must already be
 * wallet-connected in the app; we thread wallet_address through `state` (via
 * the pending-state map) so the callback knows which wallet to link.
 */
oauthRouter.get("/auth/x/start", (req: Request, res: Response) => {
  const walletAddress = req.query.wallet_address;
  if (typeof walletAddress !== "string" || walletAddress.length === 0) {
    return res.status(400).json({ error: "wallet_address query parameter is required" });
  }

  if (!getWalletByAddress(walletAddress)) {
    return res
      .status(400)
      .json({ error: `No wallet registered for address ${walletAddress} — register the wallet before linking X` });
  }

  let config;
  try {
    config = loadXOAuthConfig();
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }

  sweepExpiredStates();

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  pendingStates.set(state, { codeVerifier, walletAddress, createdAt: Date.now() });

  const authorizeUrl = new URL(X_OAUTH_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set("redirect_uri", config.redirectUri);
  authorizeUrl.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  res.redirect(authorizeUrl.toString());
});

/**
 * X's redirect target after the clipper approves (or denies) the consent
 * screen. Exchanges the code for a token, looks up the authenticated user,
 * and links (or re-links) that x_user_id/x_handle to the pending wallet.
 */
oauthRouter.get("/auth/x/callback", async (req: Request, res: Response) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    return res.status(400).json({ error: `X denied the request: ${oauthError}` });
  }
  if (typeof code !== "string" || typeof state !== "string") {
    return res.status(400).json({ error: "Missing code or state query parameter" });
  }

  const pending = pendingStates.get(state);
  if (!pending) {
    return res.status(400).json({ error: "Unknown or expired state — restart the linking flow at /auth/x/start" });
  }
  pendingStates.delete(state); // one-time use

  if (Date.now() - pending.createdAt > STATE_TTL_MS) {
    return res.status(400).json({ error: "This linking attempt expired — restart the flow at /auth/x/start" });
  }

  try {
    const config = loadXOAuthConfig();
    const token = await exchangeCodeForToken(config, code, pending.codeVerifier);
    const xUser = await getAuthenticatedUser(token.access_token);

    const account = upsertXAccount({
      wallet_address: pending.walletAddress,
      x_user_id: xUser.id,
      x_handle: xUser.username,
    });

    res.json({
      linked: true,
      wallet_address: account.wallet_address,
      x_handle: account.x_handle,
      x_user_id: account.x_user_id,
    });
  } catch (err: any) {
    res.status(502).json({ error: `X account linking failed: ${err.message}` });
  }
});
