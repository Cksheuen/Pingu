import type { Provider } from "./types";
import type { ModelInfo } from "../translate/models";
import type { AnthropicRequestBody, OpenAiRequestBody, ResponsesRequestBody } from "../translate/types";
import { CodexAuthManager } from "../oauth/codexAuth";
import {
  anthropicToResponsesRequest,
  ResponsesToAnthropicSseTranslator,
  responsesToAnthropicResponse
} from "../translate/anthropicToResponses";
import { errorResponse, jsonResponse } from "../server/http";
import { SSE_RESPONSE_HEADERS, translateUpstreamSse } from "../upstream/sse";

export interface CodexOAuthProviderOptions {
  id: string;
  authFile: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  models?: string[];
  autoDiscoverModels?: boolean;
  modelRefreshIntervalMs?: number;
  clientVersion?: string;
  originator?: string;
  fetch?: typeof fetch;
}

export class CodexOAuthProvider implements Provider {
  readonly id: string;
  readonly type = "codex-oauth" as const;
  private readonly baseUrl: string;
  private readonly customHeaders: Record<string, string>;
  private readonly staticModels: string[];
  private readonly autoDiscover: boolean;
  private readonly refreshIntervalMs: number;
  private readonly clientVersion: string;
  private readonly originator: string;
  private readonly auth: CodexAuthManager;
  private readonly fetchImpl: typeof fetch;
  private discoveredModels: ModelInfo[] = [];
  private lastDiscoveredTime = 0;

  constructor(options: CodexOAuthProviderOptions) {
    this.id = options.id;
    this.baseUrl = (options.baseUrl || "https://chatgpt.com/backend-api/codex").replace(/\/+$/, "");
    this.customHeaders = options.headers || {};
    this.staticModels = options.models || [];
    this.autoDiscover = options.autoDiscoverModels !== false;
    this.refreshIntervalMs = options.modelRefreshIntervalMs || 3600_000;
    this.clientVersion = options.clientVersion || "0.147.0";
    this.originator = options.originator || "codex_cli_rs";
    this.fetchImpl = options.fetch || globalThis.fetch;
    this.auth = new CodexAuthManager(options.authFile, this.fetchImpl);
  }

  async getModels(): Promise<ModelInfo[]> {
    const list: ModelInfo[] = [];
    const seen = new Set<string>();
    for (const id of this.staticModels) {
      seen.add(id);
      list.push({ id, display_name: id, context_length: 128_000, max_completion_tokens: 16_384 });
    }

    if (this.autoDiscover) {
      await this.ensureDiscoveredModels();
      for (const model of this.discoveredModels) {
        if (!seen.has(model.id)) {
          seen.add(model.id);
          list.push(model);
        }
      }
    }
    return list;
  }

  async handleMessages(body: AnthropicRequestBody, req: Request, targetModel: string): Promise<Response> {
    const responsesBody = anthropicToResponsesRequest(body, targetModel);
    // The ChatGPT Codex backend currently rejects max_output_tokens on its
    // subscription route; Codex itself relies on the backend/model defaults.
    delete responsesBody.max_output_tokens;
    const upstream = await this.forward("/responses", responsesBody, req);
    if (upstream.status >= 400) return this.upstreamError(upstream);

    if (body.stream === true && upstream.body) {
      const translator = new ResponsesToAnthropicSseTranslator(targetModel);
      const stream = translateUpstreamSse(upstream.body, (data) => translator.feed(data), () => translator.finish());
      return new Response(stream, { status: upstream.status, headers: SSE_RESPONSE_HEADERS });
    }

    const payload = (await upstream.json()) as Record<string, unknown>;
    return jsonResponse(responsesToAnthropicResponse(payload, targetModel), { status: upstream.status });
  }

  async handleChatCompletions(_body: OpenAiRequestBody, _req: Request, _targetModel: string): Promise<Response> {
    return errorResponse(
      501,
      "unsupported_protocol_error",
      "codex-oauth uses the Responses protocol; use /v1/responses or Claude Code's /v1/messages"
    );
  }

