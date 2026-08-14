export function getGitHubOAuthStartUrl({ baseUrl = "", redirectPath = "/" } = {}) {
  const normalizedBase = String(baseUrl).replace(/\/$/, "");
  const redirect = encodeURIComponent(redirectPath || "/");
  return `${normalizedBase}/api/auth/github/start?redirect=${redirect}`;
}

export function getAuthContract() {
  return {
    provider: "github",
    startRoute: "GET /api/auth/github/start?redirect=/",
    callbackRoute: "GET /api/auth/github/callback?code=...&state=...",
    sessionRoute: "GET /api/session",
    logoutRoute: "POST /api/logout",
    requiredScopes: ["read:user"],
    commentRequirement: "Comments require a GitHub-backed signed HTTP-only session.",
    authorRequirement: "Article and status writes require an authenticated GitHub login in AUTHOR_GITHUB_LOGINS."
  };
}
