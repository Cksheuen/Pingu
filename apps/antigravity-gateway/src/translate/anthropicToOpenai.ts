import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequestBody,
  AnthropicResponseMessage,
  AnthropicTool,
  OpenAiChatMessage,
  OpenAiRequestBody,
  OpenAiTool
} from "./types";
import { sseEvent } from "../server/http";

// ---------------------------------------------------------------------------
// Request: Anthropic Messages -> OpenAI Chat Completion
// ---------------------------------------------------------------------------

export function anthropicToOpenAiRequest(
  body: AnthropicRequestBody,
  targetModel?: string
): OpenAiRequestBody {
  const model = targetModel || body.model || "gpt-4o";
  const openAiMessages: OpenAiChatMessage[] = [];

  // 1. System instruction
  if (body.system) {
    let systemText = "";
    if (typeof body.system === "string") {
      systemText = body.system;
    } else if (Array.isArray(body.system)) {
      systemText = body.system
        .map((p) => (p && typeof p === "object" && typeof p.text === "string" ? p.text : ""))
        .filter((t) => t !== "")
        .join("\n\n");
    }
    if (systemText) {
      openAiMessages.push({ role: "system", content: systemText });
    }
  }

  // 2. Messages
  const rawMessages = body.messages || [];
  for (const msg of rawMessages) {
    const role = msg.role;
    if (typeof msg.content === "string") {
      openAiMessages.push({ role, content: msg.content });
      continue;
    }

    if (Array.isArray(msg.content)) {
      if (role === "user") {
        const textParts: string[] = [];
        const contentParts: Array<Record<string, unknown>> = [];
        let hasToolResult = false;

        for (const block of msg.content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
            contentParts.push({ type: "text", text: block.text });
          } else if (block.type === "image" && "source" in block && typeof block.source === "object" && block.source !== null) {
            const src = block.source as { media_type?: string; data?: string };
            const mediaType = src.media_type || "image/png";
            const data = src.data || "";
            contentParts.push({
              type: "image_url",
              image_url: { url: `data:${mediaType};base64,${data}` }
            });
          } else if (block.type === "tool_result") {
            hasToolResult = true;
            let resultText = "";
            if (typeof block.content === "string") {
              resultText = block.content;
            } else if (block.content !== undefined) {
              resultText = JSON.stringify(block.content);
            }
            const toolUseId = "tool_use_id" in block && typeof block.tool_use_id === "string" ? block.tool_use_id : `toolu_${Date.now()}`;
            openAiMessages.push({
              role: "tool",
              tool_call_id: toolUseId,
              content: resultText
            });
          }
        }

        if (!hasToolResult) {
          if (contentParts.length === 1 && contentParts[0].type === "text") {
            openAiMessages.push({ role: "user", content: textParts.join("\n\n") });
          } else if (contentParts.length > 0) {
            openAiMessages.push({ role: "user", content: contentParts });
          }
        }
      } else if (role === "assistant") {
        let textContent = "";
        let reasoningContent = "";
        const toolCalls: NonNullable<OpenAiChatMessage["tool_calls"]> = [];

        for (const block of msg.content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string") {
            textContent += block.text;
          } else if (block.type === "thinking" && typeof block.thinking === "string") {
            reasoningContent += block.thinking;
          } else if (block.type === "tool_use") {
            const toolId = typeof block.id === "string" ? block.id : `toolu_${Date.now()}`;
            const toolName = typeof block.name === "string" ? block.name : "unnamed_tool";
            toolCalls.push({
              id: toolId,
              type: "function",
              function: {
                name: toolName,
                arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input || {})
              }
            });
          }
        }

        const assistantMsg: OpenAiChatMessage = {
          role: "assistant",
          content: textContent || (toolCalls.length > 0 ? null : "")
        };
        if (reasoningContent) {
          assistantMsg.reasoning_content = reasoningContent;
        }
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }
        openAiMessages.push(assistantMsg);
      }
    }
  }

  // 3. Tools
  let openAiTools: OpenAiTool[] | undefined;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    openAiTools = [];
    for (const t of body.tools) {
      openAiTools.push({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema ?? { type: "object", properties: {} }
        }
      });
    }
  }

  const result: OpenAiRequestBody = {
    model,
    messages: openAiMessages
  };

  if (openAiTools && openAiTools.length > 0) {
    result.tools = openAiTools;
  }
  if (typeof body.max_tokens === "number") {
    result.max_tokens = body.max_tokens;
  }
  if (typeof body.temperature === "number") {
    result.temperature = body.temperature;
  }
  if (typeof body.top_p === "number") {
    result.top_p = body.top_p;
  }
  if (body.stream === true) {
    result.stream = true;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Response: OpenAI Non-Stream -> Anthropic Messages
// ---------------------------------------------------------------------------

export function openAiToAnthropicResponse(
  resp: Record<string, unknown>,
  targetModel: string
): AnthropicResponseMessage {
  const choices = Array.isArray(resp.choices) ? (resp.choices as Array<Record<string, unknown>>) : [];
  const firstChoice = choices[0] || {};
  const message = (firstChoice.message as Record<string, unknown>) || {};
  const finishReason = firstChoice.finish_reason as string | undefined;

  const contentBlocks: Array<Record<string, unknown>> = [];

  if (typeof message.reasoning_content === "string" && message.reasoning_content !== "") {
    contentBlocks.push({
      type: "thinking",
      thinking: message.reasoning_content
    });
  }

  if (typeof message.content === "string" && message.content !== "") {
    contentBlocks.push({
      type: "text",
      text: message.content
    });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!call || typeof call !== "object") continue;
      const fn = (call.function as Record<string, unknown>) || {};
      let inputObj: unknown = {};
      if (typeof fn.arguments === "string") {
        try {
          inputObj = JSON.parse(fn.arguments);
        } catch {
          inputObj = { raw: fn.arguments };
        }
      }
      contentBlocks.push({
        type: "tool_use",
        id: call.id || `toolu_${Date.now()}`,
        name: fn.name || "unnamed_tool",
        input: inputObj
      });
    }
  }

  let stopReason: string | null = "end_turn";
  if (finishReason === "tool_calls") stopReason = "tool_use";
  else if (finishReason === "length") stopReason = "max_tokens";

  const usage = resp.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;

  return {
    id: typeof resp.id === "string" ? resp.id : `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: targetModel,
    content: contentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0
    }
  };
}

// ---------------------------------------------------------------------------
// Stream: OpenAI SSE -> Anthropic SSE Translator
// ---------------------------------------------------------------------------

export class OpenAiToAnthropicSseTranslator {
  private id: string;
  private model: string;
  private messageStarted = false;
  private messageFinished = false;
  private currentBlockIndex = -1;
  private inTextBlock = false;
  private inReasoningBlock = false;
  private currentToolIndex = -1;

  constructor(model: string = "claude-3-7-sonnet-20250219") {
    this.id = `msg_${Date.now()}`;
    this.model = model;
  }

  feed(rawJson: string): string[] {
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(rawJson);
    } catch {
      return [];
    }

    const output: string[] = [];

    if (!this.messageStarted) {
      if (typeof chunk.id === "string") this.id = chunk.id;
      if (typeof chunk.model === "string") this.model = chunk.model;

      output.push(
        sseEvent("message_start", {
          type: "message_start",
          message: {
            id: this.id,
            type: "message",
            role: "assistant",
            model: this.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        })
      );
      this.messageStarted = true;
    }

    const choices = Array.isArray(chunk.choices) ? (chunk.choices as Array<Record<string, unknown>>) : [];
    if (choices.length === 0) return output;

    const choice = choices[0];
    const delta = (choice.delta as Record<string, unknown>) || {};
    const finishReason = choice.finish_reason as string | undefined;

    // 1. Reasoning / Thinking content
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
      if (!this.inReasoningBlock) {
        this.closeOpenBlocks(output);
        this.currentBlockIndex += 1;
        this.inReasoningBlock = true;
        output.push(
          sseEvent("content_block_start", {
            type: "content_block_start",
            index: this.currentBlockIndex,
            content_block: { type: "thinking", thinking: "" }
          })
        );
      }
      output.push(
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: this.currentBlockIndex,
          delta: { type: "thinking_delta", thinking: delta.reasoning_content }
        })
      );
    }

    // 2. Regular text content
    if (typeof delta.content === "string" && delta.content !== "") {
      if (!this.inTextBlock) {
        this.closeOpenBlocks(output);
        this.currentBlockIndex += 1;
        this.inTextBlock = true;
        output.push(
          sseEvent("content_block_start", {
            type: "content_block_start",
            index: this.currentBlockIndex,
            content_block: { type: "text", text: "" }
          })
        );
      }
      output.push(
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: this.currentBlockIndex,
          delta: { type: "text_delta", text: delta.content }
        })
      );
    }

    // 3. Tool calls
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        if (!tc || typeof tc !== "object") continue;
        const tcIdx = typeof tc.index === "number" ? tc.index : 0;
        if (tcIdx !== this.currentToolIndex) {
          this.closeOpenBlocks(output);
          this.currentToolIndex = tcIdx;
          this.currentBlockIndex += 1;
          const fn = (tc.function as Record<string, unknown>) || {};
          output.push(
            sseEvent("content_block_start", {
              type: "content_block_start",
              index: this.currentBlockIndex,
              content_block: {
                type: "tool_use",
                id: tc.id || `toolu_${Date.now()}_${tcIdx}`,
                name: fn.name || "unnamed_tool",
                input: {}
              }
            })
          );
        }

        const fn = (tc.function as Record<string, unknown>) || {};
        if (typeof fn.arguments === "string" && fn.arguments !== "") {
          output.push(
            sseEvent("content_block_delta", {
              type: "content_block_delta",
              index: this.currentBlockIndex,
              delta: { type: "input_json_delta", partial_json: fn.arguments }
            })
          );
        }
      }
    }

    // 4. Finish reason
    if (finishReason) {
      this.closeOpenBlocks(output);
      let stopReason = "end_turn";
      if (finishReason === "tool_calls") stopReason = "tool_use";
      else if (finishReason === "length") stopReason = "max_tokens";

      output.push(
        sseEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: 0 }
        })
      );
      output.push(sseEvent("message_stop", { type: "message_stop" }));
      this.messageFinished = true;
    }

    return output;
  }

  finish(): string[] {
    const output: string[] = [];
    this.closeOpenBlocks(output);
    if (this.messageStarted && !this.messageFinished) {
      output.push(
        sseEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 0 }
        })
      );
      output.push(sseEvent("message_stop", { type: "message_stop" }));
      this.messageFinished = true;
    }
    return output;
  }

  private closeOpenBlocks(output: string[]): void {
    if (this.inTextBlock || this.inReasoningBlock || this.currentToolIndex >= 0) {
      output.push(
        sseEvent("content_block_stop", {
          type: "content_block_stop",
          index: this.currentBlockIndex
        })
      );
      this.inTextBlock = false;
      this.inReasoningBlock = false;
      this.currentToolIndex = -1;
    }
  }
}
