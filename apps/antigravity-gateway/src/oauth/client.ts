import { fetchWithProxy } from "../net/proxy.js";
import {
  AUTH_ENDPOINT,
  CALLBACK_PATH,
  CALLBACK_PORT,
  OAUTH_REFRESH_USER_AGENT,
  REQUEST_UA,
  SCOPES,
  TOKEN_ENDPOINT,
  USERINFO_ENDPOINT
} from "./constants.js";
import { resolveGoogleOAuthClientConfig } from "./clientConfig.js";

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

// Indirection over the proxy-aware fetch so tests can inject a fake
// transport. Production code routes through the environment proxy.
let httpFetch: typeof fetch = fetchWithProxy;

/** Test hook: replace the fetch implementation used by OAuth/onboard calls. */
export function setHttpFetch(f: typeof fetch): void {
  httpFetch = f;
}

/** Test hook: restore the proxy-aware fetch implementation. */
export function resetHttpFetch(): void {
  httpFetch = fetchWithProxy;
}

export function getHttpFetch(): typeof fetch {
  return httpFetch;
}

export function defaultRedirectURI(): string {
  return `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
}

/** Build the Google OAuth authorization URL (no PKCE, state-protected). */
export function buildAuthURL(state: string, redirectURI: string): string {
  const { clientId } = resolveGoogleOAuthClientConfig();
  const params = new URLSearchParams({
    access_type: "offline",
    client_id: clientId,
    prompt: "consent",
    redirect_uri: redirectURI,
    response_type: "code",
    scope: SCOPES.join(" "),
    state
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

async function postTokenForm(fields: Record<string, string>, userAgent?: string): Promise<TokenResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded"
  };
  if (userAgent !== undefined) {
    headers["User-Agent"] = userAgent;
  }
  const res = await getHttpFetch()(TOKEN_ENDPOINT, {
    method: "POST",
    headers,
    body: new URLSearchParams(fields).toString()
  });
  const text = await res.text();
  if (!res.ok) {
    const detail = text.trim();
    throw new Error(
      `antigravity token exchange: request failed: status ${res.status}${detail ? `: ${detail}` : ""}`
    );
  }
  return JSON.parse(text) as TokenResponse;
}

/** Exchange an authorization code for access/refresh tokens. */
export function exchangeCode(code: string, redirectURI: string): Promise<TokenResponse> {
  const { clientId, clientSecret } = resolveGoogleOAuthClientConfig();
  return postTokenForm({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectURI,
    grant_type: "authorization_code"
  });
}

/** Refresh an access token. The refresh token may rotate in the response. */
export function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const { clientId, clientSecret } = resolveGoogleOAuthClientConfig();
  return postTokenForm(
    {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    },
    OAUTH_REFRESH_USER_AGENT
  );
}

/** Fetch the authenticated user's email from Google userinfo. */
export async function fetchUserInfo(accessToken: string): Promise<string> {
  const token = accessToken.trim();
  if (token === "") {
    throw new Error("antigravity userinfo: missing access token");
  }
  const res = await getHttpFetch()(USERINFO_ENDPOINT, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": REQUEST_UA
    }
  });
  const text = await res.text();
  if (!res.ok) {
    const detail = text.trim();
    throw new Error(
      `antigravity userinfo: request failed: status ${res.status}${detail ? `: ${detail}` : ""}`
    );
  }
  const info = JSON.parse(text) as { email?: unknown };
  return typeof info.email === "string" ? info.email : "";
}
