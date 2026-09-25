import type { ModelInfo } from "../translate/models";
import type { AnthropicRequestBody, OpenAiRequestBody, ResponsesRequestBody } from "../translate/types";

export interface Provider {
  readonly id: string;
  readonly type: "openai" | "anthropic" | "google-oauth" | "codex-oauth";
  getModels(): Promise<ModelInfo[]>;
  handleMessages(body: AnthropicRequestBody, req: Request, targetModel: string): Promise<Response>;
  handleChatCompletions(body: OpenAiRequestBody, req: Request, targetModel: string): Promise<Response>;
  handleResponses?(body: ResponsesRequestBody, req: Request, targetModel: string, path: "/responses" | "/responses/compact"): Promise<Response>;
}
