import { chmod, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeAutoStatusInput } from "../src/statusContract.js";
import { readLocalSignals } from "./localSources.mjs";
import { getAgentPaths, writeAgentState } from "./agentState.mjs";

const DEFAULT_API_ORIGIN = "http://127.0.0.1:4174";
const DEFAULT_INTERVAL_MS = 60_000;
const { configPath } = getAgentPaths();
const lockPath = `${configPath}.lock`;
const command = process.argv[2] || "run";

if (command === "configure") {
  await configure();
} else if (command === "status") {
  await printStatus();
} else if (command === "once") {
  await reportOnce();
} else if (command === "run") {
  await runDaemon();
} else {
  printUsage();
  process.exitCode = 1;
}

async function configure() {
  const token = process.argv.includes("--token-stdin")
    ? (await readStdin()).trim()
    : valueAfter("--token");
  if (!token) throw new Error("A daemon token is required. Use --token-stdin or --token.");
  const current = await readConfig();
  const apiOrigin = valueAfter("--api") || current.apiOrigin || process.env.EVA_BLOG_AUTHOR_API_ORIGIN || DEFAULT_API_ORIGIN;
  await saveConfig({ apiOrigin, token, configuredAt: new Date().toISOString() });
  console.log(`Saved Eva Status background agent config at ${configPath}.`);
  console.log(`API: ${apiOrigin}`);
}

async function printStatus() {
  const config = await readConfig();
  if (!config.token) {
    console.log(JSON.stringify({ configured: false, configPath }));
    return;
  }
  console.log(JSON.stringify({ configured: true, apiOrigin: config.apiOrigin || DEFAULT_API_ORIGIN, configPath }, null, 2));
}

async function reportOnce() {
  const config = await requireConfig();
  const result = await performSync(config, { status: "once" });
  console.log(JSON.stringify(result));
}

async function runDaemon() {
  const config = await requireConfig();
  const lock = await acquireLock();
  if (!lock) throw new Error("Eva Status background agent is already running.");
  let stopping = false;
  let timer;
  let wake;
  const stop = () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    if (wake) wake();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(`Eva Status background agent running (interval ${DEFAULT_INTERVAL_MS / 1000}s).`);
  await writeAgentState({ status: "running", pid: process.pid, startedAt: new Date().toISOString() });
  try {
    while (!stopping) {
      try {
        const result = await performSync(config, { status: "running", pid: process.pid, startedAt: new Date().toISOString() });
        console.log(formatLog(result));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await writeAgentState({ status: "error", pid: process.pid, lastAttemptAt: new Date().toISOString(), lastError: message });
        console.error(`[error] ${message}`);
      }
      if (stopping) break;
      await new Promise((resolve) => {
        wake = resolve;
        timer = setTimeout(() => { wake = null; resolve(); }, DEFAULT_INTERVAL_MS);
      });
    }
  } finally {
    await writeAgentState({ status: "stopped", lastAttemptAt: new Date().toISOString() });
    await lock.release();
  }
}

async function performSync(config, previous = {}) {
  const attemptedAt = new Date().toISOString();
  await writeAgentState({ ...previous, status: previous.status || "once", lastAttemptAt: attemptedAt });
  const result = await syncSignals(config);
  await writeAgentState({ ...previous, status: previous.status || "once", lastAttemptAt: attemptedAt, lastSuccessAt: result.capturedAt, synced: result.synced, found: result.found });
  return result;
}

async function syncSignals(config) {
  const signals = await readLocalSignals({ env: process.env });
  const synced = [];
  if (signals.nowPlaying) {
    await postAuto(config, normalizeAutoStatusInput("song", signals.nowPlaying));
    synced.push("music");
  }
  if (signals.tokenUsage?.usagePercent !== undefined) {
    await postAuto(config, normalizeAutoStatusInput("token", signals.tokenUsage));
    synced.push("token");
  }
  return {
    capturedAt: new Date().toISOString(),
    found: { music: Boolean(signals.nowPlaying), token: Boolean(signals.tokenUsage) },
    synced
  };
}

async function postAuto(config, payload) {
  const response = await fetch(new URL("/api/status/auto", config.apiOrigin || DEFAULT_API_ORIGIN), {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Author API returned ${response.status}.`);
  return body;
}

async function requireConfig() {
  const config = await readConfig();
  const token = process.env.STATUS_DAEMON_TOKEN || config.token;
  if (!token) throw new Error(`No daemon token configured. Run: printf '%s' '<token>' | pnpm daemon configure --token-stdin`);
  return { ...config, token, apiOrigin: process.env.EVA_BLOG_AUTHOR_API_ORIGIN || config.apiOrigin || DEFAULT_API_ORIGIN };
}

async function readConfig() {
  try { return JSON.parse(await readFile(configPath, "utf8")); } catch (error) { if (error?.code === "ENOENT") return {}; throw error; }
}

async function saveConfig(config) {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(configPath), 0o700);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
}

async function acquireLock() {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    return await createLock();
  } catch (error) {
    if (error?.code === "EEXIST") {
      const stalePid = Number.parseInt((await readFile(lockPath, "utf8").catch(() => "")), 10);
      if (Number.isInteger(stalePid) && isProcessRunning(stalePid)) return null;
      await rm(lockPath, { force: true });
      return createLock();
    }
    throw error;
  }
}

async function createLock() {
  const handle = await open(lockPath, "wx", 0o600);
  await handle.writeFile(`${process.pid}\n`);
  return { release: async () => { await handle.close(); await rm(lockPath, { force: true }); } };
}

function isProcessRunning(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

function formatLog(result) { return `[${result.capturedAt}] synced: ${result.synced.join(", ") || "none"}`; }
function printUsage() { console.log("Usage: pnpm daemon <run|once|status|configure> [--token TOKEN|--token-stdin] [--api URL]"); }
