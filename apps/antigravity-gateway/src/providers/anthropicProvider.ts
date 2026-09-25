import type { Provider } from "./types";
import { readFileSync } from "node:fs";
import type { ModelInfo } from "../translate/models";
import type { AnthropicRequestBody, AnthropicTool, OpenAiRequestBody } from "../translate/types";
import { openAiToAnthropicRequest, anthropicToOpenAiResponse, AnthropicToOpenAiSseTranslator } from "../translate/openaiToAnthropic";
import { SSE_RESPONSE_HEADERS, normalizeAnthropicSse, translateUpstreamSse } from "../upstream/sse";
import { sanitizeSchema } from "../translate/common";
import { errorResponse, jsonResponse } from "../server/http";

export interface AnthropicProviderOptions {
  id: string;
  baseUrl?: string;
  apiKey?: string;
  /** Read the upstream token from a local file, without putting it in config or logs. */
  apiKeyFile?: string;
  /** Read ANTHROPIC_AUTH_TOKEN from a Claude settings JSON file. */
  apiKeySettingsFile?: string;
  headers?: Record<string, string>;
  models?: string[];
  autoDiscoverModels?: boolean;
  modelRefreshIntervalMs?: number;
  /** Upstream validates tool schemas with Gemini's rules; see ProviderConfig. */
  geminiSchemaConstraints?: boolean;
  fetch?: typeof fetch;
}

export class AnthropicProvider implements Provider {
  readonly id: string;
  readonly type = "anthropic" as const;
  private baseUrl: string;
  private apiKey?: string;
  private apiKeyFile?: string;
  private apiKeySettingsFile?: string;
  private customHeaders: Record<string, string>;
  private staticModels: string[];
  private autoDiscover: boolean;
  private refreshIntervalMs: number;
  private geminiSchemaConstraints: boolean;
  private fetchImpl: typeof fetch;

  private discoveredModels: ModelInfo[] = [];
  private lastDiscoveredTime = 0;

  constructor(options: AnthropicProviderOptions) {
    this.id = options.id;
    this.baseUrl = (options.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.apiKeyFile = options.apiKeyFile;
    this.apiKeySettingsFile = options.apiKeySettingsFile;
    this.customHeaders = options.headers || {};
    this.staticModels = options.models || [];
    this.autoDiscover = options.autoDiscoverModels === true;
    this.refreshIntervalMs = options.modelRefreshIntervalMs || 3600_000;
    this.geminiSchemaConstraints = options.geminiSchemaConstraints === true;
    this.fetchImpl = options.fetch || globalThis.fetch;
  }

  async getModels(): Promise<ModelInfo[]> {
    const list: ModelInfo[] = [];
    const seen = new Set<string>();

    // 1. Static models configured manually
    for (const m of this.staticModels) {
      seen.add(m);
      list.push({
        id: m,
        display_name: m,
        context_length: 200_000,
        max_completion_tokens: 8_192
      });
    }

    // 2. Auto-discovered models from upstream if enabled
    if (this.autoDiscover) {
      await this.ensureDiscoveredModels();
      for (const m of this.discoveredModels) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          list.push(m);
        }
      }
    }

