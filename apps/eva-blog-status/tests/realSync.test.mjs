import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorker } from "../../eva-blog-admin/server/worker.js";
import { createMemoryStorage } from "../../eva-blog-admin/src/services/storage.js";
import { createSignedSessionCookie } from "../../eva-blog-admin/src/services/sessionCookie.js";
import { readLocalSignals } from "../scripts/localSources.mjs";
import { normalizeAutoStatusInput } from "../src/statusContract.js";

test("real local signal payloads cross HTTP and persist as private statuses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eva-blog-real-sync-"));
  const tokenFile = join(directory, "token-usage.json");
  await writeFile(tokenFile, JSON.stringify({ usedTokens: 40, limitTokens: 100, provider: "Codex" }));

  const storage = createMemoryStorage({ articles: [], comments: [], statuses: [] });
  const worker = createWorker({
    storage,
    env: { SESSION_SECRET: "real-sync-secret" },
    authorLogins: ["eva-real-sync"]
  });
  const server = createServer(async (request, response) => {
    const body = request.method === "GET" ? undefined : await readBody(request);
    const apiResponse = await worker.fetch(new Request(`http://${request.headers.host}${request.url}`, {
      method: request.method,
      headers: request.headers,
      body
    }));
    response.writeHead(apiResponse.status, Object.fromEntries(apiResponse.headers.entries()));
    response.end(Buffer.from(await apiResponse.arrayBuffer()));
  });

  try {
    const address = await listen(server);
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const cookie = await createSignedSessionCookie({ provider: "github", id: "github-real-sync", login: "eva-real-sync", name: "Eva Real Sync" }, "real-sync-secret");
    const signals = await readLocalSignals({
      env: { EVA_BLOG_TOKEN_USAGE_FILE: tokenFile },
      platform: "darwin",
      exec: async (command) => ({ stdout: command === "osascript" ? "Apple Music\tplaying\tNight Drive\tEva FM\tAfter Hours" : "" })
    });

    const tokenResponse = await postAuto(baseUrl, cookie, normalizeAutoStatusInput("token", signals.tokenUsage));
    const musicResponse = await postAuto(baseUrl, cookie, normalizeAutoStatusInput("song", signals.nowPlaying));
    assert.equal(tokenResponse.status, 201, await tokenResponse.text());
    assert.equal(musicResponse.status, 201, await musicResponse.text());

    const persisted = storage.read().statuses;
    assert.equal(persisted.length, 2);
    assert.deepEqual(persisted.map((item) => item.kind).sort(), ["song", "token"]);
    assert.ok(persisted.every((item) => item.isPublic === false));
    assert.deepEqual(persisted.find((item) => item.kind === "token").meta, { usagePercent: 40, unit: "%" });
    assert.deepEqual(persisted.find((item) => item.kind === "song").meta, { track: "Night Drive", artist: "Eva FM", service: "Apple Music", playing: true });
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

async function postAuto(baseUrl, cookie, payload) {
  return fetch(`${baseUrl}/api/status/auto`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `eva_session=${cookie}` },
    body: JSON.stringify(payload)
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
