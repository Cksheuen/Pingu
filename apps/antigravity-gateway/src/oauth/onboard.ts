import { getHttpFetch } from "./client.js";
import {
  ANTIGRAVITY_VERSION,
  GOOG_API_CLIENT_UA,
  LOAD_CODE_ASSIST_URL,
  ONBOARD_USER_UA,
  ONBOARD_USER_URL,
  REQUEST_UA
} from "./constants.js";

export interface OnboardOptions {
  intervalMs?: number;
  perRequestTimeoutMs?: number;
  maxAttempts?: number;
}

// Mirrors extractCloudaicompanionProject in the Go reference: accept a string
// value or an object with an `id` field, checked in priority key order.
function extractProjectId(data: unknown): string {
  if (typeof data !== "object" || data === null) return "";
  const record = data as Record<string, unknown>;
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const value = record[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed !== "") return trimmed;
    } else if (typeof value === "object" && value !== null) {
      const id = (value as Record<string, unknown>).id;
      if (typeof id === "string") {
        const trimmed = id.trim();
        if (trimmed !== "") return trimmed;
      }
    }
  }
  return "";
}

// Mirrors defaultAntigravityTierID: prefer the default allowed tier, then the
// current tier, then fall back to free-tier.
function defaultTierId(loadResp: Record<string, unknown>): string {
  const tiers = loadResp.allowedTiers;
  if (Array.isArray(tiers)) {
    for (const rawTier of tiers) {
      if (typeof rawTier !== "object" || rawTier === null) continue;
      const tier = rawTier as Record<string, unknown>;
      if (tier.isDefault !== true) continue;
      if (typeof tier.id === "string") {
        const trimmed = tier.id.trim();
        if (trimmed !== "") return trimmed;
      }
    }
  }
  const currentTier = loadResp.currentTier;
  if (typeof currentTier === "object" && currentTier !== null) {
    const id = (currentTier as Record<string, unknown>).id;
    if (typeof id === "string") {
      const trimmed = id.trim();
      if (trimmed !== "") return trimmed;
    }
  }
  return "free-tier";
}

/**
 * Discover the GCP project ID via loadCodeAssist. When the account has no
 * project yet, fall back to polling onboardUser until onboarding completes.
 */
export async function fetchProjectId(accessToken: string): Promise<string> {
  const res = await getHttpFetch()(LOAD_CODE_ASSIST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "*/*",
      "Content-Type": "application/json",
      "User-Agent": REQUEST_UA
    },
    body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } })
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`loadCodeAssist request failed with status ${res.status}: ${text.trim()}`);
  }
  const loadResp = JSON.parse(text) as Record<string, unknown>;
  const projectId = extractProjectId(loadResp);
  if (projectId !== "") return projectId;
  return onboardUser(accessToken, defaultTierId(loadResp));
}

/**
 * Poll onboardUser until onboarding is done. Defaults: 5 attempts, 2s apart,
 * 30s per-request timeout (matching the Go reference).
 */
export async function onboardUser(
  accessToken: string,
  tierId: string,
  opts: OnboardOptions = {}
): Promise<string> {
  const intervalMs = opts.intervalMs ?? 2000;
  const perRequestTimeoutMs = opts.perRequestTimeoutMs ?? 30000;
  const maxAttempts = opts.maxAttempts ?? 5;
  const body = JSON.stringify({
    tier_id: tierId,
    metadata: {
      ide_type: "ANTIGRAVITY",
      ide_version: ANTIGRAVITY_VERSION,
      ide_name: "antigravity"
    }
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await getHttpFetch()(ONBOARD_USER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "*/*",
        "Content-Type": "application/json",
        "User-Agent": ONBOARD_USER_UA,
        "X-Goog-Api-Client": GOOG_API_CLIENT_UA
      },
      body,
      signal: AbortSignal.timeout(perRequestTimeoutMs)
    });
    const text = await res.text();
    if (res.status !== 200) {
      throw new Error(`onboardUser http ${res.status}: ${text.trim().slice(0, 200)}`);
    }
    const data = JSON.parse(text) as Record<string, unknown>;
    if (data.done === true) {
      const projectId = extractProjectId(data.response);
      if (projectId === "") {
        throw new Error("onboardUser: no project_id in response");
      }
      return projectId;
    }
    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }
  throw new Error(`onboard user did not complete after ${maxAttempts} attempts`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
