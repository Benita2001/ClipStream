/**
 * Client-side orchestration for Circle User-Controlled Wallets signup.
 * Talks to the server/circleWallets.ts endpoints and the
 * @circle-fin/w3s-pw-web-sdk Web SDK (confirmed real method names/shapes
 * against the installed package's own type definitions, not guessed).
 *
 * Shared by both roles: the wallet-creation flow itself (createUser ->
 * session -> PIN challenge -> finalize) is identical for clippers and
 * organizers — only the owner_type tag and the per-role localStorage key
 * differ, both threaded through as a parameter rather than duplicating
 * this file. lib/circleTransactions.ts (organizer contract-signing) reuses
 * postJson/API_BASE/CIRCLE_APP_ID/getAuthenticatedSdk from here rather than
 * redefining them.
 */
import { W3SSdk } from "@circle-fin/w3s-pw-web-sdk";

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3000";
export const CIRCLE_APP_ID = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;

export type CircleWalletOwnerType = "clipper" | "organizer";

const STORAGE_KEYS: Record<CircleWalletOwnerType, string> = {
  clipper: "clipstream_circle_wallet",
  organizer: "clipstream_circle_wallet_organizer",
};

export interface CircleWalletSession {
  userId: string;
  address: string;
}

/**
 * Our app's only memory of "which Circle wallet does this browser belong
 * to" — real limitation, not glossed over: clearing browser storage loses
 * our UI's ability to find the wallet again (Circle's own account isn't
 * lost, but this app has no other way to look it up without a real
 * wallet-connect/login step, which doesn't exist yet). Scoped by
 * ownerType so a clipper session and an organizer session in the same
 * browser never collide — a real person could plausibly hold both roles.
 */
export function loadStoredWallet(ownerType: CircleWalletOwnerType = "clipper"): CircleWalletSession | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(STORAGE_KEYS[ownerType]);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CircleWalletSession;
  } catch {
    return null;
  }
}

function storeWallet(session: CircleWalletSession, ownerType: CircleWalletOwnerType) {
  window.localStorage.setItem(STORAGE_KEYS[ownerType], JSON.stringify(session));
}

export function clearStoredWallet(ownerType: CircleWalletOwnerType = "clipper") {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEYS[ownerType]);
}

/**
 * Restores a session found via the /auth/x/recover flow (see
 * server/oauth.ts's mode=recover branch — a reverse x_user_id -> wallet
 * lookup, not a new wallet or user). Confirms the recovered userId is
 * genuinely still valid by actually minting a session with it via the
 * existing /circle-wallets/session endpoint (the same createUserToken call
 * the app already uses to resume a session at every normal page load, per
 * its own doc comment) before persisting anything — a wallet id round-
 * tripped through a redirect's query string is worth confirming still
 * works, not just trusting blindly.
 */
export async function resumeRecoveredWallet(
  address: string,
  userId: string,
  ownerType: CircleWalletOwnerType = "clipper"
): Promise<CircleWalletSession> {
  await postJson<{ userToken: string; encryptionKey: string }>("/circle-wallets/session", { userId });
  const session: CircleWalletSession = { userId, address };
  storeWallet(session, ownerType);
  return session;
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Request to ${path} failed (${res.status})`);
  }
  return data;
}

/** Same SDK-instantiation pattern needed by any Circle challenge flow (wallet creation or, now, contract-execution signing) — extracted so circleTransactions.ts doesn't redefine it. */
export async function getAuthenticatedSdk(userToken: string, encryptionKey: string): Promise<W3SSdk> {
  if (!CIRCLE_APP_ID) {
    throw new Error("NEXT_PUBLIC_CIRCLE_APP_ID is not set");
  }
  const sdk = new W3SSdk({ appSettings: { appId: CIRCLE_APP_ID } });
  await sdk.getDeviceId();
  sdk.setAuthentication({ userToken, encryptionKey });
  return sdk;
}

/**
 * Full first-time signup flow: create a Circle user, issue a session token,
 * start the PIN+wallet challenge, hand off to Circle's hosted PIN UI via
 * the Web SDK, then register the resulting real Arc Testnet address in our
 * own tables (tagged owner_type). Resolves once the user completes the PIN
 * challenge.
 */
export function createCircleWallet(
  onStatus: (status: string) => void,
  ownerType: CircleWalletOwnerType = "clipper"
): Promise<CircleWalletSession> {
  if (!CIRCLE_APP_ID) {
    return Promise.reject(new Error("NEXT_PUBLIC_CIRCLE_APP_ID is not set"));
  }

  return new Promise((resolve, reject) => {
    (async () => {
      try {
        onStatus("Creating your account…");
        const { userId } = await postJson<{ userId: string }>("/circle-wallets/users", {});

        onStatus("Starting a secure session…");
        const { userToken, encryptionKey } = await postJson<{ userToken: string; encryptionKey: string }>(
          "/circle-wallets/session",
          { userId }
        );

        onStatus("Preparing your wallet…");
        const { challengeId } = await postJson<{ challengeId: string }>("/circle-wallets/init-wallet", {
          userToken,
        });

        const sdk = await getAuthenticatedSdk(userToken, encryptionKey);

        onStatus("Set a PIN to finish creating your wallet…");
        sdk.execute(challengeId, (error) => {
          (async () => {
            if (error) {
              reject(new Error(error.message || "Wallet creation was not completed"));
              return;
            }
            try {
              onStatus("Finalizing your wallet — this can take a few seconds…");
              const { address } = await postJson<{ address: string }>("/circle-wallets/finalize", {
                userToken,
                userId,
                challengeId,
                owner_type: ownerType,
              });
              const session: CircleWalletSession = { userId, address };
              storeWallet(session, ownerType);
              resolve(session);
            } catch (err) {
              reject(err instanceof Error ? err : new Error("Failed to finalize wallet"));
            }
          })();
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error("Wallet creation failed"));
      }
    })();
  });
}
