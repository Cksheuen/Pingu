// OAuth endpoints and client metadata aligned with the Go reference
// implementation (CLIProxyAPI internal/auth/antigravity/constants.go and
// internal/misc/antigravity_version.go). Client credentials are loaded lazily
// from private configuration by clientConfig.ts.

export const CALLBACK_PORT = 51121;
export const CALLBACK_PATH = "/oauth-callback";

export const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs"
] as const;

export const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo?alt=json";

// Upstream base URLs in fallback order (daily first, then prod).
export const BASE_URLS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com"
] as const;

const API_VERSION = "v1internal";

export const LOAD_CODE_ASSIST_URL = `https://cloudcode-pa.googleapis.com/${API_VERSION}:loadCodeAssist`;
export const ONBOARD_USER_URL = `https://daily-cloudcode-pa.googleapis.com/${API_VERSION}:onboardUser`;

// The Go port refreshes the hub version from an updater manifest at runtime;
// this port pins the fallback version (misc.antigravityFallbackVersion).
export const ANTIGRAVITY_VERSION = "2.2.1";
export const ANTIGRAVITY_PLATFORM = "darwin/arm64";

// Short UA for userinfo / loadCodeAssist / runtime requests.
export const REQUEST_UA = `antigravity/hub/${ANTIGRAVITY_VERSION} ${ANTIGRAVITY_PLATFORM}`;
// Long UA for onboardUser control-plane requests.
export const ONBOARD_USER_UA = `${REQUEST_UA} google-api-nodejs-client/10.3.0`;
export const GOOG_API_CLIENT_UA = "gl-node/22.21.1";

// The real Antigravity client uses Go's default UA for OAuth token refresh.
export const OAUTH_REFRESH_USER_AGENT = "Go-http-client/2.0";
