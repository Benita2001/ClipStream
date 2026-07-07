import * as crypto from "crypto";

/**
 * PKCE (RFC 7636) helpers for the X OAuth 2.0 Authorization Code flow.
 * X requires PKCE for every client, confidential or not — we generate a
 * verifier/challenge pair here regardless, and separately authenticate the
 * token exchange itself with the client_secret (see server/xApi.ts), since
 * this app can hold a secret.
 */

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateCodeVerifier(): string {
  return base64url(crypto.randomBytes(32));
}

export function generateCodeChallenge(codeVerifier: string): string {
  const hash = crypto.createHash("sha256").update(codeVerifier).digest();
  return base64url(hash);
}

export function generateState(): string {
  return base64url(crypto.randomBytes(16));
}
