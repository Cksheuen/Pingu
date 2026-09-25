import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  buildAuthURL,
  exchangeCode,
  refreshAccessToken,
  resetHttpFetch,
  setHttpFetch
} from "../src/oauth/client.js";
import { resolveGoogleOAuthClientConfig } from "../src/oauth/clientConfig.js";
import { AUTH_ENDPOINT, OAUTH_REFRESH_USER_AGENT, TOKEN_ENDPOINT } from "../src/oauth/constants.js";

const ENV_KEYS = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "PINGU_GOOGLE_OAUTH_CLIENT_FILE"
] as const;

let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;
let tempDir: string;

function clearClientEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as typeof savedEnv;
  clearClientEnv();
  tempDir = await mkdtemp(join(tmpdir(), "google-oauth-client-"));
});

afterEach(async () => {
  resetHttpFetch();
  clearClientEnv();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value !== undefined) process.env[key] = value;
  }
  await rm(tempDir, { recursive: true, force: true });
});

test("Google OAuth client config honors precedence and returns redacted validation errors", async () => {
  const file = join(tempDir, "client.json");
  await writeFile(file, JSON.stringify({ clientId: "file-client", clientSecret: "file-secret" }));
  process.env.PINGU_GOOGLE_OAUTH_CLIENT_FILE = file;
  process.env.GOOGLE_OAUTH_CLIENT_ID = "env-client";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "env-secret";
  assert.deepEqual(resolveGoogleOAuthClientConfig(), { clientId: "env-client", clientSecret: "env-secret" });

  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  assert.throws(resolveGoogleOAuthClientConfig, /must be set together/);

  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  assert.deepEqual(resolveGoogleOAuthClientConfig(), { clientId: "file-client", clientSecret: "file-secret" });

  const malformed = join(tempDir, "malformed.json");
  await writeFile(malformed, "not-json-private-content");
  process.env.PINGU_GOOGLE_OAUTH_CLIENT_FILE = malformed;
  assert.throws(resolveGoogleOAuthClientConfig, /^Error: Google OAuth client configuration file is not valid JSON/);

  const incomplete = join(tempDir, "incomplete.json");
  await writeFile(incomplete, JSON.stringify({ clientId: "only-id" }));
  process.env.PINGU_GOOGLE_OAUTH_CLIENT_FILE = incomplete;
  assert.throws(resolveGoogleOAuthClientConfig, /must contain non-empty clientId and clientSecret strings/);

  process.env.PINGU_GOOGLE_OAUTH_CLIENT_FILE = join(tempDir, "missing.json");
  assert.throws(resolveGoogleOAuthClientConfig, /file could not be read/);
});

test("authorization, code exchange, and refresh wire configured dummy credentials", async () => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "dummy-client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "dummy-client-secret";

  const authURL = new URL(buildAuthURL("state-1", "http://localhost/callback"));
  assert.equal(`${authURL.origin}${authURL.pathname}`, AUTH_ENDPOINT);
  assert.equal(authURL.searchParams.get("client_id"), "dummy-client-id");
  assert.equal(authURL.searchParams.get("state"), "state-1");

  const requests: Array<{ body: URLSearchParams; userAgent: string | null }> = [];
  setHttpFetch((async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    assert.equal(url, TOKEN_ENDPOINT);
    const headers = new Headers(init?.headers);
    requests.push({ body: new URLSearchParams(String(init?.body)), userAgent: headers.get("user-agent") });
    return new Response(
      JSON.stringify({ access_token: "dummy-access", expires_in: 3600, token_type: "Bearer" }),
      { status: 200 }
    );
  }) as typeof fetch);

  await exchangeCode("dummy-code", "http://localhost/callback");
  await refreshAccessToken("dummy-refresh");

  assert.deepEqual(Object.fromEntries(requests[0]!.body), {
    code: "dummy-code",
    client_id: "dummy-client-id",
    client_secret: "dummy-client-secret",
    redirect_uri: "http://localhost/callback",
    grant_type: "authorization_code"
  });
  assert.equal(requests[0]!.userAgent, null);
  assert.deepEqual(Object.fromEntries(requests[1]!.body), {
    client_id: "dummy-client-id",
    client_secret: "dummy-client-secret",
    grant_type: "refresh_token",
    refresh_token: "dummy-refresh"
  });
  assert.equal(requests[1]!.userAgent, OAUTH_REFRESH_USER_AGENT);
});
