import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeTokenUsage, parseNowPlayingOutput, readCodexTokenUsage, readLocalSignals, readNowPlaying, readTokenUsage } from "../scripts/localSources.mjs";

test("local token source accepts common usage field names", () => {
  const usage = normalizeTokenUsage({ used: 128000, tokenBudget: 256000, provider: "OpenAI" });
  assert.deepEqual(usage, {
    usedTokens: 128000,
    limitTokens: 256000,
    usagePercent: 50,
    unit: "tokens",
    provider: "OpenAI",
    capturedAt: usage.capturedAt
  });
  assert.ok(usage.capturedAt);
});

test("local token source reads an explicit snapshot file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eva-blog-status-"));
  try {
    const filePath = join(directory, "token-usage.json");
    await writeFile(filePath, JSON.stringify({ usedTokens: 80, limitTokens: 100, model: "test-model" }));
    const usage = await readTokenUsage({ env: { EVA_BLOG_TOKEN_USAGE_FILE: filePath } });
    assert.equal(usage.usedTokens, 80);
    assert.equal(usage.limitTokens, 100);
    assert.equal(usage.model, "test-model");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex token source reads only token counters from the session log", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eva-blog-codex-"));
  try {
    const filePath = join(directory, "session.jsonl");
    await writeFile(filePath, [
      JSON.stringify({ type: "response_item", payload: { text: "sensitive prompt must not be returned" } }),
      JSON.stringify({ timestamp: "2026-08-12T12:00:00.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 800 }, model_context_window: 1000 } } })
    ].join("\n"));
    const usage = await readCodexTokenUsage({ env: { EVA_BLOG_CODEX_SESSION_FILE: filePath } });
    assert.deepEqual(usage, {
      usedTokens: 800,
      limitTokens: 1000,
      usagePercent: 80,
      unit: "tokens",
      provider: "Codex",
      window: "current thread",
      capturedAt: "2026-08-12T12:00:00.000Z"
    });
    assert.equal(JSON.stringify(usage).includes("sensitive"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex token source can discover a session file after an earlier miss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eva-blog-codex-late-session-"));
  const threadId = "late-thread";
  const sessionFile = join(directory, `rollout-${threadId}.jsonl`);
  try {
    assert.equal(await readCodexTokenUsage({ sessionsRoot: directory, threadId, env: {} }), null);
    await writeFile(sessionFile, JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-12T10:00:00.000Z",
      payload: { type: "token_count", info: { last_token_usage: { total_tokens: 5 }, model_context_window: 10 } }
    }));
    assert.equal((await readCodexTokenUsage({ sessionsRoot: directory, threadId, env: {} })).usagePercent, 50);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("now playing source parses player output", () => {
  assert.deepEqual(parseNowPlayingOutput("Spotify\tplaying\tNight Drive\tEva FM\tAfter Hours"), {
    service: "Spotify",
    playbackState: "playing",
    track: "Night Drive",
    artist: "Eva FM",
    album: "After Hours",
    playing: true
  });
});

test("macOS now playing source executes the real provider probe contract", async () => {
  const calls = [];
  const snapshot = await readNowPlaying({
    platform: "darwin",
    exec: async (command, args) => {
      calls.push([command, args]);
      return { stdout: command === "osascript" ? "Apple Music\tplaying\tNight Drive\tEva FM\tAfter Hours" : "" };
    }
  });
  assert.equal(snapshot.track, "Night Drive");
  assert.deepEqual(calls.map(([command]) => command), ["open", "osascript"]);
});

test("local signal reader stays empty when no platform sources exist", async () => {
  assert.deepEqual(await readLocalSignals({ platform: "linux", cwd: "/tmp", env: {} }), { tokenUsage: null, nowPlaying: null });
});
