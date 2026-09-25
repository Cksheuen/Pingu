// Gemini -> Anthropic response translation.
// Port of CLIProxyAPI internal/translator/gemini/claude/gemini_claude_response.go:
// - ClaudeSseTranslator: streaming state machine (0=none, 1=text, 2=thinking, 3=tool)
// - claudeNonStream: non-streaming aggregation into a full Anthropic Message

import { sanitizeClaudeToolId, sanitizeFunctionName } from "./common";
import { sseEvent } from "../server/http";
import type { AnthropicRequestBody, AnthropicResponseMessage, GeminiPart, GeminiResponse } from "./types";

// Response type states, matching the Go state machine.
const STATE_NONE = 0;
const STATE_TEXT = 1;
const STATE_THINKING = 2;
const STATE_TOOL = 3;

const DEFAULT_MESSAGE_ID = "msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY";
const DEFAULT_MODEL = "claude-3-5-sonnet-20241022";

function canonicalToolName(name: string): string {
  return name.trim().replace(/^_+/, "").toLowerCase();
}

// ToolNameMapFromClaudeRequest: canonical-name -> original client name, used to
// restore exact casing for clients that require strict tool name matching.
function toolNameMapFromRequest(request: AnthropicRequestBody | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!request || !Array.isArray(request.tools)) return map;
  for (const tool of request.tools) {
    const name = typeof tool.name === "string" ? tool.name.trim() : "";
    if (name === "") continue;
    const key = canonicalToolName(name);
    if (key !== "" && !map.has(key)) map.set(key, name);
  }
  return map;
}

// SanitizedToolNameMap: sanitized-name -> original name, used to undo
// sanitizeFunctionName on the response path.
function sanitizedNameMapFromRequest(request: AnthropicRequestBody | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!request || !Array.isArray(request.tools)) return map;
  for (const tool of request.tools) {
    const name = typeof tool.name === "string" ? tool.name.trim() : "";
    if (name === "") continue;
    const sanitized = sanitizeFunctionName(name);
    if (sanitized === name) continue;
    if (!map.has(sanitized)) map.set(sanitized, name);
  }
  return map;
}

function restoreSanitizedToolName(map: Map<string, string>, name: string): string {
  if (name === "" || map.size === 0) return name;
  return map.get(name) ?? name;
}

function mapToolName(map: Map<string, string>, name: string): string {
  if (name === "" || map.size === 0) return name;
  return map.get(canonicalToolName(name)) ?? name;
}

function partText(part: GeminiPart): string | undefined {
  return typeof part.text === "string" ? part.text : undefined;
}

function partThoughtSignature(part: GeminiPart): string {
  const sig = part.thoughtSignature ?? part.thought_signature;
  return typeof sig === "string" ? sig : "";
}

function partFunctionCall(part: GeminiPart): { name: string; args?: unknown } | undefined {
  return part.functionCall;
}

export class ClaudeSseTranslator {
  private hasFirstResponse = false;
  private responseType = STATE_NONE;
  private responseIndex = 0;
  private hasContent = false;
  private sawToolCall = false;
  private hasFinalEvents = false;
  private messageStopSent = false;
  private toolUseCounter = 0;
  private readonly toolNameMap: Map<string, string>;
  private readonly sanitizedNameMap: Map<string, string>;

  constructor(request?: AnthropicRequestBody) {
    this.toolNameMap = toolNameMapFromRequest(request);
    this.sanitizedNameMap = sanitizedNameMapFromRequest(request);
  }

