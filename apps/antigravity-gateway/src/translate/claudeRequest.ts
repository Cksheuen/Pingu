// Anthropic Messages -> Gemini generateContent request translation.
// Port of CLIProxyAPI internal/translator/gemini/claude/gemini_claude_request.go
// (ConvertClaudeRequestToGemini, non-compat mode: empty thinking blocks dropped).

import { defaultSafetySettings, sanitizeFunctionName, sanitizeSchema } from "./common";
import { lookupModelInfo } from "./models";
import type {
  AnthropicContentBlock,
  AnthropicRequestBody,
  GeminiContent,
  GeminiFunctionDeclaration,
  GeminiPart,
  GeminiRequestBody
} from "./types";

const GEMINI_CLAUDE_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
const CLAUDE_CODE_ATTRIBUTION_PREFIX = "x-anthropic-billing-header:";

function isClaudeCodeAttributionText(text: string): boolean {
  return text.trimStart().startsWith(CLAUDE_CODE_ATTRIBUTION_PREFIX);
}

// toolNameFromClaudeToolUseID: "read_file-call_1" -> "read_file".
function toolNameFromToolUseId(toolUseId: string): string {
  const separator = toolUseId.lastIndexOf("-");
  if (separator <= 0) return "";
  return toolUseId.slice(0, separator);
}

function textPart(text: string): GeminiPart {
  return { text };
}

function contentWithParts(role: string, parts: GeminiPart[]): GeminiContent {
  return { role, parts };
}

// ConvertClaudeToolResultContent port: normalize a tool_result content field
// into a functionResponse result value plus separated base64 images.
function convertToolResultContent(content: unknown): { result: unknown; images: Array<{ mimeType: string; data: string }> } {
  const images: Array<{ mimeType: string; data: string }> = [];

  const isBase64Image = (block: unknown): block is { type: string; source: { type: string; media_type?: string; data?: string } } =>
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "image" &&
    (block as { source?: unknown }).source !== undefined &&
    (block as { source: { type?: unknown } }).source.type === "base64";

  const imageFromBlock = (block: { source: { media_type?: string; data?: string } }): { mimeType: string; data: string } | undefined => {
    const data = block.source.data ?? "";
    if (data === "") return undefined;
    return { mimeType: block.source.media_type ?? "", data };
  };

  if (typeof content === "string") {
    return { result: content, images };
  }
  if (Array.isArray(content)) {
    const nonImage: unknown[] = [];
    for (const block of content) {
      if (isBase64Image(block)) {
        const img = imageFromBlock(block);
        if (img) images.push(img);
        continue;
      }
      nonImage.push(block);
    }
    if (nonImage.length === 1) return { result: nonImage[0], images };
    if (nonImage.length > 1) return { result: nonImage, images };
    return { result: undefined, images };
  }
  if (typeof content === "object" && content !== null) {
    if (isBase64Image(content)) {
      const img = imageFromBlock(content);
      return { result: undefined, images: img ? [img] : [] };
    }
    return { result: content, images };
  }
  return { result: undefined, images };
}

// ClaudeMessageSystemReminderText port: wrap a message-level system value in
// <system-reminder> tags after stripping attribution blocks.
function systemReminderText(content: unknown): string | undefined {
  const parts: string[] = [];
  if (typeof content === "string") {
    if (content !== "" && !isClaudeCodeAttributionText(content)) parts.push(content);
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item !== "object" || item === null || (item as { type?: unknown }).type !== "text") continue;
      const text = (item as { text?: unknown }).text;
      if (typeof text !== "string" || text === "" || isClaudeCodeAttributionText(text)) continue;
      parts.push(text);
    }
  }
  if (parts.length === 0) return undefined;
  const joined = parts.join("\n");
  if (joined.trim() === "") return undefined;
  return `<system-reminder>\n${joined}\n</system-reminder>`;
}

