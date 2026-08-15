export const API_ROUTES = Object.freeze({
  listArticles: "GET /api/articles",
  getArticle: "GET /api/articles/:slug",
  listArchives: "GET /api/archives",
  listTags: "GET /api/tags",
  listSeries: "GET /api/series",
  listArtworks: "GET /api/artworks",
  getArtwork: "GET /api/artworks/:slug",
  listComments: "GET /api/articles/:id/comments",
  createComment: "POST /api/articles/:id/comments",
  getStatus: "GET /api/status",
  githubStart: "GET /api/auth/github/start",
  githubCallback: "GET /api/auth/github/callback"
});

interface EnvironmentVariableDoc {
  requiredFor: string;
  localFallback: string;
}

export const ENVIRONMENT_VARIABLES: Readonly<Record<string, EnvironmentVariableDoc>> = Object.freeze({
  GITHUB_CLIENT_ID: {
    requiredFor: "GitHub OAuth authorization start",
    localFallback: "none; unauthenticated writes are rejected"
  },
  GITHUB_CLIENT_SECRET: {
    requiredFor: "GitHub OAuth callback token exchange",
    localFallback: "none; callback returns configuration error"
  },
  SESSION_SECRET: {
    requiredFor: "signed session cookies or JWTs",
    localFallback: "none; authenticated writes are unavailable"
  },
  ALLOWED_ORIGINS: {
    requiredFor: "credentialed requests from the local author/status apps",
    localFallback: "same-origin requests only"
  },
  ALLOWED_REDIRECT_ORIGINS: {
    requiredFor: "OAuth callback redirects to approved private apps",
    localFallback: "same-origin callback only"
  },
  BLOG_STORAGE_NAMESPACE: {
    requiredFor: "Cloudflare D1/KV/R2 binding naming",
    localFallback: "browser localStorage namespace"
  },
  BLOG_DB: {
    requiredFor: "Cloudflare D1 durable blog state",
    localFallback: "file-backed development state"
  },
  OAUTH_STATE_KV: {
    requiredFor: "durable OAuth state with expiry",
    localFallback: "in-memory development state"
  },
  ARTWORK_BUCKET: {
    requiredFor: "private originals and public display derivatives",
    localFallback: "publicSrc seed assets or an author-provided URL"
  }
});

interface OAuthStartOptions {
  baseUrl?: string;
  redirectPath?: string;
}

export function getGitHubOAuthStartUrl({ baseUrl = "", redirectPath = "/" }: OAuthStartOptions = {}): string {
  const normalizedBase = String(baseUrl).replace(/\/$/, "");
  const redirect = encodeURIComponent(redirectPath || "/");
  return `${normalizedBase}/api/auth/github/start?redirect=${redirect}`;
}

export interface AuthContract {
  provider: string;
  startRoute: string;
  callbackRoute: string;
  requiredScopes: string[];
  commentRequirement: string;
}

export function getAuthContract(): AuthContract {
  return {
    provider: "github",
    startRoute: "GET /api/auth/github/start?redirect=/",
    callbackRoute: "GET /api/auth/github/callback?code=...&state=...",
    requiredScopes: ["read:user"],
    commentRequirement: "Comments require a GitHub-backed signed HTTP-only session."
  };
}

interface JsonResponseInit {
  status?: number;
  headers?: HeadersInit;
}

export function jsonResponse(body: unknown, init: JsonResponseInit = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status: init.status || 200,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "HEAD") {
    return {};
  }
  const text = await request.text();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}