  // Feed one upstream SSE data payload (the JSON string of a Gemini chunk,
  // or the "[DONE]" sentinel). Returns zero or more Anthropic SSE event strings.
  feed(chunkJson: string): string[] {
    if (this.messageStopSent) return [];
    if (chunkJson.trim() === "[DONE]") return this.finish();
    const chunk = JSON.parse(chunkJson) as GeminiResponse;
    const events: string[] = [];
    const append = (event: string, payload: unknown): void => {
      events.push(sseEvent(event, payload));
    };
    // message_start is deferred until the first content-bearing part: a chunk
    // with no content must not open a stream that would never see message_stop.
    const ensureStarted = (): void => {
      if (this.hasFirstResponse) return;
      const messageStart = {
        type: "message_start",
        message: {
          id: typeof chunk.responseId === "string" ? chunk.responseId : DEFAULT_MESSAGE_ID,
          type: "message",
          role: "assistant",
          content: [],
          model: typeof chunk.modelVersion === "string" ? chunk.modelVersion : DEFAULT_MODEL,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      };
      append("message_start", messageStart);
      this.hasFirstResponse = true;
    };

    const appendSignatureDelta = (signature: string): void => {
      if (signature === "" || this.responseType !== STATE_THINKING) return;
      append("content_block_delta", {
        type: "content_block_delta",
        index: this.responseIndex,
        delta: { type: "signature_delta", signature }
      });
      this.hasContent = true;
    };

    const parts = chunk.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const text = partText(part);
        const functionCall = partFunctionCall(part);
        const thoughtSignature = partThoughtSignature(part);
        const hasThoughtSignature = thoughtSignature !== "";

        // Pure signature part: emit as a signature delta inside the open thinking block.
        if (hasThoughtSignature && text === undefined && functionCall === undefined) {
          appendSignatureDelta(thoughtSignature);
          continue;
        }

        if (text !== undefined) {
          const isThought = part.thought === true || hasThoughtSignature;
          if (isThought) {
            if (hasThoughtSignature && text === "") {
              appendSignatureDelta(thoughtSignature);
              continue;
            }
            ensureStarted();
            if (this.responseType === STATE_THINKING) {
              append("content_block_delta", {
                type: "content_block_delta",
                index: this.responseIndex,
                delta: { type: "thinking_delta", thinking: text }
              });
              this.hasContent = true;
            } else {
              if (this.responseType !== STATE_NONE) {
                append("content_block_stop", { type: "content_block_stop", index: this.responseIndex });
                this.responseIndex += 1;
              }
              append("content_block_start", {
                type: "content_block_start",
                index: this.responseIndex,
                content_block: { type: "thinking", thinking: "" }
              });
              append("content_block_delta", {
                type: "content_block_delta",
                index: this.responseIndex,
                delta: { type: "thinking_delta", thinking: text }
              });
              this.responseType = STATE_THINKING;
              this.hasContent = true;
            }
            appendSignatureDelta(thoughtSignature);
          } else {
            ensureStarted();
            if (this.responseType === STATE_TEXT) {
              append("content_block_delta", {
                type: "content_block_delta",
                index: this.responseIndex,
                delta: { type: "text_delta", text }
              });
              this.hasContent = true;
            } else {
              if (this.responseType !== STATE_NONE) {
                append("content_block_stop", { type: "content_block_stop", index: this.responseIndex });
                this.responseIndex += 1;
              }
              append("content_block_start", {
                type: "content_block_start",
                index: this.responseIndex,
                content_block: { type: "text", text: "" }
              });
              append("content_block_delta", {
                type: "content_block_delta",
                index: this.responseIndex,
                delta: { type: "text_delta", text }
              });
              this.responseType = STATE_TEXT;
              this.hasContent = true;
            }
          }
        } else if (functionCall !== undefined) {
          this.sawToolCall = true;
          const upstreamToolName = restoreSanitizedToolName(this.sanitizedNameMap, functionCall.name ?? "");
          const clientToolName = mapToolName(this.toolNameMap, upstreamToolName);

          // Streaming split: an empty name while a tool block is open means
          // this chunk carries args only.
          if (this.responseType === STATE_TOOL && upstreamToolName === "") {
            if (functionCall.args !== undefined) {
              append("content_block_delta", {
                type: "content_block_delta",
                index: this.responseIndex,
                delta: { type: "input_json_delta", partial_json: JSON.stringify(functionCall.args) }
              });
            }
            continue;
          }

          if (this.responseType === STATE_TOOL) {
            append("content_block_stop", { type: "content_block_stop", index: this.responseIndex });
            this.responseIndex += 1;
            this.responseType = STATE_NONE;
          }
          if (this.responseType !== STATE_NONE) {
            append("content_block_stop", { type: "content_block_stop", index: this.responseIndex });
            this.responseIndex += 1;
          }

          ensureStarted();
          this.toolUseCounter += 1;
          append("content_block_start", {
            type: "content_block_start",
            index: this.responseIndex,
            content_block: {
              type: "tool_use",
              id: sanitizeClaudeToolId(`${upstreamToolName}-${this.toolUseCounter}`),
              name: clientToolName,
              input: {}
            }
          });
          if (functionCall.args !== undefined) {
            append("content_block_delta", {
              type: "content_block_delta",
              index: this.responseIndex,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(functionCall.args) }
            });
          }
          this.responseType = STATE_TOOL;
          this.hasContent = true;
        }
      }
    }

    // Final events on the finish chunk (usageMetadata + finishReason present).
    const usage = chunk.usageMetadata;
    if (usage && chunk.candidates?.[0]?.finishReason !== undefined && !this.hasFinalEvents) {
      if (this.hasContent) {
        if (this.responseType !== STATE_NONE) {
          append("content_block_stop", { type: "content_block_stop", index: this.responseIndex });
          this.responseType = STATE_NONE;
        }

        let stopReason = "end_turn";
        if (this.sawToolCall) {
          stopReason = "tool_use";
        } else if (chunk.candidates?.[0]?.finishReason === "MAX_TOKENS") {
          stopReason = "max_tokens";
        }

        append("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: {
            input_tokens: usage.promptTokenCount ?? 0,
            output_tokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0)
          }
        });
        this.hasFinalEvents = true;
      }
    }

    return events;
  }

  // Finish the stream; emits message_stop when content was produced.
  finish(): string[] {
    if (this.messageStopSent || !this.hasContent) return [];
    this.messageStopSent = true;
    return [sseEvent("message_stop", { type: "message_stop" })];
  }
}

