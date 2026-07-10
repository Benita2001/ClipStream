import express from "express";
import cors from "cors";
import { oauthRouter } from "./oauth";
import { clipsRouter } from "./clips";
import { campaignsRouter } from "./campaigns";
import { clippersRouter } from "./clippers";
import { walletsRouter } from "./wallets";
import { circleWalletsRouter } from "./circleWallets";
import { circleTransactionsRouter } from "./circleTransactions";

// Restricted to a real allowlist, not wide open — revisited at Railway
// deploy time. Honest framing of *why*, since the real security benefit is
// more modest than "restricting CORS" usually implies: every write
// endpoint here (POST /clips, /campaigns, /circle-wallets/*) is already
// authorized by something the caller must independently possess (a
// wallet's own Circle userToken, a tweet URL under that wallet's linked X
// account) rather than an ambient browser credential like a cookie — so
// CORS was never actually the thing standing between an attacker and a
// forged write; a non-browser client (curl, a server) was never subject to
// CORS in the first place. What restricting the allowlist *does* buy: it
// stops a malicious third-party website from silently proxying a victim's
// browser into probing/calling this API, and it's essentially free now
// that the real Vercel URL is known — a hygiene/defense-in-depth
// improvement, not a plug for an open hole that credentialed writes
// depended on.
const ALLOWED_ORIGINS = [
  "https://clipstream-0xbeni123-1419s-projects.vercel.app",
  // Vercel auto-generates multiple production aliases for the same project
  // (the project-name-only short form, and a project+org form with a repeated
  // slug) — all three point at the same deployment and are all real,
  // reachable URLs a visitor might land on, not just the one originally
  // hand-added above. Found via `vercel inspect` after a user report that
  // clipstream-ten.vercel.app was CORS-blocked.
  "https://clipstream-ten.vercel.app",
  "https://clipstream-0xbeni123-1419-0xbeni123-1419s-projects.vercel.app",
  "http://localhost:3001", // web/ Next.js dev server
  "http://localhost:3000", // in case the backend itself is proxied/tested from here
];

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Vercel preview deployments get their own per-branch/per-PR subdomains
  // (e.g. clipstream-git-feature-x-0xbeni123-1419s-projects.vercel.app) —
  // matched by pattern so preview URLs keep working without hand-adding
  // each one, while still requiring the recognizable project/team slug.
  return /^https:\/\/clipstream-[a-z0-9-]*0xbeni123-1419s-projects\.vercel\.app$/.test(origin);
}

export function createApp() {
  const app = express();
  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header at all (curl, server-to-server, same-origin) —
        // never subject to CORS enforcement anyway; let it through.
        // Disallowed origins get `false`, not a thrown Error — found for
        // real during local testing: passing an Error here makes Express's
        // default error handler return a bare 500 with a full server
        // stack trace (including local filesystem paths) to anyone who
        // sends a mismatched Origin header. `false` just omits the
        // Access-Control-Allow-Origin header, which is the actual correct
        // CORS rejection — the browser blocks the response client-side,
        // the server itself responds normally with no leaked internals.
        callback(null, !origin || isAllowedOrigin(origin));
      },
    })
  );
  app.use(express.json());
  app.use(oauthRouter);
  app.use(clipsRouter);
  app.use(campaignsRouter);
  app.use(clippersRouter);
  app.use(walletsRouter);
  app.use(circleWalletsRouter);
  app.use(circleTransactionsRouter);
  return app;
}
