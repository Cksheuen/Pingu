import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/config";
import { CredentialPool } from "../src/oauth/credentialPool";
import { createWorker } from "../src/server/worker";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = loadConfig(appRoot);
const pool = await CredentialPool.load(config.authDir);
if (pool.size === 0) {
  console.warn(`antigravity-gateway: no credentials in ${config.authDir}; run "pnpm login:antigravity-gateway" first`);
}
const worker = createWorker({ config, pool });

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  void handleRequest(request, response);
});

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readRequestBody(request);
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(","));
    }
    headers.delete("host");
    const apiResponse = await worker.fetch(
      new Request(`http://${config.host}:${config.port}${request.url ?? "/"}`, {
        method: request.method,
        headers,
        body: body ? new Uint8Array(body) : undefined
      })
    );
    response.writeHead(apiResponse.status, Object.fromEntries(apiResponse.headers.entries()));
    if (apiResponse.body) {
      const stream = Readable.fromWeb(apiResponse.body as never);
      stream.on("error", (error) => {
        // Upstream disconnects must not become an uncaught process error.
        if (!response.headersSent) response.writeHead(502, { "Content-Type": "application/json" });
        if (!response.writableEnded) response.end(JSON.stringify({ type: "error", error: { type: "api_error", message: error instanceof Error ? error.message : String(error) } }));
      });
      response.on("close", () => stream.destroy());
      stream.pipe(response);
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

server.listen(config.port, config.host, () => {
  console.log(`antigravity-gateway: http://${config.host}:${config.port}`);
});
server.on("error", (error) => {
  console.error("antigravity-gateway server error", error);
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
