import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync, unlinkSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppConfig } from "./config/config.js";

interface DaemonState {
  pid: number;
  startedAt: string;
  host: string;
  port: number;
  logPath: string;
}

const runtimeDirName = ".runtime";
const pidFileName = "gateway.pid.json";
const logFileName = "gateway.log";

export async function startDaemon(appRoot: string, config: AppConfig): Promise<void> {
  const runtimeDir = resolve(appRoot, runtimeDirName);
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const pidPath = resolve(runtimeDir, pidFileName);
  const logPath = resolve(runtimeDir, logFileName);
  const existing = await readState(pidPath);
  if (existing && isGatewayProcess(existing.pid)) {
    console.log(`gateway already running (pid ${existing.pid}, http://${config.host}:${config.port})`);
    return;
  }
  if (existing) await removeState(pidPath);

  const logFd = openSync(logPath, "a", 0o600);
  let child;
  try {
    child = spawn(process.execPath, ["--import", "tsx", "scripts/dev-server.ts"], {
      cwd: appRoot,
      detached: true,
      env: process.env,
      stdio: ["ignore", logFd, logFd]
    });
  } finally {
    closeSync(logFd);
  }
  if (!child.pid) throw new Error("gateway process did not start");

  const state: DaemonState = {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    host: config.host,
    port: config.port,
    logPath
  };
  await writeFile(pidPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  child.unref();

  const healthy = await waitForHealth(config, 3_000);
  if (!healthy) {
    console.error(`gateway process started (pid ${child.pid}) but health check did not pass; see ${logPath}`);
    return;
  }
  console.log(`gateway started (pid ${child.pid}, http://${config.host}:${config.port})`);
}

export async function stopDaemon(appRoot: string): Promise<void> {
  const pidPath = resolve(appRoot, runtimeDirName, pidFileName);
  const state = await readState(pidPath);
  if (!state) {
    console.log("gateway is not running");
    return;
  }
  if (!isGatewayProcess(state.pid)) {
    await removeState(pidPath);
    console.log("gateway is not running (removed stale pid file)");
    return;
  }

  signalProcess(state.pid, "SIGTERM");
  const stopped = await waitForExit(state.pid, 5_000);
  if (!stopped && isGatewayProcess(state.pid)) {
    signalProcess(state.pid, "SIGKILL");
    await waitForExit(state.pid, 1_000);
  }
  await removeState(pidPath);
  console.log(`gateway stopped (pid ${state.pid})`);
}

export async function restartDaemon(appRoot: string, config: AppConfig): Promise<void> {
  await stopDaemon(appRoot);
  await startDaemon(appRoot, config);
}

export async function printDaemonStatus(appRoot: string): Promise<void> {
  const pidPath = resolve(appRoot, runtimeDirName, pidFileName);
  const state = await readState(pidPath);
  if (!state || !isGatewayProcess(state.pid)) {
    if (state) await removeState(pidPath);
    console.log(JSON.stringify({ running: false, pidFile: pidPath }));
    return;
  }
  const healthy = await checkHealth(state.host, state.port);
  console.log(
    JSON.stringify(
      {
        running: true,
        healthy,
        pid: state.pid,
        startedAt: state.startedAt,
        url: `http://${state.host}:${state.port}`,
        logPath: state.logPath
      },
      null,
      2
    )
  );
}

export async function printDaemonLogs(appRoot: string, lines = 80): Promise<void> {
  const logPath = resolve(appRoot, runtimeDirName, logFileName);
  try {
    const text = await readFile(logPath, "utf8");
    const output = text.split("\n").slice(-Math.max(1, lines)).join("\n").trimEnd();
    console.log(output || `(empty log: ${logPath})`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.log(`no gateway log yet: ${logPath}`);
      return;
    }
    throw error;
  }
}

async function readState(path: string): Promise<DaemonState | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<DaemonState>;
    const pid = value.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
    if (typeof value.host !== "string" || !Number.isInteger(value.port)) return undefined;
    return value as DaemonState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function removeState(path: string): Promise<void> {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function isGatewayProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return command.includes("scripts/dev-server");
  } catch {
    return false;
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await delay(100);
  }
  return !isProcessAlive(pid);
}

async function waitForHealth(config: AppConfig, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkHealth(config.host, config.port)) return true;
    await delay(100);
  }
  return false;
}

async function checkHealth(host: string, port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}/healthz`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
