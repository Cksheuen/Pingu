export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function errorResponse(status: number, type: string, message: string): Response {
  return jsonResponse({ type: "error", error: { type, message } }, { status });
}

export class HttpError extends Error {
  readonly status: number;
  readonly type: string;

  constructor(status: number, type: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.type = type;
  }
}

export async function readJson<T>(request: Request): Promise<T> {
  const text = await request.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "invalid_request_error", "request body is not valid JSON");
  }
}

export function sseEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}
