import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { resetHttpFetch, setHttpFetch } from "../src/oauth/client.js";
import { TOKEN_ENDPOINT } from "../src/oauth/constants.js";
import { CredentialPool } from "../src/oauth/credentialPool.js";
import { writeCredentialAtomic, type Credential } from "../src/oauth/credentials.js";

let authDir: string;
const savedClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const savedClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const savedClientFile = process.env.PINGU_GOOGLE_OAUTH_CLIENT_FILE;

function makeCredential(overrides: Partial<Credential> = {}): Credential {
  const now = Date.now();
  return {
    type: "antigravity",
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_in: 3600,
    timestamp: now,
    expired: new Date(now + 3600_000).toISOString(),
    email: "user@example.com",
    project_id: "project-1",
    ...overrides
  };
}

function fakeTokenEndpoint(response: Response): void {
  setHttpFetch((async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    assert.equal(url, TOKEN_ENDPOINT);
    assert.equal(init?.method, "POST");
    const body = init?.body as string;
    assert.match(body, /grant_type=refresh_token/);
    assert.match(body, /refresh_token=refresh-1/);
    return response;
  }) as typeof fetch);
}

beforeEach(async () => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "dummy-pool-client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "dummy-pool-client-secret";
  delete process.env.PINGU_GOOGLE_OAUTH_CLIENT_FILE;
  authDir = await mkdtemp(join(tmpdir(), "antigravity-auth-"));
});

afterEach(async () => {
  resetHttpFetch();
  if (savedClientId === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  else process.env.GOOGLE_OAUTH_CLIENT_ID = savedClientId;
  if (savedClientSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  else process.env.GOOGLE_OAUTH_CLIENT_SECRET = savedClientSecret;
  if (savedClientFile === undefined) delete process.env.PINGU_GOOGLE_OAUTH_CLIENT_FILE;
  else process.env.PINGU_GOOGLE_OAUTH_CLIENT_FILE = savedClientFile;
  await rm(authDir, { recursive: true, force: true });
});

test("load returns an empty pool when the auth dir is missing", async () => {
  const pool = await CredentialPool.load(join(authDir, "does-not-exist"));
  assert.equal(pool.size, 0);
  assert.deepEqual(pool.list(), []);
});

test("load picks up credential files and skips malformed ones", async () => {
  await writeCredentialAtomic(authDir, makeCredential());
  await writeCredentialAtomic(authDir, makeCredential({ email: "second@example.com", access_token: "access-2" }));
  await writeFile(join(authDir, "antigravity-broken.json"), "not json");

  const pool = await CredentialPool.load(authDir);
  assert.equal(pool.size, 2);
  assert.deepEqual(pool.list().map((c) => c.email).sort(), ["second@example.com", "user@example.com"]);
});

test("ensureFresh returns the credential untouched when still valid", async () => {
  const cred = makeCredential();
  await writeCredentialAtomic(authDir, cred);
  const pool = await CredentialPool.load(authDir);

  let called = false;
  setHttpFetch((async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch);

  const result = await pool.ensureFresh(cred);
  assert.equal(result, cred);
  assert.equal(called, false);
});

test("ensureFresh refreshes an expired credential and persists the rotation", async () => {
  const cred = makeCredential({ timestamp: Date.now() - 7200_000, expires_in: 3600 });
  await writeCredentialAtomic(authDir, cred);
  const pool = await CredentialPool.load(authDir);

  fakeTokenEndpoint(
    new Response(
      JSON.stringify({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 3600,
        token_type: "Bearer"
      }),
      { status: 200 }
    )
  );

  const result = await pool.ensureFresh(cred);
  assert.ok(result);
  assert.equal(result?.access_token, "access-2");
  assert.equal(result?.refresh_token, "refresh-2");
  assert.equal(result?.email, "user@example.com");

  // The pool now serves the refreshed credential.
  assert.equal(pool.size, 1);
  assert.equal(pool.list()[0]?.access_token, "access-2");

  // The rotated refresh token was persisted to disk.
  const persisted = JSON.parse(await readFile(join(authDir, "antigravity-user@example.com.json"), "utf8")) as {
    access_token: string;
    refresh_token: string;
  };
  assert.equal(persisted.access_token, "access-2");
  assert.equal(persisted.refresh_token, "refresh-2");
});

test("ensureFresh keeps the old refresh token when the response omits it", async () => {
  const cred = makeCredential({ timestamp: Date.now() - 7200_000, expires_in: 3600 });
  await writeCredentialAtomic(authDir, cred);
  const pool = await CredentialPool.load(authDir);

  fakeTokenEndpoint(
    new Response(JSON.stringify({ access_token: "access-3", expires_in: 3600, token_type: "Bearer" }), {
      status: 200
    })
  );

  const result = await pool.ensureFresh(cred);
  assert.equal(result?.refresh_token, "refresh-1");
});

test("ensureFresh drops the credential when refresh fails", async () => {
  const cred = makeCredential({ timestamp: Date.now() - 7200_000, expires_in: 3600 });
  await writeCredentialAtomic(authDir, cred);
  const pool = await CredentialPool.load(authDir);

  fakeTokenEndpoint(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));

  const result = await pool.ensureFresh(cred);
  assert.equal(result, null);
  assert.equal(pool.size, 0);
});

test("invalidate removes the credential by identity or email", async () => {
  const first = makeCredential();
  const second = makeCredential({ email: "second@example.com" });
  await writeCredentialAtomic(authDir, first);
  await writeCredentialAtomic(authDir, second);
  const pool = await CredentialPool.load(authDir);
  assert.equal(pool.size, 2);

  pool.invalidate(first);
  assert.equal(pool.size, 1);
  assert.equal(pool.list()[0]?.email, "second@example.com");

  // A stale object reference for the same email also matches.
  pool.invalidate({ ...second });
  assert.equal(pool.size, 0);
});
