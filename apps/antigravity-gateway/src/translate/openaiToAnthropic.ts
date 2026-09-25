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
import { sanitizeClaudeToolId } from "./common";

// ---------------------------------------------------------------------------
// Request: OpenAI Chat -> Anthropic Messages
// ---------------------------------------------------------------------------

export function openAiToAnthropicRequest(
  body: OpenAiRequestBody,
  targetModel?: string
): AnthropicRequestBody {
  const model = targetModel || body.model || "claude-3-7-sonnet-20250219";
  const systemParts: string[] = [];
  const anthropicMessages: AnthropicMessage[] = [];

  const rawMessages = body.messages || [];

  for (let i = 0; i < rawMessages.length; i++) {
    const msg = rawMessages[i];
    const role = msg.role;

    if (role === "system" || role === "developer") {
      if (typeof msg.content === "string" && msg.content.trim() !== "") {
        systemParts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
            systemParts.push(part.text);
          }
        }
      }
      continue;
    }

    if (role === "user") {
      if (typeof msg.content === "string") {
        anthropicMessages.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const blocks: AnthropicContentBlock[] = [];
        for (const part of msg.content) {
          if (!part || typeof part !== "object") continue;
          const p = part as Record<string, unknown>;
          if (p.type === "text" && typeof p.text === "string") {
            blocks.push({ type: "text", text: p.text });
          } else if (p.type === "image_url" && p.image_url && typeof p.image_url === "object") {
            const imgUrl = (p.image_url as Record<string, unknown>).url;
            if (typeof imgUrl === "string" && imgUrl.startsWith("data:")) {
              const commaIdx = imgUrl.indexOf(",");
              if (commaIdx > 0) {
                const meta = imgUrl.slice(5, commaIdx); // e.g. "image/png;base64"
                const data = imgUrl.slice(commaIdx + 1);
                const mediaType = meta.split(";")[0] || "image/png";
                blocks.push({
                  type: "image",
                  source: { type: "base64", media_type: mediaType, data }
                });
              }
            }
          }
        }
        anthropicMessages.push({
          role: "user",
          content: blocks.length > 0 ? blocks : ""
        });
      }
      continue;
    }

    if (role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      if (typeof msg.reasoning_content === "string" && msg.reasoning_content.trim() !== "") {
        blocks.push({
          type: "thinking",
          thinking: msg.reasoning_content
        });
      }
      if (typeof msg.content === "string" && msg.content !== "") {
        blocks.push({ type: "text", text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && typeof part === "object" && (part as Record<string, unknown>).type === "text") {
            blocks.push({ type: "text", text: String((part as Record<string, unknown>).text || "") });
          }
        }
      }

      if (Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          let inputObj: unknown = {};
          if (call.function?.arguments) {
            try {
              inputObj = JSON.parse(call.function.arguments);
            } catch {
              inputObj = { raw: call.function.arguments };
            }
          }
          blocks.push({
            type: "tool_use",
            id: sanitizeClaudeToolId(call.id || `call_${Date.now()}`),
            name: call.function?.name || "unnamed_tool",
            input: inputObj
          });
        }
      }

      if (blocks.length > 0) {
        anthropicMessages.push({ role: "assistant", content: blocks });
      }
      continue;
    }

    if (role === "tool") {
      // In Anthropic, tool responses are user turns with tool_result blocks
      const toolUseId = sanitizeClaudeToolId(msg.tool_call_id || "tool_result");
      const contentVal: unknown = msg.content;
      const toolResultBlock: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: contentVal ?? ""
      };

      // Check if previous message was also a user message containing tool_result to merge
      const lastMsg = anthropicMessages[anthropicMessages.length - 1];
      if (lastMsg && lastMsg.role === "user" && Array.isArray(lastMsg.content)) {
        lastMsg.content.push(toolResultBlock);
      } else {
        anthropicMessages.push({
          role: "user",
          content: [toolResultBlock]
        });
      }
    }
  }

  // Tools mapping
  let anthropicTools: AnthropicTool[] | undefined;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    anthropicTools = [];
    for (const t of body.tools) {
      if (t.function?.name) {
        anthropicTools.push({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters ?? { type: "object", properties: {} }
        });
      }
    }
  }

  const maxTokens = body.max_completion_tokens ?? body.max_tokens ?? 4096;

  const result: AnthropicRequestBody = {
    model,
    messages: anthropicMessages,
    max_tokens: maxTokens
  };

  if (systemParts.length > 0) {
    result.system = systemParts.join("\n\n");
  }
  if (anthropicTools && anthropicTools.length > 0) {
    result.tools = anthropicTools;
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
// Response: Anthropic Non-Stream -> OpenAI Chat Completion
// ---------------------------------------------------------------------------

export function anthropicToOpenAiResponse(
  resp: AnthropicResponseMessage | Record<string, unknown>,
  targetModel: string
): Record<string, unknown> {
  const contentBlocks = Array.isArray(resp.content) ? resp.content : [];
  let textContent = "";
  let reasoningContent = "";
  const toolCalls: Array<Record<string, unknown>> = [];

  for (const block of contentBlocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      textContent += block.text;
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      reasoningContent += block.thinking;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id || `call_${Date.now()}`,
        type: "function",
        function: {
          name: block.name,
          arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input || {})
        }
      });
    }
  }

  let finishReason = "stop";
  if (resp.stop_reason === "tool_use") {
    finishReason = "tool_calls";
  } else if (resp.stop_reason === "max_tokens") {
    finishReason = "length";
  }

  const message: Record<string, unknown> = {
    role: "assistant",
    content: textContent || (toolCalls.length > 0 ? null : "")
  };

  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  const usage = resp.usage as { input_tokens?: number; output_tokens?: number } | undefined;

  return {
    id: typeof resp.id === "string" ? resp.id : `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: targetModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason
      }
    ],
    usage: {
      prompt_tokens: usage?.input_tokens ?? 0,
      completion_tokens: usage?.output_tokens ?? 0,
      total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0)
    }
  };
}

// ---------------------------------------------------------------------------
// Stream: Anthropic SSE -> OpenAI SSE Translator
// ---------------------------------------------------------------------------

export class AnthropicToOpenAiSseTranslator {
  private id: string;
  private model: string;
  private currentBlockType: string | null = null;
  private currentToolCallIndex = -1;
  private created: number;

  constructor(model: string = "gpt-4o") {
    this.id = `chatcmpl-${Date.now()}`;
    this.model = model;
    this.created = Math.floor(Date.now() / 1000);
  }

  feed(rawJson: string): string[] {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(rawJson);
    } catch {
      return [];
    }

    const type = event.type as string;
    const output: string[] = [];

    if (type === "message_start" && event.message && typeof event.message === "object") {
      const msg = event.message as Record<string, unknown>;
      if (typeof msg.id === "string") this.id = msg.id;
      if (typeof msg.model === "string") this.model = msg.model;

      output.push(this.formatChunk({ role: "assistant" }, null));
      return output;
    }

    if (type === "content_block_start" && event.content_block && typeof event.content_block === "object") {
      const block = event.content_block as Record<string, unknown>;
      this.currentBlockType = (block.type as string) || null;

      if (this.currentBlockType === "tool_use") {
        this.currentToolCallIndex += 1;
        output.push(
          this.formatChunk(
            {
              tool_calls: [
                {
                  index: this.currentToolCallIndex,
                  id: block.id,
                  type: "function",
                  function: {
                    name: block.name,
                    arguments: ""
                  }
                }
              ]
            },
            null
          )
        );
      }
      return output;
    }

    if (type === "content_block_delta" && event.delta && typeof event.delta === "object") {
      const delta = event.delta as Record<string, unknown>;
      const deltaType = delta.type as string;

      if (deltaType === "text_delta" && typeof delta.text === "string") {
        output.push(this.formatChunk({ content: delta.text }, null));
      } else if (deltaType === "thinking_delta" && typeof delta.thinking === "string") {
        output.push(this.formatChunk({ reasoning_content: delta.thinking }, null));
      } else if (deltaType === "input_json_delta" && typeof delta.partial_json === "string") {
        output.push(
          this.formatChunk(
            {
              tool_calls: [
                {
                  index: this.currentToolCallIndex,
                  function: {
                    arguments: delta.partial_json
                  }
                }
              ]
            },
            null
          )
        );
      }
      return output;
    }

    if (type === "content_block_stop") {
      this.currentBlockType = null;
      return output;
    }

    if (type === "message_delta" && event.delta && typeof event.delta === "object") {
      const delta = event.delta as Record<string, unknown>;
      let finishReason: string | null = null;
      if (delta.stop_reason === "tool_use") finishReason = "tool_calls";
      else if (delta.stop_reason === "max_tokens") finishReason = "length";
      else if (delta.stop_reason === "end_turn") finishReason = "stop";

      if (finishReason) {
        output.push(this.formatChunk({}, finishReason));
      }
      return output;
    }

    return output;
  }

  finish(): string[] {
    return [`data: [DONE]\n\n`];
  }

  private formatChunk(delta: Record<string, unknown>, finishReason: string | null): string {
    const payload = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason
        }
      ]
    };
    return `data: ${JSON.stringify(payload)}\n\n`;
  }
}
