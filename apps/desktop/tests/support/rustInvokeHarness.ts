import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const DRIVER_BIN = join(
  ROOT,
  "src-tauri",
  "target",
  "debug",
  process.platform === "win32" ? "test-driver.exe" : "test-driver",
);

let driverReady = false;

async function ensureDriverBuilt(): Promise<void> {
  if (driverReady) return;

  const result = spawnSync(
    "cargo",
    ["build", "--manifest-path", "src-tauri/Cargo.toml", "--bin", "test-driver"],
    {
      cwd: ROOT,
      encoding: "utf8",
    }
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Failed to build Rust test-driver");
  }

  driverReady = true;
}

async function rustInvoke<T>(stateDir: string, command: string, args?: Record<string, unknown>): Promise<T> {
  const result = spawnSync(DRIVER_BIN, ["invoke", command, JSON.stringify(args ?? {})], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: stateDir,
      XDG_CONFIG_HOME: stateDir,
    },
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `invoke ${command} failed`).trim());
  }

  const stdout = result.stdout.trim();
  return (stdout ? JSON.parse(stdout) : undefined) as T;
}

export async function withRustInvokeHarness(run: () => Promise<void>): Promise<void> {
  await ensureDriverBuilt();
  const stateDir = mkdtempSync(join(tmpdir(), "pingu-functional-"));
  const previous = globalThis.__PINGU_TEST_INVOKE__;

  globalThis.__PINGU_TEST_INVOKE__ = async <T>(
    command: string,
    args?: Record<string, unknown>
  ): Promise<T> => rustInvoke<T>(stateDir, command, args);

  try {
    await run();
  } finally {
    globalThis.__PINGU_TEST_INVOKE__ = previous;
    rmSync(stateDir, { recursive: true, force: true });
  }
}
