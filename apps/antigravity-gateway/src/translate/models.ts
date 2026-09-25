// Static model catalog transcribed from CLIProxyAPI
// internal/registry/models/models.json (gemini section). The gateway exposes
// this list on GET /v1/models and uses the optional thinking metadata for the
// Anthropic adaptive-thinking budget fallback.

export interface ModelThinkingInfo {
  min?: number;
  max?: number;
  zero_allowed?: boolean;
  dynamic_allowed?: boolean;
  levels?: string[];
}

export interface ModelInfo {
  id: string;
  display_name: string;
  context_length: number;
  max_completion_tokens: number;
  thinking?: ModelThinkingInfo;
  // Optional fields from the ChatGPT/Codex subscription model catalog. They
  // are retained so native Responses clients can consume /v1/models without
  // losing reasoning or capability metadata during aggregation.
  max_context_window?: number;
  description?: string | null;
  base_instructions?: string;
  supported_reasoning_levels?: Array<{ effort: string; description?: string }>;
  default_reasoning_level?: string;
  use_responses_lite?: boolean;
  visibility?: string;
  shell_type?: string;
  supported_in_api?: boolean;
  priority?: number;
  support_verbosity?: boolean;
  default_verbosity?: string | null;
  apply_patch_tool_type?: string | null;
  web_search_tool_type?: string;
  truncation_policy?: { mode: string; limit: number };
  supports_image_detail_original?: boolean;
  experimental_supported_tools?: string[];
  input_modalities?: string[];
  supports_parallel_tool_calls?: boolean;
}

export const MODEL_CATALOG: ModelInfo[] = [
  {
    id: "gemini-2.5-pro",
    display_name: "Gemini 2.5 Pro",
    context_length: 1_048_576,
    max_completion_tokens: 65_536,
    thinking: { min: 128, max: 32_768, dynamic_allowed: true }
  },
  {
    id: "gemini-2.5-flash",
    display_name: "Gemini 2.5 Flash",
    context_length: 1_048_576,
    max_completion_tokens: 65_536,
    thinking: { max: 24_576, zero_allowed: true, dynamic_allowed: true }
  },
  {
    id: "gemini-2.5-flash-lite",
    display_name: "Gemini 2.5 Flash Lite",
    context_length: 1_048_576,
    max_completion_tokens: 65_536,
    thinking: { max: 24_576, zero_allowed: true, dynamic_allowed: true }
  },
  {
    id: "gemini-3-pro-preview",
    display_name: "Gemini 3 Pro Preview",
    context_length: 1_048_576,
    max_completion_tokens: 65_536,
    thinking: { min: 128, max: 32_768, dynamic_allowed: true, levels: ["low", "high"] }
  },
  {
    id: "gemini-3.1-pro-preview",
    display_name: "Gemini 3.1 Pro Preview",
    context_length: 1_048_576,
    max_completion_tokens: 65_536,
    thinking: { min: 128, max: 32_768, dynamic_allowed: true, levels: ["low", "medium", "high"] }
  },
  {
    id: "gemini-3.1-flash-image-preview",
    display_name: "Gemini 3.1 Flash Image Preview",
    context_length: 1_048_576,
    max_completion_tokens: 65_536,
    thinking: { min: 128, max: 32_768, dynamic_allowed: true, levels: ["minimal", "high"] }
  },
  {
    id: "gemini-3-flash-preview",
    display_name: "Gemini 3 Flash Preview",
    context_length: 1_048_576,
    max_completion_tokens: 65_536,
    thinking: { min: 128, max: 32_768, dynamic_allowed: true, levels: ["minimal", "low", "medium", "high"] }
  },
  {
    id: "gemini-3.1-flash-lite-preview",
    display_name: "Gemini 3.1 Flash Lite Preview",
    context_length: 1_048_576,
    max_completion_tokens: 65_536,
    thinking: { min: 128, max: 32_768, dynamic_allowed: true, levels: ["minimal", "high"] }
  },
  {
    id: "gemini-3-pro-image-preview",
    display_name: "Gemini 3 Pro Image Preview",
    context_length: 1_048_576,
    max_completion_tokens: 65_536,
    thinking: { min: 128, max: 32_768, dynamic_allowed: true, levels: ["low", "high"] }
  },
  {
    id: "gemini-3.5-flash",
    display_name: "Gemini 3.5 Flash",
    context_length: 1_048_576,
    max_completion_tokens: 65_536,
    thinking: { min: 128, max: 32_768, dynamic_allowed: true, levels: ["minimal", "low", "medium", "high"] }
  },
  {
    id: "gemini-3.5-flash-lite",
    display_name: "Gemini 3.5 Flash Lite",
    context_length: 1_048_576,
    max_completion_tokens: 65_536,
    thinking: { min: 128, max: 32_768, dynamic_allowed: true, levels: ["minimal", "low", "medium", "high"] }
  },
  {
    id: "gemini-3.6-flash",
    display_name: "Gemini 3.6 Flash",
    context_length: 1_048_576,
    max_completion_tokens: 65_536,
    thinking: { min: 128, max: 32_768, dynamic_allowed: true, levels: ["minimal", "low", "medium", "high"] }
  }
];

// Lookup by model id; mirrors registry.LookupModelInfo(name, "gemini").
export function lookupModelInfo(modelId: string | undefined): ModelInfo | undefined {
  if (!modelId) return undefined;
  return MODEL_CATALOG.find((model) => model.id === modelId);
}
