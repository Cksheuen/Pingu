import type { AppConfig } from "../config/config";
import type { CredentialPool } from "../oauth/credentialPool";
import { checkApiKey } from "./apiKeyAuth";
import { errorResponse, HttpError, jsonResponse, readJson } from "./http";
import { route } from "./router";
import type { AnthropicRequestBody, OpenAiRequestBody, ResponsesRequestBody } from "../translate/types";
import { UpstreamError } from "../upstream/client";
import { Dispatcher } from "../routing/dispatcher";

export interface CreateWorkerOptions {
  config: AppConfig;
  // Credential pool loaded at startup from config.authDir. When absent or
  // empty, Google OAuth endpoints answer 503 with a login hint.
  pool?: CredentialPool;
  // Test hook: replace the upstream fetch implementation.
  fetch?: typeof fetch;
}

export interface Worker {
  fetch(request: Request): Promise<Response>;
}

export function createWorker(options: CreateWorkerOptions): Worker {
  const { config, pool, fetch: upstreamFetch } = options;
  const dispatcher = new Dispatcher({
    config,
    pool,
    fetch: upstreamFetch
  });

  async function handleMessages(request: Request): Promise<Response> {
    let body: AnthropicRequestBody;
    try {
      body = await readJson<AnthropicRequestBody>(request);
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error.status, error.type, error.message);
      throw error;
    }

    if (!body.model) return errorResponse(400, "invalid_request_error", "model is required");

    const resolved = await dispatcher.resolveRoute(body.model);
    if (!resolved) {
      return errorResponse(404, "not_found_error", `no upstream provider configured for model '${body.model}'`);
    }

    return resolved.provider.handleMessages(body, request, resolved.targetModel);
  }

  async function handleChatCompletions(request: Request): Promise<Response> {
    let body: OpenAiRequestBody;
    try {
      body = await readJson<OpenAiRequestBody>(request);
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error.status, error.type, error.message);
      throw error;
    }

    if (!body.model) return errorResponse(400, "invalid_request_error", "model is required");

    const resolved = await dispatcher.resolveRoute(body.model);
    if (!resolved) {
      return errorResponse(404, "not_found_error", `no upstream provider configured for model '${body.model}'`);
    }

    return resolved.provider.handleChatCompletions(body, request, resolved.targetModel);
  }

  async function handleResponses(
    request: Request,
    path: "/responses" | "/responses/compact"
  ): Promise<Response> {
    let body: ResponsesRequestBody;
    try {
      body = await readJson<ResponsesRequestBody>(request);
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error.status, error.type, error.message);
      throw error;
    }

    if (!body.model) return errorResponse(400, "invalid_request_error", "model is required");

    const resolved = await dispatcher.resolveRoute(body.model);
    if (!resolved) {
      return errorResponse(404, "not_found_error", `no upstream provider configured for model '${body.model}'`);
    }
    if (!resolved.provider.handleResponses) {
      return errorResponse(
        501,
        "unsupported_provider_error",
        `provider '${resolved.provider.id}' does not support the Responses protocol`
      );
    }
    return resolved.provider.handleResponses(body, request, resolved.targetModel, path);
  }

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const match = route(request.method, url.pathname);
      if (!match) {
        return errorResponse(404, "not_found_error", `no route for ${request.method} ${url.pathname}`);
      }

      if (match.name === "healthz") {
        return jsonResponse({ status: "ok" });
      }

      if (!checkApiKey(request, config.apiKeys)) {
        return errorResponse(401, "authentication_error", "invalid api key");
      }

      try {
        switch (match.name) {
          case "models": {
            const models = await dispatcher.getAggregatedModels();
            // OpenAI-compatible clients consume `data`; the Codex ChatGPT
            // Responses client consumes the subscription-native `models`.
            const subscriptionModels = models.map((model) => ({
              slug: model.id,
              display_name: model.display_name,
              description: model.description ?? null,
              base_instructions: model.base_instructions ?? "",
              context_window: model.context_length,
              max_context_window: model.max_context_window ?? model.context_length,
              visibility: model.visibility ?? "list",
              shell_type: model.shell_type ?? "shell_command",
              supported_in_api: model.supported_in_api ?? true,
              priority: model.priority ?? 99,
              supported_reasoning_levels: model.supported_reasoning_levels ?? [],
              availability_nux: null,
              upgrade: null,
              support_verbosity: model.support_verbosity ?? false,
              default_verbosity: model.default_verbosity ?? null,
              apply_patch_tool_type: model.apply_patch_tool_type ?? null,
              web_search_tool_type: model.web_search_tool_type ?? "text",
              truncation_policy: model.truncation_policy ?? { mode: "tokens", limit: 10_000 },
              supports_image_detail_original: model.supports_image_detail_original ?? false,
              experimental_supported_tools: model.experimental_supported_tools ?? [],
              input_modalities: model.input_modalities ?? ["text"],
              supports_parallel_tool_calls: model.supports_parallel_tool_calls ?? true,
              ...(model.default_reasoning_level ? { default_reasoning_level: model.default_reasoning_level } : {}),
              ...(model.use_responses_lite !== undefined ? { use_responses_lite: model.use_responses_lite } : {})
            }));
            return jsonResponse({ object: "list", data: models, models: subscriptionModels });
          }
          case "messages":
            return await handleMessages(request);
          case "chat-completions":
            return await handleChatCompletions(request);
          case "responses":
            return await handleResponses(request, "/responses");
          case "responses-compact":
            return await handleResponses(request, "/responses/compact");
          default:
            return errorResponse(404, "not_found_error", `unknown route ${match.name}`);
        }
      } catch (error) {
        return upstreamErrorResponse(error);
      }
    }
  };
}

function upstreamErrorResponse(error: unknown): Response {
  if (error instanceof UpstreamError) {
    return errorResponse(502, "api_error", `upstream ${error.status}: ${error.upstreamBody.slice(0, 500)}`);
  }
  if (error instanceof HttpError) {
    return errorResponse(error.status, error.type, error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  return errorResponse(502, "api_error", `upstream request failed: ${message}`);
}
