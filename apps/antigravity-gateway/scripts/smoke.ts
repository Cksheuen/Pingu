import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/config";
import { createWorker } from "../src/server/worker";
import type { Worker } from "../src/server/worker";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const baseUrl = process.env.BASE_URL;
  if (baseUrl) {
    await runChecks(baseUrl);
    return;
  }

  const config = loadConfig(appRoot);
  const worker = createWorker({ config });
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(worker, request, response);
  });
  await new Promise<void>((listenResolve) => server.listen(0, "127.0.0.1", listenResolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("failed to acquire ephemeral port");
  }
  try {
    await runChecks(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((closeResolve) => server.close(() => closeResolve()));
  }
}

async function handleRequest(worker: Worker, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readRequestBody(request);
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(","));
    }
    headers.delete("host");
    const apiResponse = await worker.fetch(
      new Request(`http://127.0.0.1${request.url ?? "/"}`, {
        method: request.method,
        headers,
        body: body ? new Uint8Array(body) : undefined
      })
    );
    response.writeHead(apiResponse.status, Object.fromEntries(apiResponse.headers.entries()));
    if (apiResponse.body) {
      Readable.fromWeb(apiResponse.body as never).pipe(response);
    } else {
      response.end();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: "api_error", message } }));
  }
}

function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function runChecks(baseUrl: string): Promise<void> {
  const healthResponse = await fetch(`${baseUrl}/healthz`);
  assert.equal(healthResponse.status, 200, "healthz should return 200");
  const healthBody = (await healthResponse.json()) as { status?: string };
  assert.equal(healthBody.status, "ok", "healthz body should report status ok");

  const modelsResponse = await fetch(`${baseUrl}/v1/models`, {
    headers: { Authorization: "Bearer dev-local-key" }
  });
  assert.equal(modelsResponse.status, 200, "models should return 200");
  const modelsBody = (await modelsResponse.json()) as { data?: unknown[] };
  assert.ok(Array.isArray(modelsBody.data) && modelsBody.data.length > 0, "models data should be a non-empty array");

  console.log(`smoke ok: healthz + /v1/models (${modelsBody.data!.length} models) against ${baseUrl}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
