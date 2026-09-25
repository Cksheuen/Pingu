import type { Provider } from "./types";
import type { CredentialPool } from "../oauth/credentialPool";
import type { Credential } from "../oauth/credentials";
import type { ModelInfo } from "../translate/models";
import { MODEL_CATALOG } from "../translate/models";
import type { AnthropicRequestBody, GeminiRequestBody, OpenAiRequestBody } from "../translate/types";
import { claudeMessagesToGemini } from "../translate/claudeRequest";
import { ClaudeSseTranslator, claudeNonStream } from "../translate/claudeResponse";
import { openaiChatToGemini } from "../translate/openaiRequest";
import { OpenAiSseTranslator, openAiNonStream } from "../translate/openaiResponse";
import { callUpstream } from "../upstream/client";
import { wrapAntigravityEnvelope } from "../upstream/envelope";
import { SSE_RESPONSE_HEADERS, translateUpstreamSse } from "../upstream/sse";
import { errorResponse, jsonResponse } from "../server/http";

const NO_CREDENTIALS_MESSAGE = 'no antigravity credentials; run "pnpm login:antigravity-gateway" first';

export interface GoogleOAuthProviderOptions {
  id: string;
  pool?: CredentialPool;
  configuredModels?: string[];
  fetch?: typeof fetch;
}

export class GoogleOAuthProvider implements Provider {
  readonly id: string;
  readonly type = "google-oauth" as const;
  private pool?: CredentialPool;
  private configuredModels?: string[];
  private fetchImpl?: typeof fetch;

  constructor(options: GoogleOAuthProviderOptions) {
    this.id = options.id;
    this.pool = options.pool;
    this.configuredModels = options.configuredModels;
    this.fetchImpl = options.fetch;
  }

  async getModels(): Promise<ModelInfo[]> {
    if (this.configuredModels && this.configuredModels.length > 0) {
      return this.configuredModels.map((id) => {
        const found = MODEL_CATALOG.find((m) => m.id === id);
        return (
          found ?? {
            id,
            display_name: id,
            context_length: 1_048_576,
            max_completion_tokens: 65_536
          }
        );
      });
    }
    return MODEL_CATALOG;
  }

  async handleMessages(
    body: AnthropicRequestBody,
    req: Request,
    targetModel: string
  ): Promise<Response> {
    if (!this.pool || this.pool.size === 0) {
      return errorResponse(503, "api_error", NO_CREDENTIALS_MESSAGE);
    }

    const modifiedBody = { ...body, model: targetModel };
    const geminiBody = claudeMessagesToGemini(modifiedBody);
    const stream = body.stream === true;
    const upstream = await this.forwardUpstream(targetModel, geminiBody, stream, req.signal);
    if (upstream.status >= 400) return this.upstreamHttpErrorResponse(upstream);

    if (stream && upstream.body) {
      const translator = new ClaudeSseTranslator(modifiedBody);
      const translated = translateUpstreamSse(
        upstream.body,
        (data) => translator.feed(data),
        () => translator.finish()
      );
      return new Response(translated, { status: upstream.status, headers: SSE_RESPONSE_HEADERS });
    }
    const message = claudeNonStream(await upstream.text(), targetModel);
    return jsonResponse(message, { status: upstream.status });
  }

  async handleChatCompletions(
    body: OpenAiRequestBody,
    req: Request,
    targetModel: string
  ): Promise<Response> {
    if (!this.pool || this.pool.size === 0) {
      return errorResponse(503, "api_error", NO_CREDENTIALS_MESSAGE);
    }

    const modifiedBody = { ...body, model: targetModel };
    const geminiBody = openaiChatToGemini(modifiedBody);
    const stream = body.stream === true;
    const upstream = await this.forwardUpstream(targetModel, geminiBody, stream, req.signal);
    if (upstream.status >= 400) return this.upstreamHttpErrorResponse(upstream);

    if (stream && upstream.body) {
      const translator = new OpenAiSseTranslator();
      const translated = translateUpstreamSse(
        upstream.body,
        (data) => translator.feed(data),
        () => translator.finish()
      );
      return new Response(translated, { status: upstream.status, headers: SSE_RESPONSE_HEADERS });
    }
    const completion = openAiNonStream(await upstream.text(), targetModel);
    return jsonResponse(completion, { status: upstream.status });
  }

  private async forwardUpstream(
    model: string,
    geminiBody: GeminiRequestBody,
    stream: boolean,
    signal: AbortSignal | null
  ): Promise<Response> {
    if (!this.pool) return errorResponse(503, "api_error", NO_CREDENTIALS_MESSAGE);

    for (const candidate of this.pool.list()) {
      const cred: Credential | null = await this.pool.ensureFresh(candidate);
      if (!cred) continue;
      const envelope = wrapAntigravityEnvelope(model, geminiBody, cred.project_id);
      const upstream = await callUpstream({
        accessToken: cred.access_token,
        body: envelope,
        stream,
        signal: signal ?? undefined,
        fetch: this.fetchImpl
      });
      if (upstream.status === 401) {
        this.pool.invalidate(cred);
        continue;
      }
      return upstream;
    }
    return errorResponse(503, "api_error", "all antigravity credentials were rejected; run login again");
  }

  private async upstreamHttpErrorResponse(upstream: Response): Promise<Response> {
    const detail = (await upstream.text()).slice(0, 500);
    const status = upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
    return errorResponse(status, "api_error", `antigravity upstream error: ${detail}`);
  }
}
