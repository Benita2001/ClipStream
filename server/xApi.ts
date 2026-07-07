/**
 * Thin client over the two X API v2 surfaces ClipStream uses:
 *  - OAuth 2.0 Authorization Code + PKCE (confidential client) for the
 *    one-time account-linking flow.
 *  - App-only Bearer auth for reading public tweet data (impression counts,
 *    author id) — no user auth needed for this, it's public data.
 * Both talk to api.x.com (formerly api.twitter.com); either hostname works,
 * X.com is current.
 */

const X_API_BASE = "https://api.x.com";
const X_OAUTH_TOKEN_URL = `${X_API_BASE}/2/oauth2/token`;
export const X_OAUTH_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";

export interface XOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function loadXOAuthConfig(): XOAuthConfig {
  const clientId = process.env.X_OAUTH_CLIENT_ID;
  const clientSecret = process.env.X_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.X_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Missing X OAuth config — set X_OAUTH_CLIENT_ID, X_OAUTH_CLIENT_SECRET, and X_OAUTH_REDIRECT_URI in .env"
    );
  }
  return { clientId, clientSecret, redirectUri };
}

export function loadXBearerToken(): string {
  const token = process.env.X_OAUTH_BEARER_TOKEN;
  if (!token) {
    throw new Error("Missing X_OAUTH_BEARER_TOKEN in .env — required for app-only reads of public tweet data");
  }
  return token;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in?: number;
}

/**
 * Exchanges an authorization code for an access token. This app is a
 * confidential client: the client_secret authenticates the token request via
 * HTTP Basic auth, in addition to (not instead of) the PKCE code_verifier X
 * requires from every client regardless of type.
 */
export async function exchangeCodeForToken(
  config: XOAuthConfig,
  code: string,
  codeVerifier: string
): Promise<TokenResponse> {
  const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
  });

  const response = await fetch(X_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`X token exchange failed (${response.status}): ${text}`);
  }

  return (await response.json()) as TokenResponse;
}

export interface XUser {
  id: string;
  username: string;
}

/** GET /2/users/me with the clipper's own access token (users.read scope). */
export async function getAuthenticatedUser(accessToken: string): Promise<XUser> {
  const response = await fetch(`${X_API_BASE}/2/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`X /2/users/me failed (${response.status}): ${text}`);
  }

  const json = (await response.json()) as { data: XUser };
  return json.data;
}

export interface TweetAuthorInfo {
  tweetId: string;
  authorId: string;
}

/**
 * GET /2/tweets/:id with expansions=author_id, using the app-only Bearer
 * token — public data, no clipper auth involved. Used for the ownership
 * check at clip submission.
 */
export async function getTweetAuthor(tweetId: string): Promise<TweetAuthorInfo> {
  const bearerToken = loadXBearerToken();
  const url = `${X_API_BASE}/2/tweets/${tweetId}?expansions=author_id`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`X /2/tweets/${tweetId} (author lookup) failed (${response.status}): ${text}`);
  }

  const json = (await response.json()) as { data: { id: string; author_id: string } };
  return { tweetId: json.data.id, authorId: json.data.author_id };
}

export interface TweetMetrics {
  tweetId: string;
  impressionCount: number;
}

/**
 * GET /2/tweets/:id with tweet.fields=public_metrics, using the app-only
 * Bearer token — this is what the View Poller calls on every cycle.
 */
export async function getTweetImpressionCount(tweetId: string): Promise<TweetMetrics> {
  const bearerToken = loadXBearerToken();
  const url = `${X_API_BASE}/2/tweets/${tweetId}?tweet.fields=public_metrics`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`X /2/tweets/${tweetId} (metrics) failed (${response.status}): ${text}`);
  }

  const json = (await response.json()) as {
    data: { id: string; public_metrics: { impression_count: number } };
  };
  return { tweetId: json.data.id, impressionCount: json.data.public_metrics.impression_count };
}
