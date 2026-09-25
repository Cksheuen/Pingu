// HTTP client for the Antigravity upstream.
// Daily base URL first, prod as fallback; 429/5xx/network errors advance to
// the next base URL, everything else (400/401/403) is returned as-is for the
// caller to handle at the credential layer.

import { fetchWithProxy } from "../net/proxy.js";
import { BASE_URLS, REQUEST_UA } from "../oauth/constants";

const GENERATE_PATH = "/v1internal:generateContent";
const STREAM_PATH = "/v1internal:streamGenerateContent?alt=sse";

export class UpstreamError extends Error {
  readonly status: number;
  readonly upstreamBody: string;

  constructor(status: number, upstreamBody: string) {
    super(`antigravity upstream returned ${status}`);
    this.name = "UpstreamError";
    this.status = status;
    this.upstreamBody = upstreamBody;
  }
}

export interface UpstreamRequest {
  accessToken: string;
  body: unknown;
  stream: boolean;
  signal?: AbortSignal;
  // Test hook: replace the fetch implementation.
  fetch?: typeof fetch;
}

async function drainText(res: Response): Promise<string> {
  try {
    return (await res.text()).trim();
  } catch {
    return "";
  }
}

// POST the envelope and return the first usable response. Throws UpstreamError
// when every base URL answered with a retryable status, or the last network
// error when every base URL was unreachable.
export async function callUpstream(req: UpstreamRequest): Promise<Response> {
  const transport = req.fetch ?? fetchWithProxy;
  const path = req.stream ? STREAM_PATH : GENERATE_PATH;
  let lastNetworkError: unknown = null;

  for (const base of BASE_URLS) {
    let res: Response;
    try {
      res = await transport(`${base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${req.accessToken}`,
          "User-Agent": REQUEST_UA
        },
        body: JSON.stringify(req.body),
        signal: req.signal
      });
    } catch (error) {
      lastNetworkError = error;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const body = await drainText(res);
      lastNetworkError = new UpstreamError(res.status, body);
      continue;
    }
    return res;
  }

  if (lastNetworkError instanceof UpstreamError) throw lastNetworkError;
  if (lastNetworkError instanceof Error) throw lastNetworkError;
  throw new Error("antigravity upstream: no base URLs configured");
}