export function claudeMessagesToGemini(body: AnthropicRequestBody): GeminiRequestBody {
  const out: GeminiRequestBody = { contents: [] };
  if (body.model) out.model = body.model;

  // --- system instruction -------------------------------------------------
  const system = body.system;
  if (Array.isArray(system)) {
    const systemParts: GeminiPart[] = [];
    for (const block of system) {
      if (block.type !== "text" || typeof block.text !== "string") continue;
      if (isClaudeCodeAttributionText(block.text)) continue;
      systemParts.push(textPart(block.text));
    }
    if (systemParts.length > 0) {
      out.systemInstruction = contentWithParts("user", systemParts);
    }
  } else if (typeof system === "string" && !isClaudeCodeAttributionText(system)) {
    // Go emits no role for the string form.
    out.systemInstruction = { parts: [textPart(system)] };
  }

  // --- contents ------------------------------------------------------------
  const contentItems: GeminiContent[] = [];
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      const rawRole = message.role;
      let role: string;
      if (rawRole === "assistant") role = "model";
      else if (rawRole === "system") role = "user";
      else role = rawRole;

      const partItems: GeminiPart[] = [];

      if (rawRole === "system") {
        const reminder = systemReminderText(message.content);
        if (reminder !== undefined) {
          partItems.push(textPart(reminder));
          contentItems.push(contentWithParts(role, partItems));
        }
        continue;
      }

      const content = message.content;
      if (Array.isArray(content)) {
        for (const block of content as AnthropicContentBlock[]) {
          const blockType = (block as { type?: string }).type;
          switch (blockType) {
            case "text": {
              const text = (block as { text?: unknown }).text;
              if (typeof text !== "string" || text === "") continue;
              partItems.push(textPart(text));
              break;
            }
            case "thinking":
              // Non-compat mode: thinking blocks with empty signatures are dropped.
              break;
            case "tool_use": {
              const toolUse = block as { id?: string; name?: string; input?: unknown };
              let functionName = typeof toolUse.name === "string" ? toolUse.name : "";
              if (typeof toolUse.id === "string" && toolUse.id !== "") {
                const derived = toolNameFromToolUseId(toolUse.id);
                if (derived !== "") functionName = derived;
              }
              functionName = sanitizeFunctionName(functionName);
              if (typeof toolUse.input === "object" && toolUse.input !== null) {
                partItems.push({
                  thoughtSignature: GEMINI_CLAUDE_THOUGHT_SIGNATURE,
                  functionCall: { name: functionName, args: toolUse.input }
                });
              }
              break;
            }
            case "tool_result": {
              const toolResult = block as { tool_use_id?: string; content?: unknown };
              const toolCallId = typeof toolResult.tool_use_id === "string" ? toolResult.tool_use_id : "";
              if (toolCallId === "") continue;
              let funcName = toolNameFromToolUseId(toolCallId);
              if (funcName === "") funcName = toolCallId;
              funcName = sanitizeFunctionName(funcName);
              const { result, images } = convertToolResultContent(toolResult.content);
              partItems.push({
                functionResponse: { name: funcName, response: { result: result ?? "" } }
              });
              for (const img of images) {
                partItems.push({ inline_data: { mime_type: img.mimeType, data: img.data } });
              }
              break;
            }
            case "image": {
              const imageBlock = block as { source?: { type?: string; media_type?: string; data?: string } };
              const source = imageBlock.source;
              if (!source || source.type !== "base64") continue;
              const mimeType = source.media_type ?? "";
              const data = source.data ?? "";
              if (mimeType === "" || data === "") continue;
              partItems.push({ inline_data: { mime_type: mimeType, data } });
              break;
            }
            default:
              break;
          }
        }
        contentItems.push(contentWithParts(role, partItems));
      } else if (typeof content === "string") {
        partItems.push(textPart(content));
        contentItems.push(contentWithParts(role, partItems));
      }
    }

    // Strip a trailing model turn that still carries unanswered function calls.
    if (contentItems.length > 0) {
      const last = contentItems[contentItems.length - 1];
      if (last.role === "model" && last.parts.some((part) => part.functionCall !== undefined)) {
        contentItems.pop();
      }
    }
    out.contents = contentItems;
  }

  // --- tools ---------------------------------------------------------------
  if (Array.isArray(body.tools)) {
    const toolItems: Array<Record<string, unknown>> = [];
    for (const tool of body.tools) {
      const inputSchema = tool.input_schema;
      if (typeof inputSchema !== "object" || inputSchema === null) continue;
      const item: Record<string, unknown> = { ...tool };
      delete item.input_schema;
      item.parametersJsonSchema = sanitizeSchema(inputSchema);
      for (const key of ["strict", "input_examples", "type", "cache_control", "defer_loading", "eager_input_streaming"]) {
        delete item[key];
      }
      const originalName = typeof tool.name === "string" ? tool.name : "";
      const sanitizedName = sanitizeFunctionName(originalName);
      if (originalName === "" || sanitizedName !== originalName) {
        item.name = sanitizedName;
      }
      toolItems.push(item);
    }
    if (toolItems.length > 0) {
      out.tools = [{ functionDeclarations: toolItems as unknown as GeminiFunctionDeclaration[] }];
    }
  }

  // --- tool_choice ----------------------------------------------------------
  const toolChoice = body.tool_choice;
  if (toolChoice !== undefined && toolChoice !== null) {
    let toolChoiceType = "";
    let toolChoiceName = "";
    if (typeof toolChoice === "object") {
      const tc = toolChoice as { type?: unknown; name?: unknown };
      toolChoiceType = typeof tc.type === "string" ? tc.type : "";
      toolChoiceName = typeof tc.name === "string" ? tc.name : "";
    } else if (typeof toolChoice === "string") {
      toolChoiceType = toolChoice;
    }
    const functionCallingConfig: { mode: string; allowedFunctionNames?: string[] } = { mode: "" };
    switch (toolChoiceType) {
      case "auto":
        functionCallingConfig.mode = "AUTO";
        break;
      case "none":
        functionCallingConfig.mode = "NONE";
        break;
      case "any":
        functionCallingConfig.mode = "ANY";
        break;
      case "tool":
        functionCallingConfig.mode = "ANY";
        if (toolChoiceName !== "") {
          functionCallingConfig.allowedFunctionNames = [sanitizeFunctionName(toolChoiceName)];
        }
        break;
      default:
        break;
    }
    if (functionCallingConfig.mode !== "") {
      out.toolConfig = { functionCallingConfig };
    }
  }

  // --- thinking -------------------------------------------------------------
  const thinking = body.thinking;
  if (thinking && typeof thinking === "object") {
    const thinkingType = typeof thinking.type === "string" ? thinking.type : "";
    if (thinkingType === "enabled" && typeof thinking.budget_tokens === "number") {
      out.generationConfig = {
        ...out.generationConfig,
        thinkingConfig: { ...out.generationConfig?.thinkingConfig, thinkingBudget: thinking.budget_tokens }
      };
    } else if (thinkingType === "adaptive" || thinkingType === "auto") {
      const effortRaw = body.output_config?.effort;
      const effort = typeof effortRaw === "string" ? effortRaw.trim().toLowerCase() : "";
      if (effort !== "") {
        out.generationConfig = {
          ...out.generationConfig,
          thinkingConfig: { ...out.generationConfig?.thinkingConfig, thinkingLevel: effort }
        };
      } else {
        const maxBudget = lookupModelInfo(body.model)?.thinking?.max ?? 0;
        if (maxBudget > 0) {
          out.generationConfig = {
            ...out.generationConfig,
            thinkingConfig: { ...out.generationConfig?.thinkingConfig, thinkingBudget: maxBudget }
          };
        } else {
          out.generationConfig = {
            ...out.generationConfig,
            thinkingConfig: { ...out.generationConfig?.thinkingConfig, thinkingLevel: "high" }
          };
        }
      }
    }
  }

  // --- sampling params ------------------------------------------------------
  if (typeof body.temperature === "number") {
    out.generationConfig = { ...out.generationConfig, temperature: body.temperature };
  }
  if (typeof body.top_p === "number") {
    out.generationConfig = { ...out.generationConfig, topP: body.top_p };
  }
  if (typeof body.top_k === "number") {
    out.generationConfig = { ...out.generationConfig, topK: body.top_k };
  }

  // --- safety settings ------------------------------------------------------
  out.safetySettings = defaultSafetySettings();

  return out;
}
