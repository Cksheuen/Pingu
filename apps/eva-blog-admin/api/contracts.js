export const API_ROUTES = Object.freeze({
  listArticles: "GET /api/articles",
  getArticle: "GET /api/articles/:slug",
  saveArticle: "POST /api/articles",
  publishArticle: "POST /api/articles/:id/publish",
  listComments: "GET /api/articles/:id/comments",
  createComment: "POST /api/articles/:id/comments",
  getStatus: "GET /api/status",
  updateStatus: "POST /api/status",
  updateAutoStatus: "POST /api/status/auto",
  issueDaemonToken: "POST /api/status/daemon-token",
  summarizeActivity: "POST /api/summaries/activity",
  githubStart: "GET /api/auth/github/start",
  githubCallback: "GET /api/auth/github/callback",
  session: "GET /api/session",
  logout: "POST /api/logout"
});

export const ENVIRONMENT_VARIABLES = Object.freeze({
  GITHUB_CLIENT_ID: {
    requiredFor: "GitHub OAuth authorization start",
    localFallback: "none; private writes remain unavailable"
  },
  GITHUB_CLIENT_SECRET: {
    requiredFor: "production GitHub OAuth callback token exchange",
    localFallback: "none; callback returns configuration error"
  },
  SESSION_SECRET: {
    requiredFor: "signed session cookies or JWTs",
    localFallback: "none; write routes reject anonymous requests"
  },
  AUTHOR_GITHUB_LOGINS: {
    requiredFor: "author allowlist for article/status writes",
    localFallback: "empty; all author writes reject"
  },
  ALLOWED_ORIGINS: {
    requiredFor: "credentialed requests from the local status app",
    localFallback: "same-origin requests only"
  },
  ALLOWED_REDIRECT_ORIGINS: {
    requiredFor: "OAuth callback redirects to approved private apps",
    localFallback: "same-origin callback only"
  },
  AI_PROVIDER: {
    requiredFor: "hosted AI article/activity summaries",
    localFallback: "deterministic-fallback"
  },
  AI_API_KEY: {
    requiredFor: "hosted AI provider calls",
    localFallback: "deterministic-fallback"
  },
  BLOG_STORAGE_NAMESPACE: {
    requiredFor: "Cloudflare D1/KV/R2 binding naming",
    localFallback: "browser localStorage namespace"
  }
});

export function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status: init.status || 200,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });
}

export async function readJson(request) {
  if (request.method === "GET" || request.method === "HEAD") {
    return {};
  }
  const text = await request.text();
  return text ? JSON.parse(text) : {};
}
