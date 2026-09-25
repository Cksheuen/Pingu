import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_WINDOW_SECONDS = 5 * 60;

interface CodexTokenData {
  access_token?: string;
  refresh_token?: string;
  id_token?: unknown;
  account_id?: string;
  [key: string]: unknown;
}

interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: CodexTokenData;
  last_refresh?: string;
  [key: string]: unknown;
}

interface RefreshResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
}

export interface CodexAuthHeaders {
  accessToken: string;
  accountId: string;
}

export class CodexAuthManager {
  private readonly authFile: string;
  private readonly fetchImpl: typeof fetch;
  private refreshPromise?: Promise<CodexAuthFile>;

  constructor(authFile: string, fetchImpl: typeof fetch = globalThis.fetch) {
    this.authFile = resolve(authFile);
    this.fetchImpl = fetchImpl;
  }

  async getAuthHeaders(forceRefresh = false): Promise<CodexAuthHeaders> {
    let auth = this.readAuth();
    const accessToken = auth.tokens?.access_token;
    if (forceRefresh || !accessToken || tokenExpiresSoon(accessToken)) {
      auth = await this.refreshAuth();
    }

    const token = auth.tokens?.access_token;
    const accountId = auth.tokens?.account_id ?? accountIdFromToken(auth.tokens?.id_token) ?? accountIdFromToken(token);
    if (!token) {
      throw new Error(`Codex OAuth access token is missing in ${this.authFile}; run "codex login"`);
    }
    if (!accountId) {
      throw new Error(`Codex ChatGPT account id is missing in ${this.authFile}; run "codex login" again`);
    }
    return { accessToken: token, accountId };
  }

  async authenticatedFetch(input: string, init: RequestInit = {}): Promise<Response> {
    let auth = await this.getAuthHeaders();
    let response = await this.fetchWithAuth(input, init, auth);
    if (response.status !== 401) return response;

    auth = await this.getAuthHeaders(true);
    response = await this.fetchWithAuth(input, init, auth);
    return response;
  }

  private fetchWithAuth(input: string, init: RequestInit, auth: CodexAuthHeaders): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${auth.accessToken}`);
    headers.set("ChatGPT-Account-ID", auth.accountId);
    return this.fetchImpl(input, { ...init, headers });
  }

  private readAuth(): CodexAuthFile {
    let parsed: CodexAuthFile;
    try {
      parsed = JSON.parse(readFileSync(this.authFile, "utf8")) as CodexAuthFile;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to read Codex OAuth credentials from ${this.authFile}: ${message}`);
    }
    if (parsed.auth_mode !== "chatgpt") {
      throw new Error(`Codex auth mode must be "chatgpt" in ${this.authFile}; run "codex login" with ChatGPT`);
    }
    return parsed;
  }

  private refreshAuth(): Promise<CodexAuthFile> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.performRefresh().finally(() => {
        this.refreshPromise = undefined;
      });
    }
    return this.refreshPromise;
  }

  private async performRefresh(): Promise<CodexAuthFile> {
    const attempted = this.readAuth();
    const refreshToken = attempted.tokens?.refresh_token;
    if (!refreshToken) {
      throw new Error(`Codex OAuth refresh token is missing in ${this.authFile}; run "codex login" again`);
    }

    const response = await this.fetchImpl(REFRESH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken
      })
    });
    if (!response.ok) {
      const detail = await safeErrorMessage(response);
      throw new Error(`Codex OAuth refresh failed (${response.status}): ${detail}`);
    }

    const refreshed = (await response.json()) as RefreshResponse;
    if (!refreshed.access_token) {
      throw new Error("Codex OAuth refresh response did not include an access token");
    }

    // Another Codex process may have rotated the one-time refresh token while
    // this request was in flight. Never overwrite newer credentials.
    const current = this.readAuth();
    if (current.tokens?.refresh_token !== refreshToken) return current;

    const next: CodexAuthFile = {
      ...current,
      tokens: {
        ...current.tokens,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token ?? refreshToken,
        id_token: refreshed.id_token ?? current.tokens?.id_token
      },
      last_refresh: new Date().toISOString()
    };
    this.atomicWrite(next);
    return next;
  }

  private atomicWrite(auth: CodexAuthFile): void {
    const tempPath = resolve(dirname(this.authFile), `.auth.json.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tempPath, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tempPath, this.authFile);
  }
}

function tokenExpiresSoon(token: string): boolean {
  const claims = jwtClaims(token);
  if (typeof claims?.exp !== "number") return false;
  return claims.exp <= Math.floor(Date.now() / 1000) + REFRESH_WINDOW_SECONDS;
}

function accountIdFromToken(token: unknown): string | undefined {
  if (typeof token !== "string") return undefined;
  const claims = jwtClaims(token);
  if (!claims) return undefined;
  if (typeof claims.chatgpt_account_id === "string") return claims.chatgpt_account_id;
  const authClaim = claims["https://api.openai.com/auth"];
  if (authClaim && typeof authClaim === "object") {
    const accountId = (authClaim as Record<string, unknown>).chatgpt_account_id;
    if (typeof accountId === "string") return accountId;
  }
  return undefined;
}

function jwtClaims(token: string): Record<string, unknown> | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function safeErrorMessage(response: Response): Promise<string> {
  const text = (await response.text()).slice(0, 500);
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } };
    return parsed.error?.message ?? parsed.error?.code ?? "unknown OAuth error";
  } catch {
    return text || response.statusText || "unknown OAuth error";
  }
}
