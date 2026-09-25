// Gemini -> OpenAI Chat Completions response translation.
// Port of CLIProxyAPI internal/translator/gemini/openai/chat-completions/gemini_openai_response.go:
// - OpenAiSseTranslator: streaming chunks (data: {...}\n\n)
// - openAiNonStream: non-streaming aggregation

import type { GeminiPart, GeminiResponse } from "./types";

let functionCallIdCounter = 0;

interface OpenAiDelta {
  role: string | null;
  content: string | null;
  reasoning_content: string | null;
  tool_calls: Array<Record<string, unknown>> | null;
  images?: Array<Record<string, unknown>>;
}

interface OpenAiChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: OpenAiDelta;
    finish_reason: string | null;
    native_finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens: number };
    prompt_tokens_details?: { cached_tokens: number };
  };
}

function newChunk(model: string, created: number, id: string, candidateIndex: number): OpenAiChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: candidateIndex,
        delta: { role: null, content: null, reasoning_content: null, tool_calls: null },
        finish_reason: null,
        native_finish_reason: null
      }
    ]
  };
}

function applyUsage(chunk: OpenAiChunk, usage: NonNullable<GeminiResponse["usageMetadata"]>): void {
  const completionTokens = usage.candidatesTokenCount ?? 0;
  const promptTokens = usage.promptTokenCount ?? 0;
  const thoughtsTokens = usage.thoughtsTokenCount ?? 0;
  const cachedTokens = usage.cachedContentTokenCount ?? 0;

  chunk.usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens };
  if (usage.totalTokenCount !== undefined) chunk.usage.total_tokens = usage.totalTokenCount;
  if (thoughtsTokens > 0) chunk.usage.completion_tokens_details = { reasoning_tokens: thoughtsTokens };
  if (cachedTokens > 0) chunk.usage.prompt_tokens_details = { cached_tokens: cachedTokens };
}

function partInlineData(part: GeminiPart): { mimeType: string; data: string } | undefined {
  const inline = part.inlineData ?? part.inline_data;
  if (!inline) return undefined;
  const data = typeof inline.data === "string" ? inline.data : "";
  if (data === "") return undefined;
  let mimeType = typeof inline.mimeType === "string" ? inline.mimeType : "";
  if (mimeType === "") mimeType = typeof inline.mime_type === "string" ? inline.mime_type : "";
  if (mimeType === "") mimeType = "image/png";
  return { mimeType, data };
}

function parseCreateTime(createTime: string | undefined): number {
  if (!createTime) return 0;
  const parsed = Date.parse(createTime);
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

export class OpenAiSseTranslator {
  private readonly functionIndex = new Map<number, number>();
  private readonly sawToolCall = new Map<number, boolean>();
  private readonly upstreamFinishReason = new Map<number, string>();
  private created = 0;

  // Feed one upstream SSE data payload (the JSON string of a Gemini chunk,
  // optionally with a "data:" prefix). Returns zero or more OpenAI SSE chunk
  // strings ("data: {...}\n\n").
  feed(chunkJson: string): string[] {
    let raw = chunkJson.trim();
    if (raw.startsWith("data:")) raw = raw.slice(5).trim();
    if (raw === "[DONE]") return [];

    const chunk = JSON.parse(raw) as GeminiResponse;
    const model = typeof chunk.modelVersion === "string" ? chunk.modelVersion : "model";
    if (chunk.createTime) {
      const parsed = parseCreateTime(chunk.createTime);
      if (parsed !== 0) this.created = parsed;
    }
    const id = typeof chunk.responseId === "string" ? chunk.responseId : "";
    const usageExists = chunk.usageMetadata !== undefined;

    const results: string[] = [];
    const candidates = chunk.candidates;

    if (Array.isArray(candidates)) {
      for (const candidate of candidates) {
        const candidateIndex = typeof candidate.index === "number" ? candidate.index : 0;
        const template = newChunk(model, this.created, id, candidateIndex);
        if (chunk.usageMetadata) applyUsage(template, chunk.usageMetadata);

        if (typeof candidate.finishReason === "string") {
          this.upstreamFinishReason.set(candidateIndex, candidate.finishReason.toUpperCase());
        }

        let assistantRoleSet = false;
        const setAssistantRole = (): void => {
          if (assistantRoleSet) return;
          template.choices[0].delta.role = "assistant";
          assistantRoleSet = true;
        };

        const parts = candidate.content?.parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            const hasText = typeof part.text === "string";
            const hasFunctionCall = part.functionCall !== undefined;
            const inline = partInlineData(part);
            const thoughtSignature = part.thoughtSignature ?? part.thought_signature;
            const hasThoughtSignature = typeof thoughtSignature === "string" && thoughtSignature !== "";
            const hasPayload = hasText || hasFunctionCall || inline !== undefined;

            // Skip pure thoughtSignature parts but keep payloads in the same part.
            if (hasThoughtSignature && !hasPayload) continue;

            if (hasText) {
              const text = part.text as string;
              setAssistantRole();
              if (part.thought === true) template.choices[0].delta.reasoning_content = text;
              else template.choices[0].delta.content = text;
            } else if (hasFunctionCall && part.functionCall) {
              this.sawToolCall.set(candidateIndex, true);
              const delta = template.choices[0].delta;
              if (!Array.isArray(delta.tool_calls)) delta.tool_calls = [];
              const functionIndex = delta.tool_calls.length;
              if (this.functionIndex.get(candidateIndex) === undefined) this.functionIndex.set(candidateIndex, 0);
              this.functionIndex.set(candidateIndex, (this.functionIndex.get(candidateIndex) ?? 0) + 1);

              const fcName = part.functionCall.name ?? "";
              functionCallIdCounter += 1;
              const toolCall: Record<string, unknown> = {
                id: `${fcName}-${Date.now()}-${functionCallIdCounter}`,
                index: functionIndex,
                type: "function",
                function: { name: fcName, arguments: "" }
              };
              if (part.functionCall.args !== undefined) {
                (toolCall.function as { arguments: string }).arguments = JSON.stringify(part.functionCall.args);
              }
              setAssistantRole();
              delta.tool_calls.push(toolCall);
            } else if (inline) {
              const delta = template.choices[0].delta;
              if (!Array.isArray(delta.images)) delta.images = [];
              const imagePayload = {
                index: delta.images.length,
                type: "image_url",
                image_url: { url: `data:${inline.mimeType};base64,${inline.data}` }
              };
              setAssistantRole();
              delta.images.push(imagePayload);
            }
          }
        }

        const upstreamFinishReason = this.upstreamFinishReason.get(candidateIndex) ?? "";
        const sawToolCall = this.sawToolCall.get(candidateIndex) ?? false;
        const isFinalChunk = upstreamFinishReason !== "" && usageExists;
        if (isFinalChunk) {
          let finishReason: string;
          if (sawToolCall) finishReason = "tool_calls";
          else if (upstreamFinishReason === "MAX_TOKENS") finishReason = "max_tokens";
          else if (upstreamFinishReason === "SAFETY") finishReason = "content_filter";
          else finishReason = "stop";
          template.choices[0].finish_reason = finishReason;
          template.choices[0].native_finish_reason = upstreamFinishReason.toLowerCase();
        }

        results.push(`data: ${JSON.stringify(template)}\n\n`);
      }
    } else if (usageExists && results.length === 0) {
      // Pure usage chunk with no candidates.
      const template = newChunk(model, this.created, id, 0);
      if (chunk.usageMetadata) applyUsage(template, chunk.usageMetadata);
      results.push(`data: ${JSON.stringify(template)}\n\n`);
    }

    return results;
  }

  // Finish the stream with the OpenAI sentinel.
  finish(): string[] {
    return ["data: [DONE]\n\n"];
  }
}