    return list;
  }

  async handleMessages(
    body: AnthropicRequestBody,
    req: Request,
    targetModel: string
  ): Promise<Response> {
    const url = this.resolveUrl("/v1/messages");
    const headers = this.buildHeaders(req);
    const forwardBody = { ...body, model: targetModel };
    const tools = this.sanitizeToolSchemas(forwardBody.tools);
    if (tools) forwardBody.tools = tools;

    const upstream = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(forwardBody),
      signal: req.signal
    });

    if (upstream.status >= 400) {
      return this.upstreamError(upstream);
    }

    const contentType = upstream.headers.get("content-type") || "";
    if (body.stream === true || contentType.includes("text/event-stream")) {
      const stream = upstream.body ? normalizeAnthropicSse(upstream.body) : null;
      return new Response(stream, {
        status: upstream.status,
        headers: SSE_RESPONSE_HEADERS
      });
    }

    const respJson = await upstream.json();
    return jsonResponse(respJson, { status: upstream.status });
  }

  async handleChatCompletions(
    body: OpenAiRequestBody,
    req: Request,
    targetModel: string
  ): Promise<Response> {
    const url = this.resolveUrl("/v1/messages");
    const anthropicBody = openAiToAnthropicRequest(body, targetModel);
    const tools = this.sanitizeToolSchemas(anthropicBody.tools);
    if (tools) anthropicBody.tools = tools;
    const headers = this.buildHeaders(req);
    const stream = body.stream === true;

    const upstream = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(anthropicBody),
      signal: req.signal
    });

    if (upstream.status >= 400) {
      return this.upstreamError(upstream);
    }

    if (stream && upstream.body) {
      const translator = new AnthropicToOpenAiSseTranslator(targetModel);
      const translated = translateUpstreamSse(
        upstream.body,
        (data) => translator.feed(data),
        () => translator.finish()
      );
      return new Response(translated, {
        status: upstream.status,
        headers: SSE_RESPONSE_HEADERS
      });
    }

    const json = (await upstream.json()) as Record<string, unknown>;
    const openAiResponse = anthropicToOpenAiResponse(json, targetModel);
    return jsonResponse(openAiResponse, { status: upstream.status });
  }

  // Tool schemas reach a Gemini-backed relay unchanged otherwise, and Gemini
  // rejects constructs the Anthropic wire format allows — a `prefixItems`-only
  // array fails as "items: missing field". Returns undefined when there is
  // nothing to rewrite, so the caller leaves the body untouched.
  private sanitizeToolSchemas(tools: AnthropicTool[] | undefined): AnthropicTool[] | undefined {
    if (!this.geminiSchemaConstraints || !Array.isArray(tools) || tools.length === 0) {
      return undefined;
    }
    return tools.map((tool) => ({
      ...tool,
      input_schema: sanitizeSchema(tool.input_schema) as AnthropicTool["input_schema"]
    }));
  }

  private resolveUrl(path: string): string {
    if (this.baseUrl.endsWith("/v1")) {
      const cleanPath = path.startsWith("/v1/") ? path.slice(3) : path;
      return `${this.baseUrl}${cleanPath}`;
    }
    return `${this.baseUrl}${path}`;
  }

  private buildHeaders(req: Request): Headers {
    const headers = new Headers();
    headers.set("Content-Type", "application/json");

    // Copy client anthropic headers if present
    const anthropicVersion = req.headers.get("anthropic-version") || "2023-06-01";
    headers.set("anthropic-version", anthropicVersion);

    const anthropicBeta = req.headers.get("anthropic-beta");
    if (anthropicBeta) headers.set("anthropic-beta", anthropicBeta);

    // Apply API Key
    const apiKey = this.getApiKey();
    if (apiKey) {
      headers.set("x-api-key", apiKey);
      headers.set("Authorization", `Bearer ${apiKey}`);
    }

    // Apply custom headers
    for (const [k, v] of Object.entries(this.customHeaders)) {
      headers.set(k, v);
    }

    return headers;
  }

  private async ensureDiscoveredModels(): Promise<void> {
    const now = Date.now();
    if (this.discoveredModels.length > 0 && now - this.lastDiscoveredTime < this.refreshIntervalMs) {
      return;
    }

    try {
      const url = this.resolveUrl("/v1/models");
      const headers = new Headers();
      const apiKey = this.getApiKey();
      if (apiKey) {
        headers.set("x-api-key", apiKey);
        headers.set("Authorization", `Bearer ${apiKey}`);
      }
      headers.set("anthropic-version", "2023-06-01");
      for (const [k, v] of Object.entries(this.customHeaders)) {
        headers.set(k, v);
      }

      const res = await this.fetchImpl(url, { headers });
      if (!res.ok) return;

      const data = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
      if (Array.isArray(data.data)) {
        this.discoveredModels = data.data.map((item) => ({
          id: item.id,
          display_name: item.display_name || item.id,
          context_length: 200_000,
          max_completion_tokens: 8_192
        }));
        this.lastDiscoveredTime = now;
      }
    } catch {
      // Keep previous cache on error
    }
  }

  private getApiKey(): string | undefined {
    if (this.apiKey) return this.apiKey;
    if (this.apiKeyFile) {
      try {
        const token = readFileSync(this.apiKeyFile, "utf8").trim();
        if (token) return token;
      } catch {
        // Continue to the optional settings-file source.
      }
    }
    if (this.apiKeySettingsFile) {
      try {
        const settings = JSON.parse(readFileSync(this.apiKeySettingsFile, "utf8")) as {
          env?: { ANTHROPIC_AUTH_TOKEN?: unknown };
        };
        const token = settings.env?.ANTHROPIC_AUTH_TOKEN;
        if (typeof token === "string" && token.trim() !== "") return token.trim();
      } catch {
        // An absent/unreadable token is handled by the upstream as an auth failure.
      }
    }
    return undefined;
  }

  private async upstreamError(upstream: Response): Promise<Response> {
    const text = await upstream.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: { message: text } };
    }
    const status = upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
    return jsonResponse(parsed, { status });
  }
}
