// Agent envelope wrapping for the Antigravity upstream.
// Port of CLIProxyAPI geminiToAntigravity (internal/runtime/executor/antigravity_executor_request.go):
// the flat Gemini body is nested under "request", tagged with agent metadata,
// and stripped of safetySettings before it leaves the process.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { GeminiContent, GeminiRequestBody } from "../translate/types";

const SESSION_ID_MASK = 0x7fffffffffffffffn;

// Derive a stable session id from the first user text part, byte-identical to
// the Go reference: sha256(text) first 8 bytes as big-endian uint64, masked to
// 63 bits, with a "-" prefix. Falls back to a random id when the conversation
// has no user text.
export function deriveSessionId(contents: GeminiContent[] | undefined): string {
  if (Array.isArray(contents)) {
    for (const content of contents) {
      if (content.role !== "user") continue;
      const text = content.parts[0]?.text;
      if (typeof text === "string" && text !== "") {
        const digest = createHash("sha256").update(text).digest();
        const value = digest.readBigUInt64BE(0) & SESSION_ID_MASK;
        return `-${value.toString(10)}`;
      }
    }
  }
  return `-${(randomBytes(8).readBigUInt64BE(0) & SESSION_ID_MASK).toString(10)}`;
}

export interface AntigravityEnvelope {
  model: string;
  userAgent: "antigravity";
  requestType: "agent";
  project: string;
  requestId: string;
  request: Record<string, unknown>;
}

// Wrap a flat Gemini request body into the agent envelope.
export function wrapAntigravityEnvelope(
  model: string,
  geminiBody: GeminiRequestBody,
  projectId: string
): AntigravityEnvelope {
  // The upstream rejects safetySettings on agent requests; the Go reference
  // deletes them right before sending.
  const { safetySettings: _safetySettings, toolConfig, ...request } = geminiBody;
  return {
    model,
    userAgent: "antigravity",
    requestType: "agent",
    project: projectId,
    requestId: `agent-${randomUUID()}`,
    request: {
      ...request,
      ...(toolConfig !== undefined ? { toolConfig } : {}),
      sessionId: deriveSessionId(geminiBody.contents)
    }
  };
}
