import { readFileSync } from "node:fs";

export interface GoogleOAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

const DEFAULT_CLIENT_FILE = new URL("../../.local/google-oauth-client.json", import.meta.url);

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function loadClientFile(path: string | URL, source: string): GoogleOAuthClientConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Google OAuth client configuration file could not be read (${source})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Google OAuth client configuration file is not valid JSON (${source})`);
  }

  const record = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const clientId = nonEmptyString(record.clientId);
  const clientSecret = nonEmptyString(record.clientSecret);
  if (clientId === undefined || clientSecret === undefined) {
    throw new Error(
      `Google OAuth client configuration must contain non-empty clientId and clientSecret strings (${source})`
    );
  }
  return { clientId, clientSecret };
}

/** Resolve private Google OAuth client credentials only when an OAuth action needs them. */
export function resolveGoogleOAuthClientConfig(): GoogleOAuthClientConfig {
  const envClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const envClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (envClientId !== undefined || envClientSecret !== undefined) {
    const clientId = nonEmptyString(envClientId);
    const clientSecret = nonEmptyString(envClientSecret);
    if (clientId === undefined || clientSecret === undefined) {
      throw new Error(
        "Google OAuth client configuration is incomplete: GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set together"
      );
    }
    return { clientId, clientSecret };
  }

  const explicitFile = process.env.PINGU_GOOGLE_OAUTH_CLIENT_FILE;
  if (explicitFile !== undefined) {
    const path = nonEmptyString(explicitFile);
    if (path === undefined) {
      throw new Error("PINGU_GOOGLE_OAUTH_CLIENT_FILE must name a Google OAuth client configuration file");
    }
    return loadClientFile(path, "PINGU_GOOGLE_OAUTH_CLIENT_FILE");
  }

  return loadClientFile(DEFAULT_CLIENT_FILE, "default .local/google-oauth-client.json");
}
