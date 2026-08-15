import {
  createSessionCookieHeader,
  createSignedSessionCookie
} from "../src/services/sessionCookie";

const OAUTH_STATE_TTL_SECONDS = 600;

// Worker 环境变量（本地为 process.env 子集，线上为 Cloudflare 绑定）。
// 仅声明本模块消费的键，其余键以索引签名放行。
export interface OAuthEnv {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  ALLOWED_REDIRECT_ORIGINS?: string;
  OAUTH_STATE_KV?: unknown;
  [key: string]: unknown;
}

// OAuth state 存储：Cloudflare KV（put/get/delete）或本地 Map（get/set/delete）。
interface OAuthStateStore {
  get(key: string): unknown;
  delete(key: string): unknown;
  set?(key: string, value: unknown): unknown;
  put?(key: string, value: string, options: { expirationTtl: number }): unknown;
}

interface StateRecord {
  redirect: string;
  createdAt: string;
}

interface CreateGitHubOAuthOptions {
  env?: OAuthEnv;
  fetchImpl?: typeof fetch;
  stateStore?: OAuthStateStore;
  now?: () => string;
}

export function createGitHubOAuth({
  env = {},
  fetchImpl = globalThis.fetch,
  stateStore = (env.OAUTH_STATE_KV as OAuthStateStore | undefined) || new Map<string, StateRecord>(),
  now = () => new Date().toISOString()
}: CreateGitHubOAuthOptions = {}) {
  return {
    async start(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (!env.GITHUB_CLIENT_ID) {
        return configurationError("GITHUB_CLIENT_ID is not configured.");
      }

      const state = crypto.randomUUID();
      const redirect = safeRedirect(url.searchParams.get("redirect"), url.origin, env);
      await putState(stateStore, state, { redirect, createdAt: now() });
      const callback = `${url.origin}/api/auth/github/callback`;
      const githubUrl = new URL("https://github.com/login/oauth/authorize");
      githubUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      githubUrl.searchParams.set("redirect_uri", callback);
      githubUrl.searchParams.set("scope", "read:user");
      githubUrl.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { Location: githubUrl.toString() } });
    },

    async callback(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!state || !code) return configurationError("GitHub OAuth callback requires code and state.", 400);
      const record = await consumeState(stateStore, state);
      if (!record || !isFreshState(record.createdAt, now())) return configurationError("GitHub OAuth state is missing or expired.", 400);
      if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.SESSION_SECRET) {
        return configurationError("GitHub OAuth secrets are not configured.");
      }

      const callbackUrl = `${url.origin}/api/auth/github/callback`;
      const tokenResponse = await fetchImpl("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: callbackUrl
        })
      });
      const token = await tokenResponse.json() as { access_token?: string; error_description?: string };
      if (!tokenResponse.ok || !token.access_token) {
        return configurationError(token.error_description || "GitHub token exchange failed.", 502);
      }

      const userResponse = await fetchImpl("https://api.github.com/user", {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token.access_token}`,
          "User-Agent": "eva-blog"
        }
      });
      const user = await userResponse.json() as { id?: number | string; login?: string; name?: string; avatar_url?: string };
      if (!userResponse.ok || !user.id || !user.login) {
        return configurationError("GitHub user lookup failed.", 502);
      }

      const session = {
        provider: "github",
        id: String(user.id),
        login: String(user.login),
        name: user.name || user.login,
        avatarUrl: user.avatar_url || "",
        issuedAt: now()
      };
      const cookie = await createSignedSessionCookie(session, env.SESSION_SECRET);
      return new Response(null, {
        status: 302,
        headers: {
          Location: record.redirect,
          "Set-Cookie": createSessionCookieHeader(cookie, {
            secure: url.protocol === "https:"
          })
        }
      });
    }
  };
}

function safeRedirect(value: string | null, origin: string, env: OAuthEnv): string {
  const fallback = `${origin}/`;
  if (!value) return fallback;
  try {
    const candidate = new URL(value, origin);
    if (candidate.origin === origin) return candidate.toString();
    const allowed = String(env.ALLOWED_REDIRECT_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean);
    return allowed.includes(candidate.origin) ? candidate.toString() : fallback;
  } catch {
    return fallback;
  }
}

async function putState(store: OAuthStateStore, key: string, value: StateRecord): Promise<void> {
  if (store.put) {
    await store.put(key, JSON.stringify(value), { expirationTtl: OAUTH_STATE_TTL_SECONDS });
    return;
  }
  store.set?.(key, value);
}

async function consumeState(store: OAuthStateStore, key: string): Promise<StateRecord | null> {
  const value = await store.get(key);
  await store.delete(key);
  if (!value) return null;
  return typeof value === "string" ? (JSON.parse(value) as StateRecord) : (value as StateRecord);
}

function configurationError(message: string, status: number = 503): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function isFreshState(createdAt: string | undefined, currentTime: string): boolean {
  const created = Date.parse(createdAt || "");
  const current = Date.parse(currentTime || "");
  return Number.isFinite(created) && Number.isFinite(current) && current >= created && current - created <= OAUTH_STATE_TTL_SECONDS * 1000;
}