  async handleResponses(
    body: ResponsesRequestBody,
    req: Request,
    targetModel: string,
    path: "/responses" | "/responses/compact"
  ): Promise<Response> {
    const forwarded = { ...body, model: targetModel };
    const upstream = await this.forward(path, forwarded, req);
    if (upstream.status >= 400) return this.upstreamError(upstream);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers
    });
  }

  private async forward(path: string, body: ResponsesRequestBody, request: Request): Promise<Response> {
    const headers = this.forwardedHeaders(request);
    headers.set("Content-Type", "application/json");
    headers.set("Accept", body.stream === true ? "text/event-stream" : "application/json");
    headers.set("originator", this.originator);
    const url = `${this.baseUrl}${path}`;
    const authHeaders = await this.auth.getAuthHeaders();
    headers.set("Authorization", `Bearer ${authHeaders.accessToken}`);
    headers.set("ChatGPT-Account-ID", authHeaders.accountId);
    let response = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: request.signal
    });
    if (response.status === 401) {
      const refreshed = await this.auth.getAuthHeaders(true);
      headers.set("Authorization", `Bearer ${refreshed.accessToken}`);
      headers.set("ChatGPT-Account-ID", refreshed.accountId);
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: request.signal
      });
    }
    return response;
  }

  private async ensureDiscoveredModels(): Promise<void> {
    const now = Date.now();
    if (this.discoveredModels.length > 0 && now - this.lastDiscoveredTime < this.refreshIntervalMs) return;
    const url = `${this.baseUrl}/models?client_version=${encodeURIComponent(this.clientVersion)}`;
    const headers = this.forwardedHeaders(undefined);
    headers.set("Accept", "application/json");
    headers.set("originator", this.originator);
    const authHeaders = await this.auth.getAuthHeaders();
    headers.set("Authorization", `Bearer ${authHeaders.accessToken}`);
    headers.set("ChatGPT-Account-ID", authHeaders.accountId);
    let response = await this.fetchImpl(url, { headers });
    if (response.status === 401) {
      const refreshed = await this.auth.getAuthHeaders(true);
      headers.set("Authorization", `Bearer ${refreshed.accessToken}`);
      response = await this.fetchImpl(url, { headers });
    }
    if (!response.ok) return;
    const payload = (await response.json()) as { models?: Array<Record<string, unknown>> };
    if (!Array.isArray(payload.models)) return;
    this.discoveredModels = payload.models
      .filter((model) => typeof model.slug === "string" && model.visibility !== "hide")
      .map((model) => ({
        id: model.slug as string,
        display_name: typeof model.display_name === "string" ? model.display_name : model.slug as string,
        context_length: numberValue(model.context_window) || 128_000,
        max_completion_tokens: numberValue(model.max_output_tokens) || 16_384,
        max_context_window: numberValue(model.max_context_window) || numberValue(model.context_window) || 128_000,
        description: typeof model.description === "string" ? model.description : null,
        base_instructions: stringValue(model.base_instructions) || "",
        supported_reasoning_levels: reasoningLevels(model.supported_reasoning_levels),
        default_reasoning_level: stringValue(model.default_reasoning_level),
        use_responses_lite: model.use_responses_lite === true,
        visibility: typeof model.visibility === "string" ? model.visibility : "list",
        shell_type: stringValue(model.shell_type) || "shell_command",
        supported_in_api: model.supported_in_api !== false,
        priority: numberValue(model.priority) || 99,
        support_verbosity: model.support_verbosity === true,
        default_verbosity: stringValue(model.default_verbosity) ?? null,
        apply_patch_tool_type: stringValue(model.apply_patch_tool_type) ?? null,
        web_search_tool_type: stringValue(model.web_search_tool_type) || "text",
        truncation_policy: objectPolicy(model.truncation_policy) || { mode: "tokens", limit: 10_000 },
        supports_image_detail_original: model.supports_image_detail_original === true,
        experimental_supported_tools: stringArray(model.experimental_supported_tools) || [],
        input_modalities: stringArray(model.input_modalities) || ["text"],
        supports_parallel_tool_calls: model.supports_parallel_tool_calls !== false
      }));
    this.lastDiscoveredTime = now;
  }

  private forwardedHeaders(request: Request | undefined): Headers {
    const headers = new Headers();
    const allowed = [
      "accept",
      "x-client-request-id",
      "session-id",
      "thread-id",
      "x-codex-beta-features",
      "x-codex-turn-metadata",
      "x-codex-window-id",
      "x-openai-internal-codex-responses-lite"
    ];
    for (const name of allowed) {
      const value = request?.headers.get(name);
      if (value) headers.set(name, value);
    }
    for (const [name, value] of Object.entries(this.customHeaders)) headers.set(name, value);
    return headers;
  }

  private async upstreamError(upstream: Response): Promise<Response> {
    const text = await upstream.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: { message: text.slice(0, 500) } };
    }
    return jsonResponse(payload, { status: upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502 });
  }
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function reasoningLevels(value: unknown): Array<{ effort: string; description?: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels = value.filter((item): item is { effort: string; description?: string } => {
    return typeof item === "object" && item !== null && typeof (item as { effort?: unknown }).effort === "string";
  });
  return levels.length > 0 ? levels : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string");
  return values.length > 0 ? values : undefined;
}

function objectPolicy(value: unknown): { mode: string; limit: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const policy = value as { mode?: unknown; limit?: unknown };
  return typeof policy.mode === "string" && typeof policy.limit === "number"
    ? { mode: policy.mode, limit: policy.limit }
    : undefined;
}
