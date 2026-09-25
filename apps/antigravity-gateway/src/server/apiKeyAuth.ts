import { timingSafeEqual } from "node:crypto";

export function checkApiKey(request: Request, apiKeys: string[]): boolean {
  if (apiKeys.length === 0) return true;
  const provided = extractKey(request);
  if (provided === undefined) return false;
  const providedBuffer = Buffer.from(provided, "utf8");
  return apiKeys.some((key) => {
    const keyBuffer = Buffer.from(key, "utf8");
    if (keyBuffer.length !== providedBuffer.length) return false;
    return timingSafeEqual(keyBuffer, providedBuffer);
  });
}

function extractKey(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (match) return match[1].trim();
  }
  return request.headers.get("x-api-key") ?? undefined;
}
