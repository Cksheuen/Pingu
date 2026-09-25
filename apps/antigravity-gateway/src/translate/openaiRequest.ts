// OpenAI Chat Completions -> Gemini generateContent request translation.
// Port of CLIProxyAPI internal/translator/gemini/openai/chat-completions/gemini_openai_request.go

import { defaultSafetySettings, sanitizeFunctionName, sanitizeSchema } from "./common";
import type {
  GeminiContent,
  GeminiFunctionDeclaration,
  GeminiPart,
  GeminiRequestBody,
  GeminiTool,
  OpenAiChatMessage,
  OpenAiRequestBody
} from "./types";

const GEMINI_FUNCTION_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

function textPart(text: string): GeminiPart {
  return { text };
}

function inlineDataPart(mimeType: string, data: string, thoughtSignature: string): GeminiPart {
  const part: GeminiPart = { inlineData: { mime_type: mimeType, data } };
  if (thoughtSignature !== "") part.thoughtSignature = thoughtSignature;
  return part;
}

function contentNode(role: string, parts: GeminiPart[]): GeminiContent {
  return { role, parts };
}

function openAiInputAudioMimeType(audioFormat: string): string {
  switch (audioFormat) {
    case "":
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
    case "ogg":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "aac":
      return "audio/aac";
    case "webm":
      return "audio/webm";
    case "pcm16":
      return "audio/pcm";
    case "g711_ulaw":
    case "g711_alaw":
      return "audio/basic";
    default:
      return `audio/${audioFormat}`;
  }
}

// Parse a data URI ("data:<mime>;base64,<data>") into mime + base64 payload.
function parseDataUri(url: string): { mimeType: string; data: string } | undefined {
  if (url.length <= 5 || !url.startsWith("data:")) return undefined;
  const rest = url.slice(5);
  const separator = rest.indexOf(";");
  if (separator < 0) return undefined;
  const mimeType = rest.slice(0, separator);
  const tail = rest.slice(separator + 1);
  if (tail.length <= 7 || !tail.startsWith("base64,")) return undefined;
  return { mimeType, data: tail.slice(7) };
}

