import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export type ProviderType = "openai" | "anthropic" | "google-oauth" | "codex-oauth";

export interface ProviderConfig {
  type: ProviderType;
  baseUrl?: string;
  apiKey?: string;
  apiKeyFile?: string;
  apiKeySettingsFile?: string;
  headers?: Record<string, string>;
  models?: string[];
  autoDiscoverModels?: boolean;
  modelRefreshIntervalMs?: number;
  /**
   * The upstream speaks the Anthropic wire format but validates tool schemas
   * with Gemini's rules (e.g. a Gemini-backed relay). Tool schemas are then run
   * through sanitizeSchema, which drops constructs Gemini rejects such as
   * `prefixItems`. Leave off for genuine Anthropic upstreams — they accept the
   * richer schema and sanitizing would needlessly degrade it.
   */
  geminiSchemaConstraints?: boolean;
  authDir?: string;
  authFile?: string;
  clientVersion?: string;
  originator?: string;
}

export interface RouteRule {
  match?: string | string[];
  modelPrefix?: string;
  stripPrefix?: boolean;
  provider: string;
  targetModel?: string;
}

export interface AppConfig {
  port: number;
  host: string;
  apiKeys: string[];
  authDir: string;
  providers: Record<string, ProviderConfig>;
  routes: RouteRule[];
  disabledModels?: string[];
}

interface RawConfig {
  port?: unknown;
  host?: unknown;
  apiKeys?: unknown;
  authDir?: unknown;
  providers?: unknown;
  routes?: unknown;
  disabledModels?: unknown;
}

const DEFAULT_PORT = 51120;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_AUTH_DIR = "./auth";

export function loadConfig(appRoot: string): AppConfig {
  const raw = readConfigFile(appRoot);

  const port = parsePort(process.env.PORT) ?? parsePort(raw.port) ?? DEFAULT_PORT;
  const host = nonEmptyString(process.env.HOST) ?? nonEmptyString(raw.host) ?? DEFAULT_HOST;
  const apiKeys = parseApiKeys(process.env.ANTIGRAVITY_GATEWAY_API_KEYS) ?? parseApiKeys(raw.apiKeys) ?? [];
  const authDirValue =
    nonEmptyString(process.env.ANTIGRAVITY_GATEWAY_AUTH_DIR) ?? nonEmptyString(raw.authDir) ?? DEFAULT_AUTH_DIR;
  const authDir = isAbsolute(authDirValue) ? authDirValue : resolve(appRoot, authDirValue);

  const providers = parseProviders(raw.providers, appRoot, authDir);
  const routes = parseRoutes(raw.routes);

  // If no providers are configured, create a default antigravity-oauth provider for backward compatibility
  if (Object.keys(providers).length === 0) {
    providers["antigravity-oauth"] = {
      type: "google-oauth",
      authDir
    };
  }

  return { port, host, apiKeys, authDir, providers, routes,
    disabledModels: Array.isArray(raw.disabledModels) ? raw.disabledModels.filter((m): m is string => typeof m === "string") : [] };
}

function readConfigFile(appRoot: string): RawConfig {
  let text: string;
  try {
    text = readFileSync(resolve(appRoot, "config.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  return JSON.parse(text) as RawConfig;
}

function parsePort(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const port = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return port;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function parseApiKeys(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    if (value === "") return undefined;
    return value
      .split(",")
      .map((key) => key.trim())
      .filter((key) => key !== "");
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value as string[];
  }
  return undefined;
}

function parseProviders(raw: unknown, appRoot: string, defaultAuthDir: string): Record<string, ProviderConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, ProviderConfig> = {};

  for (const [id, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const obj = value as Record<string, unknown>;
    const typeStr = nonEmptyString(obj.type);
    if (typeStr !== "openai" && typeStr !== "anthropic" && typeStr !== "google-oauth" && typeStr !== "codex-oauth") continue;

    const provider: ProviderConfig = {
      type: typeStr
    };

    if (nonEmptyString(obj.baseUrl)) provider.baseUrl = nonEmptyString(obj.baseUrl);
    if (nonEmptyString(obj.apiKey)) provider.apiKey = nonEmptyString(obj.apiKey);
    if (nonEmptyString(obj.apiKeyFile)) provider.apiKeyFile = resolveUserPath(nonEmptyString(obj.apiKeyFile)!, appRoot);
    if (nonEmptyString(obj.apiKeySettingsFile)) {
      provider.apiKeySettingsFile = resolveUserPath(nonEmptyString(obj.apiKeySettingsFile)!, appRoot);
    }
    if (obj.headers && typeof obj.headers === "object" && !Array.isArray(obj.headers)) {
      provider.headers = obj.headers as Record<string, string>;
    }
    if (Array.isArray(obj.models) && obj.models.every((m) => typeof m === "string")) {
      provider.models = obj.models as string[];
    }
    if (typeof obj.autoDiscoverModels === "boolean") {
      provider.autoDiscoverModels = obj.autoDiscoverModels;
    }
    if (typeof obj.geminiSchemaConstraints === "boolean") {
      provider.geminiSchemaConstraints = obj.geminiSchemaConstraints;
    }
    if (typeof obj.modelRefreshIntervalMs === "number" && obj.modelRefreshIntervalMs > 0) {
      provider.modelRefreshIntervalMs = obj.modelRefreshIntervalMs;
    }

    if (typeStr === "google-oauth") {
      const pAuthDir = nonEmptyString(obj.authDir) ?? defaultAuthDir;
      provider.authDir = isAbsolute(pAuthDir) ? pAuthDir : resolve(appRoot, pAuthDir);
    }
    if (typeStr === "codex-oauth") {
      const authFile = nonEmptyString(obj.authFile) ?? "~/.codex/auth.json";
      provider.authFile = resolveUserPath(authFile, appRoot);
      if (nonEmptyString(obj.clientVersion)) provider.clientVersion = nonEmptyString(obj.clientVersion);
      if (nonEmptyString(obj.originator)) provider.originator = nonEmptyString(obj.originator);
    }

    result[id] = provider;
  }

  return result;
}

function resolveUserPath(value: string, appRoot: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return isAbsolute(value) ? value : resolve(appRoot, value);
}

function parseRoutes(raw: unknown): RouteRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: RouteRule[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const provider = nonEmptyString(obj.provider);
    if (!provider) continue;

    const rule: RouteRule = { provider };

    if (typeof obj.match === "string") {
      rule.match = obj.match.trim();
    } else if (Array.isArray(obj.match) && obj.match.every((m) => typeof m === "string")) {
      rule.match = obj.match as string[];
    }

    if (nonEmptyString(obj.modelPrefix)) {
      rule.modelPrefix = nonEmptyString(obj.modelPrefix);
    }
    if (typeof obj.stripPrefix === "boolean") {
      rule.stripPrefix = obj.stripPrefix;
    }
    if (nonEmptyString(obj.targetModel)) {
      rule.targetModel = nonEmptyString(obj.targetModel);
    }

    rules.push(rule);
  }

  return rules;
}
