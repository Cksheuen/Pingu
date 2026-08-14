import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorker } from "../../eva-blog-admin/server/worker.js";
import { createMemoryStorage } from "../../eva-blog-admin/src/services/storage.js";
import { createSignedDaemonToken } from "../../eva-blog-admin/src/services/sessionCookie.js";
import { listPublicStatuses } from "../../eva-blog/src/domain/publicStatus.js";
import { readAgentState, writeAgentState } from "../scripts/agentState.mjs";

test("background CLI configures, probes, and submits a real private status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eva-blog-daemon-"));
  const configPath = join(directory, "config.json");
  const tokenFile = join(directory, "token.json");
  const secret = "daemon-integration-secret";
  await writeFile(tokenFile, JSON.stringify({ usedTokens: 25, limitTokens: 100, provider: "Codex" }));
  const storage = createMemoryStorage({ articles: [], comments: [], statuses: [] });
  const worker = createWorker({ storage, env: { SESSION_SECRET: secret }, authorLogins: ["eva-daemon"] });
  const server = createServer(async (request, response) => {
    const body = request.method === "GET" ? undefined : await readBody(request);
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
    const apiResponse = await worker.fetch(new Request(`http://${request.headers.host}${request.url}`, { method: request.method, headers, body }));
    response.writeHead(apiResponse.status, Object.fromEntries(apiResponse.headers.entries()));
    response.end(Buffer.from(await apiResponse.arrayBuffer()));
  });

  try {
    const address = await listen(server);
    const session = { provider: "github", id: "github-daemon", login: "eva-daemon", name: "Eva Daemon" };
    const issued = await createSignedDaemonToken(session, secret);
    const baseEnv = { ...process.env, EVA_BLOG_STATUS_CONFIG: configPath, EVA_BLOG_AUTHOR_API_ORIGIN: `http://127.0.0.1:${address.port}` };
    const configured = await runCli(["configure", "--token-stdin"], baseEnv, issued.token);
    assert.equal(configured.code, 0, configured.stderr);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    const once = await runCli(["once"], { ...baseEnv, EVA_BLOG_TOKEN_USAGE_FILE: tokenFile }, "");
    assert.equal(once.code, 0, once.stderr);
    assert.match(once.stdout, /"synced":\s*\[\s*"token"\s*\]/);
    assert.equal(once.stdout.includes(issued.token), false);

    const status = storage.read().statuses[0];
    assert.equal(status.actor.login, "eva-daemon");
    assert.equal(status.isPublic, false);
    assert.deepEqual(status.meta, { usagePercent: 25, unit: "%" });
    assert.deepEqual(listPublicStatuses(storage.read().statuses), []);
    const agent = await readAgentState({ EVA_BLOG_STATUS_CONFIG: configPath });
    assert.equal(agent.status, "once");
    assert.equal(agent.lastSuccessAt !== undefined, true);
    assert.deepEqual(agent.found, { music: false, token: true });
    assert.equal((await stat(`${configPath}.state.json`)).mode & 0o777, 0o600);
    assert.equal(Object.hasOwn(agent, "token"), false);
    assert.equal(JSON.stringify(agent).includes(issued.token), false);
    await writeAgentState({ status: "running", pid: 999999999 }, { EVA_BLOG_STATUS_CONFIG: configPath });
    assert.equal((await readAgentState({ EVA_BLOG_STATUS_CONFIG: configPath })).status, "stopped");
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

function runCli(args, env, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/daemon.mjs", ...args], { cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(stdin);
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

function listen(server) { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address())); }); }
function close(server) { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
