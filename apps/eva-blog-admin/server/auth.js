import { createClearSessionCookieHeader, createSessionCookieHeader, createSignedSessionCookie } from "../src/services/sessionCookie.js";

const OAUTH_STATE_TTL_SECONDS = 600;

export function createGitHubOAuth({ env = {}, fetchImpl = globalThis.fetch, stateStore = env.OAUTH_STATE_KV || new Map(), now = () => new Date().toISOString() } = {}) {
  return {
    async start(request) {
      const url = new URL(request.url);
      if (!env.GITHUB_CLIENT_ID) return errorResponse("GITHUB_CLIENT_ID is not configured.");
      const state = crypto.randomUUID();
      await putState(stateStore, state, { redirect: safeRedirect(url.searchParams.get("redirect"), url.origin, env), createdAt: now() });
      const authorize = new URL("https://github.com/login/oauth/authorize");
      authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      authorize.searchParams.set("redirect_uri", `${url.origin}/api/auth/github/callback`);
      authorize.searchParams.set("scope", "read:user");
      authorize.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { Location: authorize.toString() } });
    },
    async callback(request) {
      const url = new URL(request.url);
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!state || !code) return errorResponse("GitHub OAuth callback requires code and state.", 400);
      const record = await consumeState(stateStore, state);
      if (!record || !isFreshState(record.createdAt, now())) return errorResponse("GitHub OAuth state is missing or expired.", 400);
      if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.SESSION_SECRET) return errorResponse("GitHub OAuth secrets are not configured.");
      const callbackUrl = `${url.origin}/api/auth/github/callback`;
      const tokenResponse = await fetchImpl("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: callbackUrl })
      });
      const token = await tokenResponse.json();
      if (!tokenResponse.ok || !token.access_token) return errorResponse(token.error_description || "GitHub token exchange failed.", 502);
      const userResponse = await fetchImpl("https://api.github.com/user", {
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token.access_token}`, "User-Agent": "eva-blog-author-console" }
      });
      const user = await userResponse.json();
      if (!userResponse.ok || !user.id || !user.login) return errorResponse("GitHub user lookup failed.", 502);
      const session = { provider: "github", id: String(user.id), login: String(user.login), name: user.name || user.login, avatarUrl: user.avatar_url || "", issuedAt: now() };
      const cookie = await createSignedSessionCookie(session, env.SESSION_SECRET);
      return new Response(null, { status: 302, headers: { Location: record.redirect, "Set-Cookie": createSessionCookieHeader(cookie, { secure: url.protocol === "https:" }) } });
    },
    logout(request) {
      const url = new URL(request.url);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json", "Set-Cookie": createClearSessionCookieHeader({ secure: url.protocol === "https:" }) } });
    }
  };
}

function safeRedirect(value, origin, env) {
  const fallback = `${origin}/`;
  if (!value) return fallback;
  try {
    const candidate = new URL(value, origin);
    if (candidate.origin === origin) return candidate.toString();
    const allowed = String(env.ALLOWED_REDIRECT_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean);
    return allowed.includes(candidate.origin) ? candidate.toString() : fallback;
  } catch { return fallback; }
}

async function putState(store, key, value) {
  if (typeof store.put === "function") return store.put(key, JSON.stringify(value), { expirationTtl: OAUTH_STATE_TTL_SECONDS });
  store.set(key, value);
}
async function consumeState(store, key) {
  if (typeof store.get === "function") {
    const value = await store.get(key);
    if (typeof store.delete === "function") await store.delete(key);
    return value ? (typeof value === "string" ? JSON.parse(value) : value) : null;
  }
  const value = store.get(key) || null;
  store.delete(key);
  return value;
}
function errorResponse(error, status = 503) {
  return new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } });
}

function isFreshState(createdAt, currentTime) {
  const created = Date.parse(createdAt || "");
  const current = Date.parse(currentTime || "");
  return Number.isFinite(created) && Number.isFinite(current) && current >= created && current - created <= OAUTH_STATE_TTL_SECONDS * 1000;
}
