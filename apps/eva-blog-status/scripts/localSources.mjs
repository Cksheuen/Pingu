import { readFile, readdir, open } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sessionPathCache = new Map();

export async function readLocalSignals({ cwd = process.cwd(), env = process.env, platform = process.platform, exec = execFileAsync } = {}) {
  const [tokenUsage, nowPlaying] = await Promise.all([
    readTokenUsage({ cwd, env }),
    readNowPlaying({ platform, exec })
  ]);
  return { tokenUsage, nowPlaying };
}

export async function readTokenUsage({ cwd = process.cwd(), env = process.env } = {}) {
  if (!env.EVA_BLOG_TOKEN_USAGE_FILE) {
    const codexUsage = await readCodexTokenUsage({ env });
    if (codexUsage) return codexUsage;
  }
  const filePath = env.EVA_BLOG_TOKEN_USAGE_FILE || join(cwd, "../../.local/eva-blog-token-usage.json");
  try {
    const payload = JSON.parse(await readFile(filePath, "utf8"));
    return normalizeTokenUsage(payload);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Could not read token usage source: ${error.message || error}`);
  }
}

export async function readNowPlaying({ platform = process.platform, exec = execFileAsync } = {}) {
  if (platform !== "darwin") return null;
  for (const provider of [APPLE_MUSIC_SCRIPT, SPOTIFY_SCRIPT]) {
    try {
      await exec("open", ["-Ra", provider.application]);
      const result = await exec("osascript", ["-e", provider.script], { timeout: 1800 });
      const snapshot = parseNowPlayingOutput(result.stdout, provider.name);
      if (snapshot) return snapshot;
    } catch {
      // A player may be absent or stopped; the next local provider can still answer.
    }
  }
  return null;
}

export async function readCodexTokenUsage({ env = process.env, sessionsRoot, threadId } = {}) {
  const explicitSessionFile = env.EVA_BLOG_CODEX_SESSION_FILE;
  const resolvedThreadId = threadId || env.EVA_BLOG_CODEX_THREAD_ID || env.CODEX_THREAD_ID;
  const codexHome = env.CODEX_HOME || join(homedir(), ".codex");
  const resolvedSessionsRoot = sessionsRoot || join(codexHome, "sessions");
  const filePath = explicitSessionFile || (resolvedThreadId ? await findCachedSessionFile(resolvedSessionsRoot, resolvedThreadId) : null);
  if (!filePath) return null;

  const latest = await readLatestTokenEvent(filePath);
  if (!latest?.lastTokenUsage) return null;
  const usedTokens = numberValue(latest.lastTokenUsage.total_tokens);
  const limitTokens = numberValue(latest.contextWindow);
  if (usedTokens === null) return null;
  return compact({
    usedTokens,
    limitTokens,
    usagePercent: limitTokens && limitTokens > 0 ? Math.min(100, Math.round((usedTokens / limitTokens) * 100)) : undefined,
    unit: "tokens",
    provider: "Codex",
    window: "current thread",
    capturedAt: latest.timestamp || new Date().toISOString()
  });
}

async function findSessionFile(root, threadId) {
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        const found = await findSessionFile(path, threadId);
        if (found) return found;
      } else if (entry.isFile() && basename(path).endsWith(`${threadId}.jsonl`)) {
        return path;
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "EACCES") throw error;
  }
  return null;
}

async function findCachedSessionFile(root, threadId) {
  const cacheKey = `${root}:${threadId}`;
  if (sessionPathCache.get(cacheKey)) return sessionPathCache.get(cacheKey);
  const filePath = await findSessionFile(root, threadId);
  if (filePath) sessionPathCache.set(cacheKey, filePath);
  return filePath;
}

async function readLatestTokenEvent(filePath) {
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    const length = Math.min(info.size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, info.size - length));
    const lines = buffer.toString("utf8").split(/\r?\n/).reverse();
    for (const line of lines) {
      if (!line.includes('"type":"token_count"')) continue;
      try {
        const event = JSON.parse(line);
        const info = event?.payload?.info;
        if (event?.type === "event_msg" && info?.last_token_usage) {
          return {
            timestamp: event.timestamp,
            lastTokenUsage: info.last_token_usage,
            contextWindow: info.model_context_window
          };
        }
      } catch {
        // A partially written final line is ignored until the next poll.
      }
    }
  } finally {
    await handle.close();
  }
  return null;
}

export function normalizeTokenUsage(input = {}) {
  const usedTokens = numberValue(input.usedTokens ?? input.used ?? input.tokensUsed);
  if (usedTokens === null) throw new Error("Token usage source requires usedTokens.");
  const limitTokens = numberValue(input.limitTokens ?? input.limit ?? input.tokenBudget);
  if (limitTokens !== null && limitTokens < usedTokens) throw new Error("Token usage source has a limit below used tokens.");
  const usagePercent = limitTokens === null || limitTokens === 0 ? null : Math.min(100, Math.round((usedTokens / limitTokens) * 100));
  return compact({
    usedTokens,
    limitTokens,
    usagePercent,
    unit: String(input.unit || "tokens").trim(),
    provider: String(input.provider || "").trim(),
    model: String(input.model || "").trim(),
    window: String(input.window || "").trim(),
    resetAt: String(input.resetAt || "").trim(),
    capturedAt: String(input.capturedAt || new Date().toISOString()).trim()
  });
}

export function parseNowPlayingOutput(output, fallbackService = "local player") {
  const [service, playbackState, track, artist, album] = String(output || "").trim().split("\t");
  if (!track) return null;
  return compact({
    service: service || fallbackService,
    playbackState: playbackState || "playing",
    track,
    artist,
    album,
    playing: playbackState !== "paused"
  });
}

function numberValue(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}

const APPLE_MUSIC_SCRIPT = {
  name: "Apple Music",
  application: "Music",
  script: `tell application "Music"
  if it is running and (player state is playing or player state is paused) then
    return "Apple Music" & tab & (player state as text) & tab & (name of current track) & tab & (artist of current track) & tab & (album of current track)
  end if
end tell
return ""`
};

const SPOTIFY_SCRIPT = {
  name: "Spotify",
  application: "Spotify",
  script: `tell application "Spotify"
  if it is running and (player state is playing or player state is paused) then
    return "Spotify" & tab & (player state as text) & tab & (name of current track) & tab & (artist of current track) & tab & (album of current track)
  end if
end tell
return ""`
};
