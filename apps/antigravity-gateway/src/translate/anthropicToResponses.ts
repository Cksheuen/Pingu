import type {
  AnthropicContentBlock,
  AnthropicRequestBody,
  ResponsesRequestBody
} from "./types";
import { sseEvent } from "../server/http";

export function anthropicToResponsesRequest(body: AnthropicRequestBody, targetModel?: string): ResponsesRequestBody {
  const input: Array<Record<string, unknown>> = [];
  const system = anthropicSystemText(body.system);
  if (system) {
    // Responses accepts instructions separately; keeping system text out of
    // input also matches Codex's native request shape.
  }

  for (const message of body.messages ?? []) {
    // Claude Code can send internal system turns inside `messages`. The
    // subscription Responses endpoint rejects role=system input items, so
    // preserve their text as a user-side reminder instead of forwarding the
    // unsupported role verbatim.
    const responseRole = message.role === "assistant" ? "assistant" : "user";
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [];
    const textBlocks: Array<Record<string, unknown>> = [];

    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") {
        textBlocks.push({
          type: responseRole === "assistant" ? "output_text" : "input_text",
          text: block.text
        });
        continue;
      }
      if (block.type === "image" && message.role === "user") {
        const source = block.source;
        if (source && typeof source === "object") {
          const sourceRecord = source as Record<string, unknown>;
          const mediaType = typeof sourceRecord.media_type === "string" ? sourceRecord.media_type : "image/png";
          const data = typeof sourceRecord.data === "string" ? sourceRecord.data : "";
          textBlocks.push({ type: "input_image", image_url: `data:${mediaType};base64,${data}` });
        }
        continue;
      }
      if (block.type === "thinking" && message.role === "assistant") {
        // Responses reasoning items are reconstructed from the encrypted
        // signature when available. Plain thinking text is not replayable.
        const signature = typeof block.signature === "string" ? block.signature : undefined;
        if (signature) {
          // The subscription Responses schema requires a summary array on
          // replayed reasoning items, even when the encrypted payload is the
          // only reusable content we have from Claude Code.
          input.push({ type: "reasoning", summary: [], encrypted_content: signature });
        }
        continue;
      }
      if (block.type === "tool_use" && message.role === "assistant") {
        input.push({
          type: "function_call",
          call_id: typeof block.id === "string" ? block.id : `toolu_${Date.now()}`,
          name: typeof block.name === "string" ? block.name : "unnamed_tool",
          arguments: JSON.stringify(block.input ?? {})
        });
        continue;
      }
      if (block.type === "tool_result" && message.role === "user") {
        input.push({
          type: "function_call_output",
          call_id: typeof block.tool_use_id === "string" ? block.tool_use_id : `toolu_${Date.now()}`,
          output: contentToText(block.content)
        });
      }
    }

    if (textBlocks.length > 0) {
      input.push({
        type: "message",
        role: responseRole,
        content: textBlocks
      });
    }
  }

  const result: ResponsesRequestBody = {
    model: targetModel ?? body.model ?? "gpt-5.6-sol",
    input,
    instructions: system || undefined,
    stream: body.stream === true,
    store: false,
    include: ["reasoning.encrypted_content"],
    parallel_tool_calls: true
  };

  if (typeof body.max_tokens === "number") result.max_output_tokens = body.max_tokens;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    result.tools = body.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema ?? { type: "object", properties: {} }
    }));
  }
  if (body.tool_choice !== undefined) result.tool_choice = responsesToolChoice(body.tool_choice);
  const effort = body.output_config?.effort;
  if (typeof effort === "string") result.reasoning = { effort: effort.toLowerCase(), summary: "auto" };
  else if (body.thinking?.type && body.thinking.type !== "disabled") result.reasoning = { summary: "auto" };

  return result;
}