// Non-streaming aggregation: a complete Gemini response JSON string -> an
// Anthropic Message object.
export function claudeNonStream(geminiJson: string, model?: string): AnthropicResponseMessage {
  const root = JSON.parse(geminiJson) as GeminiResponse;
  const toolNameMap = toolNameMapFromRequest(undefined);
  const sanitizedNameMap = sanitizedNameMapFromRequest(undefined);

  const inputTokens = root.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = (root.usageMetadata?.candidatesTokenCount ?? 0) + (root.usageMetadata?.thoughtsTokenCount ?? 0);

  const blocks: Array<Record<string, unknown>> = [];
  let textBuilder = "";
  let thinkingBuilder = "";
  let toolIdCounter = 0;
  let hasToolCall = false;

  const flushText = (): void => {
    if (textBuilder === "") return;
    blocks.push({ type: "text", text: textBuilder });
    textBuilder = "";
  };
  const flushThinking = (): void => {
    if (thinkingBuilder === "") return;
    blocks.push({ type: "thinking", thinking: thinkingBuilder });
    thinkingBuilder = "";
  };

  const parts = root.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const text = partText(part);
      if (text !== undefined && text !== "") {
        if (part.thought === true) {
          flushText();
          thinkingBuilder += text;
        } else {
          flushThinking();
          textBuilder += text;
        }
        continue;
      }
      const functionCall = partFunctionCall(part);
      if (functionCall !== undefined) {
        flushThinking();
        flushText();
        hasToolCall = true;
        const upstreamToolName = restoreSanitizedToolName(sanitizedNameMap, functionCall.name ?? "");
        const clientToolName = mapToolName(toolNameMap, upstreamToolName);
        toolIdCounter += 1;
        let input: unknown = {};
        if (functionCall.args !== undefined && typeof functionCall.args === "object" && functionCall.args !== null) {
          input = functionCall.args;
        }
        blocks.push({
          type: "tool_use",
          id: sanitizeClaudeToolId(`${upstreamToolName}-${toolIdCounter}`),
          name: clientToolName,
          input
        });
      }
    }
  }
  flushThinking();
  flushText();

  let stopReason: string | null = "end_turn";
  if (hasToolCall) {
    stopReason = "tool_use";
  } else {
    const finish = root.candidates?.[0]?.finishReason;
    if (finish !== undefined) {
      switch (finish) {
        case "MAX_TOKENS":
          stopReason = "max_tokens";
          break;
        default:
          stopReason = "end_turn";
      }
    }
  }

  const message: AnthropicResponseMessage = {
    id: root.responseId ?? "",
    type: "message",
    role: "assistant",
    model: root.modelVersion ?? model ?? "",
    content: blocks,
    stop_reason: stopReason,
    stop_sequence: null
  };
  // Go deletes usage only when usageMetadata is absent entirely.
  if (root.usageMetadata !== undefined) {
    message.usage = { input_tokens: inputTokens, output_tokens: outputTokens };
  }
  return message;
}
