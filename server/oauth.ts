import { Router, Request, Response } from "express";
import { generateCodeVerifier, generateCodeChallenge, generateState } from "./pkce";
import { X_OAUTH_AUTHORIZE_URL, loadXOAuthConfig, exchangeCodeForToken, getAuthenticatedUser } from "./xApi";
import { upsertXAccount, getWalletByAddress, getXAccountByXUserId, getCircleUserByWallet } from "../db/db";

/** Minimal scopes only — no posting permission is ever requested. */
const OAUTH_SCOPES = ["users.read", "tweet.read"];

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete the X consent screen

/**
 * Where to send the browser back to after a *recovery* attempt (mode:
 * "recover" below) — unlike the "link" flow, recovery needs to hand real
 * data (the recovered wallet address + Circle userId) back to the frontend
 * so it can restore localStorage, which a bare JSON response can't do for a
 * full-page X-consent-screen redirect. Defaults to the local web/ dev
 * server port; set for real in production alongside the other deploy env
 * vars (see CLAUDE.md's Railway checklist).
 */
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || "http://localhost:3001";

interface PendingOAuthState {
  codeVerifier: string;
  /** null in recovery mode — there's no wallet to link to yet, that's the whole point. */
  walletAddress: string | null;
  mode: "link" | "recover";
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
 * Kicks off the "Sign in with X" flow — in one of two modes:
 *  - mode=link (default, the original flow): the clipper must already be
 *    wallet-connected in the app; we thread wallet_address through `state`
 *    so the callback knows which wallet to link.
 *  - mode=recover: no wallet_address at all — this *is* the flow for a
 *    visitor whose browser doesn't know their wallet anymore. The callback
 *    instead looks up which wallet (if any) is already linked to whichever
 *    X account they authenticate as.
 */
oauthRouter.get("/auth/x/start", (req: Request, res: Response) => {
  const mode = req.query.mode === "recover" ? "recover" : "link";
  const walletAddressParam = req.query.wallet_address;

  let walletAddress: string | null = null;
  if (mode === "link") {
    if (typeof walletAddressParam !== "string" || walletAddressParam.length === 0) {
      return res.status(400).json({ error: "wallet_address query parameter is required" });
    }
    if (!getWalletByAddress(walletAddressParam)) {
      return res
        .status(400)
        .json({ error: `No wallet registered for address ${walletAddressParam} — register the wallet before linking X` });
    }
    walletAddress = walletAddressParam;
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

  pendingStates.set(state, { codeVerifier, walletAddress, mode, createdAt: Date.now() });

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
 * then either links that x_user_id/x_handle to the pending wallet (mode:
 * "link") or, for mode: "recover", looks up which wallet (if any) is
 * already linked to this X account — both modes redirect back into the
 * frontend with the result in the query string (not a bare JSON response),
 * since a full-page X-consent-screen redirect needs to hand real data back
 * to a page that can act on it (show a banner, restore localStorage),
 * which a bare JSON response can't do. mode: "link" previously returned
 * JSON directly here — a real, confusing gap for a normal user linking X
 * for the first time (they'd land on a raw JSON page instead of back in
 * the app) — fixed to redirect exactly like mode: "recover" already did,
 * using linked_handle/linked_user_id (success) or link_error (failure)
 * instead of recovered_wallet/recovered_user_id or recovery_error.
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

  // Shared by both modes — each just passes different query param names
  // (linked_handle/linked_user_id/link_error for "link",
  // recovered_wallet/recovered_user_id/recovery_error for "recover").
  const profileRedirect = (params: Record<string, string>) => {
    const url = new URL(`${FRONTEND_BASE_URL}/clipper/profile`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    res.redirect(url.toString());
  };

  try {
    const config = loadXOAuthConfig();
    const token = await exchangeCodeForToken(config, code, pending.codeVerifier);
    const xUser = await getAuthenticatedUser(token.access_token);

    if (pending.mode === "recover") {
      const existing = getXAccountByXUserId(xUser.id);
      if (!existing) {
        return profileRedirect({
          recovery_error: `No wallet is linked to @${xUser.username} yet — create a new wallet instead.`,
        });
      }
      const circleUser = getCircleUserByWallet(existing.wallet_address);
      if (!circleUser) {
        // Real gap, not hypothetical: an x_accounts row can exist without a
        // circle_users row if the wallet was ever registered by some other
        // path than the Circle Wallets signup flow (e.g. a dev-seeded
        // wallet) — nothing to "resume" in that case since there's no
        // Circle-managed session to mint.
        return profileRedirect({
          recovery_error: `Wallet ${existing.wallet_address} is linked to @${xUser.username} but isn't a Circle-managed wallet — nothing to recover.`,
        });
      }
      return profileRedirect({
        recovered_wallet: existing.wallet_address,
        recovered_user_id: circleUser.circle_user_id,
      });
    }

    const account = upsertXAccount({
      wallet_address: pending.walletAddress!,
      x_user_id: xUser.id,
      x_handle: xUser.username,
    });

    return profileRedirect({
      linked_handle: account.x_handle,
      linked_user_id: account.x_user_id,
    });
  } catch (err: any) {
    if (pending.mode === "recover") {
      return profileRedirect({ recovery_error: `Recovery failed: ${err.message}` });
    }
    return profileRedirect({ link_error: `X account linking failed: ${err.message}` });
  }
});
