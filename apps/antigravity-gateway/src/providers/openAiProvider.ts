import type { Provider } from "./types";
import type { ModelInfo } from "../translate/models";
import type { AnthropicRequestBody, OpenAiRequestBody } from "../translate/types";
import { anthropicToOpenAiRequest, openAiToAnthropicResponse, OpenAiToAnthropicSseTranslator } from "../translate/anthropicToOpenai";
import { SSE_RESPONSE_HEADERS, translateUpstreamSse } from "../upstream/sse";
import { errorResponse, jsonResponse } from "../server/http";

export interface OpenAiProviderOptions {
  id: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models?: string[];
  autoDiscoverModels?: boolean;
  modelRefreshIntervalMs?: number;
  fetch?: typeof fetch;
}

export class OpenAiProvider implements Provider {
  readonly id: string;
  readonly type = "openai" as const;
  private baseUrl: string;
  private apiKey?: string;
  private customHeaders: Record<string, string>;
  private staticModels: string[];
  private autoDiscover: boolean;
  private refreshIntervalMs: number;
  private fetchImpl: typeof fetch;

  private discoveredModels: ModelInfo[] = [];
  private lastDiscoveredTime = 0;

  constructor(options: OpenAiProviderOptions) {
    this.id = options.id;
    this.baseUrl = (options.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.customHeaders = options.headers || {};
    this.staticModels = options.models || [];
    this.autoDiscover = options.autoDiscoverModels === true;
    this.refreshIntervalMs = options.modelRefreshIntervalMs || 3600_000;
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
        context_length: 128_000,
        max_completion_tokens: 16_384
      });
    }

    // 2. Auto-discovered models from upstream
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

  async handleChatCompletions(
    body: OpenAiRequestBody,
    req: Request,
    targetModel: string
  ): Promise<Response> {
    const url = this.resolveUrl("/chat/completions");
    const headers = this.buildHeaders();
    const forwardBody = { ...body, model: targetModel };

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
      return new Response(upstream.body, {
        status: upstream.status,
        headers: SSE_RESPONSE_HEADERS
      });
    }

    const respJson = await upstream.json();
    return jsonResponse(respJson, { status: upstream.status });
  }

  async handleMessages(
    body: AnthropicRequestBody,
    req: Request,
    targetModel: string
  ): Promise<Response> {
    const url = this.resolveUrl("/chat/completions");
    const openAiBody = anthropicToOpenAiRequest(body, targetModel);
    const headers = this.buildHeaders();
    const stream = body.stream === true;

    const upstream = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(openAiBody),
      signal: req.signal
    });

    if (upstream.status >= 400) {
      return this.upstreamError(upstream);
    }

    if (stream && upstream.body) {
      const translator = new OpenAiToAnthropicSseTranslator(targetModel);
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
    const anthropicResponse = openAiToAnthropicResponse(json, targetModel);
    return jsonResponse(anthropicResponse, { status: upstream.status });
  }

  private resolveUrl(path: string): string {
    if (this.baseUrl.endsWith("/v1")) {
      const cleanPath = path.startsWith("/v1/") ? path.slice(3) : path;
      return `${this.baseUrl}${cleanPath}`;
    }
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    return `${this.baseUrl}${cleanPath}`;
  }

  private buildHeaders(): Headers {
    const headers = new Headers();
    headers.set("Content-Type", "application/json");

    if (this.apiKey) {
      headers.set("Authorization", `Bearer ${this.apiKey}`);
    }

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
      const url = this.resolveUrl("/models");
      const headers = new Headers();
      if (this.apiKey) {
        headers.set("Authorization", `Bearer ${this.apiKey}`);
      }
      for (const [k, v] of Object.entries(this.customHeaders)) {
        headers.set(k, v);
      }

      const res = await this.fetchImpl(url, { headers });
      if (!res.ok) return;

      const data = (await res.json()) as { data?: Array<{ id: string }> };
      if (Array.isArray(data.data)) {
        this.discoveredModels = data.data.map((item) => ({
          id: item.id,
          display_name: item.id,
          context_length: 128_000,
          max_completion_tokens: 16_384
        }));
        this.lastDiscoveredTime = now;
      }
    } catch {
      // Keep previous cache on error
    }
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
