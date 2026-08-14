import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function getAgentPaths(env = process.env) {
  const configPath = env.EVA_BLOG_STATUS_CONFIG || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "eva-blog-status", "config.json");
  return { configPath, statePath: `${configPath}.state.json` };
}

export async function readAgentState(env = process.env) {
  const { statePath } = getAgentPaths(env);
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (state.status === "running" && Number.isInteger(state.pid) && !isProcessRunning(state.pid)) {
      return { ...state, status: "stopped", lastError: "The background agent process is no longer running." };
    }
    return state;
  } catch (error) { if (error?.code === "ENOENT") return { status: "not-configured" }; throw error; }
}

function isProcessRunning(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

export async function writeAgentState(state, env = process.env) {
  const { statePath } = getAgentPaths(env);
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await chmod(dirname(statePath), 0o700);
  await writeFile(statePath, `${JSON.stringify(safeState(state), null, 2)}\n`, { mode: 0o600 });
  await chmod(statePath, 0o600);
}

function safeState(state = {}) {
  return {
    status: String(state.status || "unknown"),
    pid: Number.isInteger(state.pid) ? state.pid : undefined,
    startedAt: state.startedAt,
    lastAttemptAt: state.lastAttemptAt,
    lastSuccessAt: state.lastSuccessAt,
    lastError: state.lastError,
    synced: Array.isArray(state.synced) ? state.synced.slice(0, 4) : [],
    found: state.found && typeof state.found === "object" ? { music: Boolean(state.found.music), token: Boolean(state.found.token) } : undefined
  };
}