interface OpenAiMessage {
  role: "assistant";
  content: string | null;
  reasoning_content?: string;
  tool_calls?: Array<Record<string, unknown>>;
  images?: Array<Record<string, unknown>>;
}

interface OpenAiCompletion {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: OpenAiMessage;
    finish_reason: string | null;
    native_finish_reason: string | null;
  }>;
  usage?: OpenAiChunk["usage"];
}

// Non-streaming aggregation: a complete Gemini response JSON string -> an
// OpenAI chat.completion object.
export function openAiNonStream(geminiJson: string, model?: string): OpenAiCompletion {
  const root = JSON.parse(geminiJson) as GeminiResponse;
  const responseModel = typeof root.modelVersion === "string" ? root.modelVersion : (model ?? "model");
  const created = parseCreateTime(root.createTime);

  const completion: OpenAiCompletion = {
    id: typeof root.responseId === "string" ? root.responseId : "",
    object: "chat.completion",
    created,
    model: responseModel,
    choices: []
  };
  if (root.usageMetadata) {
    const chunk = newChunk(responseModel, created, completion.id, 0);
    applyUsage(chunk, root.usageMetadata);
    completion.usage = chunk.usage;
  }

  const candidates = root.candidates;
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      const candidateIndex = typeof candidate.index === "number" ? candidate.index : 0;
      const message: OpenAiMessage = { role: "assistant", content: null };
      let finishReason: string | null = null;
      let nativeFinishReason: string | null = null;

      if (typeof candidate.finishReason === "string") {
        finishReason = candidate.finishReason.toLowerCase();
        nativeFinishReason = finishReason;
      }

      const toolCalls: Array<Record<string, unknown>> = [];
      const images: Array<Record<string, unknown>> = [];
      let textContent = "";
      let reasoningContent = "";
      let hasTextContent = false;
      let hasReasoningContent = false;
      let hasFunctionCall = false;

      const parts = candidate.content?.parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (typeof part.text === "string") {
            if (part.thought === true) {
              hasReasoningContent = true;
              reasoningContent += part.text;
            } else {
              hasTextContent = true;
              textContent += part.text;
            }
          } else if (part.functionCall) {
            hasFunctionCall = true;
            const fcName = part.functionCall.name ?? "";
            functionCallIdCounter += 1;
            const toolCall: Record<string, unknown> = {
              id: `${fcName}-${Date.now()}-${functionCallIdCounter}`,
              type: "function",
              function: { name: fcName, arguments: "" }
            };
            if (part.functionCall.args !== undefined) {
              (toolCall.function as { arguments: string }).arguments = JSON.stringify(part.functionCall.args);
            }
            toolCalls.push(toolCall);
          } else {
            const inline = partInlineData(part);
            if (inline) {
              images.push({
                index: images.length,
                type: "image_url",
                image_url: { url: `data:${inline.mimeType};base64,${inline.data}` }
              });
            }
          }
        }

        if (hasTextContent) {
          if (!hasReasoningContent && parts.length === 1 && toolCalls.length === 0 && images.length === 0) {
            message.content = (parts[0].text as string) ?? "";
          } else {
            message.content = textContent;
          }
        }
        if (hasReasoningContent) message.reasoning_content = reasoningContent;
        if (toolCalls.length > 0) message.tool_calls = toolCalls;
        if (images.length > 0) message.images = images;
      }

      if (hasFunctionCall) {
        finishReason = "tool_calls";
        nativeFinishReason = "tool_calls";
      }

      completion.choices.push({ index: candidateIndex, message, finish_reason: finishReason, native_finish_reason: nativeFinishReason });
    }
  }

  return completion;
}
