// Shared Gemini protocol types plus minimal Anthropic/OpenAI wire types.
// Field names mirror the Go reference (CLIProxyAPI internal/translator/gemini)
// exactly, including the snake_case/camelCase mix the upstream accepts.

// ---------------------------------------------------------------------------
// Gemini side
// ---------------------------------------------------------------------------

export interface GeminiInlineData {
  mimeType?: string;
  mime_type?: string;
  data: string;
}

export interface GeminiFunctionCall {
  name: string;
  args?: unknown;
}

export interface GeminiFunctionResponse {
  name: string;
  response: { result: unknown };
}

export interface GeminiPart {
  text?: string;
  inlineData?: GeminiInlineData;
  inline_data?: GeminiInlineData;
  functionCall?: GeminiFunctionCall;
  functionResponse?: GeminiFunctionResponse;
  thought?: boolean;
  thoughtSignature?: string;
  thought_signature?: string;
}

export interface GeminiContent {
  // Optional because the string-form systemInstruction is emitted without a
  // role (Gemini defaults it to "system").
  role?: string;
  parts: GeminiPart[];
}

export interface GeminiThinkingConfig {
  thinkingBudget?: number;
  thinkingLevel?: string;
}

export interface GeminiGenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  candidateCount?: number;
  responseMimeType?: string;
  responseJsonSchema?: unknown;
  responseSchema?: unknown;
  responseModalities?: string[];
  imageConfig?: { aspectRatio?: string; imageSize?: string };
  thinkingConfig?: GeminiThinkingConfig;
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parametersJsonSchema?: unknown;
}

export interface GeminiTool {
  functionDeclarations?: GeminiFunctionDeclaration[];
  googleSearch?: unknown;
  codeExecution?: unknown;
  urlContext?: unknown;
}

export interface GeminiSafetySetting {
  category: string;
  threshold: string;
}

export interface GeminiToolConfig {
  functionCallingConfig?: {
    mode?: string;
    allowedFunctionNames?: string[];
  };
}

export interface GeminiRequestBody {
  model?: string;
  contents: GeminiContent[];
  systemInstruction?: GeminiContent;
  generationConfig?: GeminiGenerationConfig;
  tools?: GeminiTool[];
  toolConfig?: GeminiToolConfig;
  safetySettings?: GeminiSafetySetting[];
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

export interface GeminiCandidate {
  index?: number;
  content?: { role?: string; parts?: GeminiPart[] };
  finishReason?: string;
}

export interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
  responseId?: string;
  createTime?: string;
}

// ---------------------------------------------------------------------------
// Anthropic side (minimal wire shape)
// ---------------------------------------------------------------------------

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicImageBlock {
  type: "image";
  source: { type: string; media_type?: string; data?: string };
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicImageBlock
  | AnthropicToolResultBlock
  | { type: string; [key: string]: unknown };

export interface AnthropicMessage {
  role: "user" | "assistant" | "system";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: unknown;
  [key: string]: unknown;
}

export interface AnthropicRequestBody {
  model?: string;
  system?: string | Array<{ type: string; text?: string }>;
  messages?: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: unknown;
  thinking?: { type?: string; budget_tokens?: number };
  output_config?: { effort?: string };
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

export interface AnthropicResponseMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Array<Record<string, unknown>>;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage?: { input_tokens: number; output_tokens: number };
}

// ---------------------------------------------------------------------------
// OpenAI side (minimal wire shape)
// ---------------------------------------------------------------------------

export interface OpenAiChatMessage {
  role: string;
  content?: unknown;
  reasoning_content?: string;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
    [key: string]: unknown;
  }>;
  tool_call_id?: string;
  [key: string]: unknown;
}

export interface OpenAiTool {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: unknown;
    strict?: boolean;
    [key: string]: unknown;
  };
  google_search?: unknown;
  code_execution?: unknown;
  url_context?: unknown;
  [key: string]: unknown;
}

export interface OpenAiRequestBody {
  model?: string;
  messages?: OpenAiChatMessage[];
  tools?: OpenAiTool[];
  reasoning_effort?: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  n?: number;
  response_format?: { type?: string; json_schema?: { schema?: unknown; [key: string]: unknown } };
  modalities?: string[];
  image_config?: { aspect_ratio?: string; image_size?: string };
  generationConfig?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// OpenAI Responses side (shared by API and Codex subscription transports)
// ---------------------------------------------------------------------------

export interface ResponsesRequestBody {
  model?: string;
  input?: unknown;
  instructions?: string;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  reasoning?: Record<string, unknown>;
  text?: Record<string, unknown>;
  include?: string[];
  max_output_tokens?: number;
  parallel_tool_calls?: boolean;
  store?: boolean;
  stream?: boolean;
  [key: string]: unknown;
}