// Tool-call thought signatures: replay when the client carried one, otherwise
// use the bypass sentinel (signature replay is out of MVP scope).
function toolCallThoughtSignature(toolCall: { [key: string]: unknown }): string {
  const candidates = [
    (toolCall.extra_content as { google?: { thought_signature?: string } } | undefined)?.google?.thought_signature,
    (toolCall.function as { extra_content?: { google?: { thought_signature?: string } } } | undefined)?.extra_content?.google
      ?.thought_signature,
    toolCall.thoughtSignature,
    toolCall.thought_signature
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return GEMINI_FUNCTION_THOUGHT_SIGNATURE;
}

export function openaiChatToGemini(body: OpenAiRequestBody): GeminiRequestBody {
  const out: GeminiRequestBody = { contents: [] };
  if (body.model) out.model = body.model;

  // Let user-provided generationConfig pass through.
  if (body.generationConfig !== undefined && body.generationConfig !== null) {
    out.generationConfig = body.generationConfig as GeminiRequestBody["generationConfig"];
  }

  // reasoning_effort -> thinkingConfig.
  if (typeof body.reasoning_effort === "string") {
    const effort = body.reasoning_effort.trim().toLowerCase();
    if (effort !== "") {
      const thinkingConfig = { ...out.generationConfig?.thinkingConfig };
      if (effort === "auto") thinkingConfig.thinkingBudget = -1;
      else thinkingConfig.thinkingLevel = effort;
      out.generationConfig = { ...out.generationConfig, thinkingConfig };
    }
  }

  if (typeof body.temperature === "number") {
    out.generationConfig = { ...out.generationConfig, temperature: body.temperature };
  }
  if (typeof body.top_p === "number") {
    out.generationConfig = { ...out.generationConfig, topP: body.top_p };
  }
  if (typeof body.top_k === "number") {
    out.generationConfig = { ...out.generationConfig, topK: body.top_k };
  }

  // max_tokens / max_completion_tokens -> maxOutputTokens.
  if (typeof body.max_tokens === "number") {
    out.generationConfig = { ...out.generationConfig, maxOutputTokens: body.max_tokens };
  } else if (typeof body.max_completion_tokens === "number") {
    out.generationConfig = { ...out.generationConfig, maxOutputTokens: body.max_completion_tokens };
  }

  // n -> candidateCount (only when > 1).
  if (typeof body.n === "number" && body.n > 1) {
    out.generationConfig = { ...out.generationConfig, candidateCount: body.n };
  }

  // response_format -> structured output settings.
  const responseFormat = body.response_format;
  if (responseFormat && typeof responseFormat === "object") {
    const formatType = typeof responseFormat.type === "string" ? responseFormat.type.trim().toLowerCase() : "";
    if (formatType === "json_object") {
      out.generationConfig = { ...out.generationConfig, responseMimeType: "application/json" };
    } else if (formatType === "json_schema") {
      const generationConfig = { ...out.generationConfig, responseMimeType: "application/json" };
      delete (generationConfig as { responseSchema?: unknown }).responseSchema;
      const schema = responseFormat.json_schema?.schema;
      if (schema !== undefined) generationConfig.responseJsonSchema = schema;
      out.generationConfig = generationConfig;
    }
  }

  // modalities -> responseModalities.
  if (Array.isArray(body.modalities)) {
    const responseModalities: string[] = [];
    for (const modality of body.modalities) {
      if (typeof modality !== "string") continue;
      switch (modality.toLowerCase()) {
        case "text":
          responseModalities.push("TEXT");
          break;
        case "image":
          responseModalities.push("IMAGE");
          break;
        default:
          break;
      }
    }
    if (responseModalities.length > 0) {
      out.generationConfig = { ...out.generationConfig, responseModalities };
    }
  }

  // OpenRouter-style image_config.
  if (body.image_config && typeof body.image_config === "object") {
    const imageConfig: { aspectRatio?: string; imageSize?: string } = {};
    if (typeof body.image_config.aspect_ratio === "string") imageConfig.aspectRatio = body.image_config.aspect_ratio;
    if (typeof body.image_config.image_size === "string") imageConfig.imageSize = body.image_config.image_size;
    if (Object.keys(imageConfig).length > 0) {
      out.generationConfig = { ...out.generationConfig, imageConfig };
    }
  }

  // --- messages --------------------------------------------------------------
  const messages = body.messages;
  if (Array.isArray(messages)) {
    const systemParts: GeminiPart[] = [];
    const contentItems: GeminiContent[] = [];

    // First pass: assistant tool_calls id -> name map.
    const toolCallIdToName = new Map<string, string>();
    for (const message of messages) {
      if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
      for (const toolCall of message.tool_calls) {
        if (toolCall.type !== "function") continue;
        const id = typeof toolCall.id === "string" ? toolCall.id : "";
        const name = typeof toolCall.function?.name === "string" ? toolCall.function.name : "";
        if (id !== "" && name !== "") toolCallIdToName.set(id, name);
      }
    }

    // Second pass: tool messages tool_call_id -> raw content.
    const toolResponses = new Map<string, unknown>();
    for (const message of messages) {
      if (message.role !== "tool") continue;
      const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
      if (toolCallId !== "") toolResponses.set(toolCallId, message.content);
    }

    for (const message of messages) {
      const role = typeof message.role === "string" ? message.role : "";
      const content = message.content;

      if ((role === "system" || role === "developer") && messages.length > 1) {
        if (typeof content === "string") {
          systemParts.push(textPart(content));
        } else if (content && typeof content === "object" && !Array.isArray(content) && (content as { type?: unknown }).type === "text") {
          systemParts.push(textPart(typeof (content as { text?: unknown }).text === "string" ? ((content as { text: string }).text) : ""));
        } else if (Array.isArray(content)) {
          for (const item of content) {
            const text = (item as { text?: unknown })?.text;
            systemParts.push(textPart(typeof text === "string" ? text : ""));
          }
        }
      } else if (role === "user" || ((role === "system" || role === "developer") && messages.length === 1)) {
        const partItems: GeminiPart[] = [];
        if (typeof content === "string") {
          partItems.push(textPart(content));
        } else if (Array.isArray(content)) {
          for (const item of content) {
            if (!item || typeof item !== "object") continue;
            const itemType = (item as { type?: unknown }).type;
            if (itemType === "text") {
              const text = (item as { text?: unknown }).text;
              if (typeof text === "string" && text !== "") partItems.push(textPart(text));
            } else if (itemType === "image_url" || itemType === "video_url") {
              const url = (item as { image_url?: { url?: unknown }; video_url?: { url?: unknown } }).image_url?.url ??
                (item as { video_url?: { url?: unknown } }).video_url?.url;
              if (typeof url === "string") {
                const parsed = parseDataUri(url);
                if (parsed) {
                  partItems.push(
                    inlineDataPart(parsed.mimeType, parsed.data, itemType === "image_url" ? GEMINI_FUNCTION_THOUGHT_SIGNATURE : "")
                  );
                }
              }
            } else if (itemType === "input_audio") {
              const audio = item as { input_audio?: { data?: unknown; format?: unknown } };
              const data = typeof audio.input_audio?.data === "string" ? audio.input_audio.data : "";
              if (data !== "") {
                const format = typeof audio.input_audio?.format === "string" ? audio.input_audio.format : "";
                partItems.push(inlineDataPart(openAiInputAudioMimeType(format), data, ""));
              }
            }
          }
        }
        contentItems.push(contentNode("user", partItems));
      } else if (role === "assistant") {
        const partItems: GeminiPart[] = [];
        if (typeof message.reasoning_content === "string" && message.reasoning_content !== "") {
          partItems.push({
            text: message.reasoning_content,
            thought: true,
            thoughtSignature: GEMINI_FUNCTION_THOUGHT_SIGNATURE
          });
        }
        if (typeof content === "string" && content !== "") {
          partItems.push(textPart(content));
        } else if (Array.isArray(content)) {
          for (const item of content) {
            if (!item || typeof item !== "object") continue;
            const itemType = (item as { type?: unknown }).type;
            if (itemType === "text") {
              const text = (item as { text?: unknown }).text;
              if (typeof text === "string" && text !== "") partItems.push(textPart(text));
            } else if (itemType === "image_url") {
              const url = (item as { image_url?: { url?: unknown } }).image_url?.url;
              if (typeof url === "string") {
                const parsed = parseDataUri(url);
                if (parsed) partItems.push(inlineDataPart(parsed.mimeType, parsed.data, GEMINI_FUNCTION_THOUGHT_SIGNATURE));
              }
            }
          }
        }

        const toolCalls = message.tool_calls;
        if (Array.isArray(toolCalls)) {
          const functionIds: string[] = [];
          for (const toolCall of toolCalls) {
            if (toolCall.type !== "function") continue;
            const functionId = typeof toolCall.id === "string" ? toolCall.id : "";
            const rawName = typeof toolCall.function?.name === "string" ? toolCall.function.name : "";
            const functionName = sanitizeFunctionName(rawName);
            if (functionName === "") continue;
            const part: GeminiPart = { functionCall: { name: functionName } };
            const argsString = typeof toolCall.function?.arguments === "string" ? toolCall.function.arguments : "";
            if (argsString !== "") {
              try {
                (part.functionCall as { args?: unknown }).args = JSON.parse(argsString);
              } catch {
                (part.functionCall as { args?: unknown }).args = argsString;
              }
            }
            part.thoughtSignature = toolCallThoughtSignature(toolCall as { [key: string]: unknown });
            partItems.push(part);
            if (functionId !== "") functionIds.push(functionId);
          }
          if (partItems.length > 0) {
            contentItems.push(contentNode("model", partItems));
          }

          // Append a single user content combining name + response per function.
          const responseParts: GeminiPart[] = [];
          for (const functionId of functionIds) {
            const name = toolCallIdToName.get(functionId);
            if (name === undefined) continue;
            let response: unknown = toolResponses.get(functionId);
            if (response === undefined) response = "{}";
            // Go writes the raw content as a JSON string value (double-encoded);
            // JSON.stringify of the parsed value reproduces that exactly.
            responseParts.push({
              functionResponse: { name: sanitizeFunctionName(name), response: { result: JSON.stringify(response) } }
            });
          }
          if (responseParts.length > 0) {
            contentItems.push(contentNode("user", responseParts));
          }
        } else if (partItems.length > 0) {
          contentItems.push(contentNode("model", partItems));
        }
      }
    }

    if (systemParts.length > 0) {
      out.systemInstruction = contentNode("user", systemParts);
    }
    // Drop a trailing model turn.
    if (contentItems.length > 0 && contentItems[contentItems.length - 1].role === "model") {
      contentItems.pop();
    }
    out.contents = contentItems;
  }

  // --- tools ------------------------------------------------------------------
  if (Array.isArray(body.tools)) {
    const functionDeclarations: GeminiFunctionDeclaration[] = [];
    const passthroughTools: GeminiTool[] = [];
    for (const tool of body.tools) {
      if (tool.type === "function" && tool.function && typeof tool.function === "object") {
        const fn: { name?: string; description?: string; parametersJsonSchema?: unknown; strict?: boolean; [key: string]: unknown } = {
          ...tool.function
        };
        if (fn.parameters !== undefined) {
          fn.parametersJsonSchema = fn.parameters;
          delete fn.parameters;
        } else {
          fn.parametersJsonSchema = { type: "object", properties: {} };
        }
        const originalName = typeof fn.name === "string" ? fn.name : "";
        const sanitizedName = sanitizeFunctionName(originalName);
        if (originalName === "" || sanitizedName !== originalName) {
          fn.name = sanitizedName;
        }
        if (fn.parametersJsonSchema !== undefined) {
          fn.parametersJsonSchema = sanitizeSchema(fn.parametersJsonSchema);
        }
        delete fn.strict;
        functionDeclarations.push(fn as unknown as GeminiFunctionDeclaration);
      }
      if (tool.google_search !== undefined) {
        passthroughTools.push({ googleSearch: tool.google_search });
      }
      if (tool.code_execution !== undefined) {
        passthroughTools.push({ codeExecution: tool.code_execution });
      }
      if (tool.url_context !== undefined) {
        passthroughTools.push({ urlContext: tool.url_context });
      }
    }
    const tools: GeminiTool[] = [];
    if (functionDeclarations.length > 0) tools.push({ functionDeclarations });
    tools.push(...passthroughTools);
    if (tools.length > 0) out.tools = tools;
  }

  out.safetySettings = defaultSafetySettings();
  return out;
}