export function responsesToAnthropicResponse(response: Record<string, unknown>, targetModel: string): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "reasoning") {
      const summary = Array.isArray(record.summary) ? record.summary : [];
      const thinking = summary
        .filter((part): part is Record<string, unknown> => !!part && typeof part === "object")
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("");
      if (thinking || typeof record.encrypted_content === "string") {
        content.push({
          type: "thinking",
          thinking,
          ...(typeof record.encrypted_content === "string" ? { signature: record.encrypted_content } : {})
        });
      }
      continue;
    }
    if (record.type === "function_call") {
      let input: unknown = {};
      if (typeof record.arguments === "string") {
        try {
          input = JSON.parse(record.arguments);
        } catch {
          input = { raw: record.arguments };
        }
      }
      content.push({
        type: "tool_use",
        id: typeof record.call_id === "string" ? record.call_id : String(record.id ?? `toolu_${Date.now()}`),
        name: typeof record.name === "string" ? record.name : "unnamed_tool",
        input
      });
      continue;
    }
    if (record.type !== "message") continue;
    const parts = Array.isArray(record.content) ? record.content : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const partRecord = part as Record<string, unknown>;
      if (partRecord.type === "output_text" && typeof partRecord.text === "string") {
        content.push({ type: "text", text: partRecord.text });
      }
    }
  }

  const incompleteReason = (response.incomplete_details as Record<string, unknown> | undefined)?.reason;
  const stopReason = content.some((block) => block.type === "tool_use")
    ? "tool_use"
    : incompleteReason === "max_output_tokens"
      ? "max_tokens"
      : "end_turn";
  const usage = response.usage as Record<string, unknown> | undefined;
  return {
    id: typeof response.id === "string" ? response.id : `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: typeof response.model === "string" ? response.model : targetModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: numberValue(usage?.input_tokens),
      output_tokens: numberValue(usage?.output_tokens)
    }
  };
}

export class ResponsesToAnthropicSseTranslator {
  private readonly fallbackModel: string;
  private id = `msg_${Date.now()}`;
  private model: string;
  private started = false;
  private nextBlockIndex = 0;
  private openBlocks = new Map<string, { index: number; type: string }>();
  private stopReason = "end_turn";
  private usage: { input_tokens: number; output_tokens: number } = { input_tokens: 0, output_tokens: 0 };
  private completed = false;

  constructor(fallbackModel: string) {
    this.fallbackModel = fallbackModel;
    this.model = fallbackModel;
  }

  feed(rawJson: string): string[] {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(rawJson) as Record<string, unknown>;
    } catch {
      return [];
    }
    const output: string[] = [];
    const type = event.type;
    if (type === "response.created") {
      const response = event.response as Record<string, unknown> | undefined;
      if (response) {
        if (typeof response.id === "string") this.id = response.id;
        if (typeof response.model === "string") this.model = response.model;
      }
      this.startMessage(output);
      return output;
    }

    this.startMessage(output);
    if (type === "response.output_item.added") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call") this.ensureTool(output, eventKey(event, item), item);
    } else if (type === "response.output_text.delta") {
      const key = eventKey(event);
      const block = this.ensureBlock(output, key, "text", { type: "text", text: "" });
      output.push(sseEvent("content_block_delta", {
        type: "content_block_delta", index: block.index, delta: { type: "text_delta", text: String(event.delta ?? "") }
      }));
    } else if (type === "response.reasoning_summary_text.delta") {
      const block = this.ensureBlock(output, eventKey(event), "thinking", { type: "thinking", thinking: "" });
      output.push(sseEvent("content_block_delta", {
        type: "content_block_delta", index: block.index, delta: { type: "thinking_delta", thinking: String(event.delta ?? "") }
      }));
    } else if (type === "response.function_call_arguments.delta") {
      const item = (event.item as Record<string, unknown> | undefined) ?? {};
      const block = this.ensureTool(output, eventKey(event, item), item);
      output.push(sseEvent("content_block_delta", {
        type: "content_block_delta", index: block.index, delta: { type: "input_json_delta", partial_json: String(event.delta ?? "") }
      }));
    } else if (type === "response.output_item.done") {
      const item = event.item as Record<string, unknown> | undefined;
      const key = eventKey(event, item);
      if (item?.type === "reasoning" && typeof item.encrypted_content === "string") {
        const block = this.ensureBlock(output, key, "thinking", { type: "thinking", thinking: "" });
        output.push(sseEvent("content_block_delta", {
          type: "content_block_delta", index: block.index, delta: { type: "signature_delta", signature: item.encrypted_content }
        }));
      }
      if (item?.type === "function_call" && !this.openBlocks.has(key)) this.ensureTool(output, key, item);
      this.closeBlock(output, key);
    } else if (type === "response.completed") {
      const response = event.response as Record<string, unknown> | undefined;
      this.applyResponseMetadata(response);
      for (const key of [...this.openBlocks.keys()]) this.closeBlock(output, key);
      output.push(sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: this.stopReason, stop_sequence: null },
        usage: { input_tokens: this.usage.input_tokens, output_tokens: this.usage.output_tokens }
      }));
      output.push(sseEvent("message_stop", { type: "message_stop" }));
      this.completed = true;
    }
    return output;
  }

  finish(): string[] {
    if (this.completed) return [];
    const output: string[] = [];
    this.startMessage(output);
    for (const key of [...this.openBlocks.keys()]) this.closeBlock(output, key);
    output.push(sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: this.stopReason, stop_sequence: null },
      usage: { input_tokens: this.usage.input_tokens, output_tokens: this.usage.output_tokens }
    }));
    output.push(sseEvent("message_stop", { type: "message_stop" }));
    this.completed = true;
    return output;
  }

  private startMessage(output: string[]): void {
    if (this.started) return;
    this.started = true;
    output.push(sseEvent("message_start", {
      type: "message_start",
      message: { id: this.id, type: "message", role: "assistant", model: this.model || this.fallbackModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
    }));
  }

  private ensureBlock(output: string[], key: string, type: string, contentBlock: Record<string, unknown>): { index: number; type: string } {
    const existing = this.openBlocks.get(key);
    if (existing) return existing;
    const block = { index: this.nextBlockIndex++, type };
    this.openBlocks.set(key, block);
    output.push(sseEvent("content_block_start", { type: "content_block_start", index: block.index, content_block: contentBlock }));
    return block;
  }

  private ensureTool(output: string[], key: string, item: Record<string, unknown>): { index: number; type: string } {
    return this.ensureBlock(output, key, "tool_use", {
      type: "tool_use",
      id: typeof item.call_id === "string" ? item.call_id : String(item.id ?? `toolu_${Date.now()}`),
      name: typeof item.name === "string" ? item.name : "unnamed_tool",
      input: {}
    });
  }

  private closeBlock(output: string[], key: string): void {
    const block = this.openBlocks.get(key);
    if (!block) return;
    output.push(sseEvent("content_block_stop", { type: "content_block_stop", index: block.index }));
    this.openBlocks.delete(key);
  }

  private applyResponseMetadata(response: Record<string, unknown> | undefined): void {
    if (!response) return;
    if (typeof response.id === "string") this.id = response.id;
    if (typeof response.model === "string") this.model = response.model;
    const usage = response.usage as Record<string, unknown> | undefined;
    if (usage) {
      this.usage = { input_tokens: numberValue(usage.input_tokens), output_tokens: numberValue(usage.output_tokens) };
    }
    const incomplete = response.incomplete_details as Record<string, unknown> | undefined;
    if (incomplete?.reason === "max_output_tokens") this.stopReason = "max_tokens";
    const output = Array.isArray(response.output) ? response.output : [];
    if (output.some((item) => (item as Record<string, unknown>)?.type === "function_call")) this.stopReason = "tool_use";
  }
}

function anthropicSystemText(system: AnthropicRequestBody["system"]): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system.map((part) => (part && typeof part.text === "string" ? part.text : "")).filter(Boolean).join("\n\n");
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function responsesToolChoice(choice: unknown): unknown {
  if (!choice || typeof choice !== "object") return choice;
  const value = choice as Record<string, unknown>;
  if (value.type === "tool" && typeof value.name === "string") return { type: "function", name: value.name };
  if (value.type === "any") return "required";
  if (value.type === "none" || value.type === "auto" || value.type === "required") return value.type;
  return choice;
}

function eventKey(event: Record<string, unknown>, item?: Record<string, unknown>): string {
  if (typeof event.item_id === "string") return event.item_id;
  if (typeof item?.id === "string") return item.id;
  if (typeof event.output_index === "number") return `output_${event.output_index}`;
  return "default";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
