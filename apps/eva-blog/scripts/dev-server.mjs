import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { createWorker } from "../server/worker.js";
import { createFileStorage } from "../server/devStorage.js";

const port = Number.parseInt(process.env.PORT || argValue("--port") || "4173", 10);
const host = process.env.HOST || argValue("--host") || "127.0.0.1";
const root = join(process.cwd(), "dist");
const seedData = JSON.parse(await readFile(join(process.cwd(), "data/seed.json"), "utf8"));
const statePath = process.env.EVA_BLOG_LOCAL_STATE || join(process.cwd(), "../../.local/eva-blog-state.json");
const apiWorker = createWorker({ seedData, storage: createFileStorage(statePath, seedData), env: process.env });

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith("/api/")) {
      await proxyApi(request, response, url);
      return;
    }
    const filePath = await resolvePath(pathname);
    response.writeHead(200, { "Content-Type": contentType(filePath) });
    createReadStream(filePath).pipe(response);
  } catch (error) {
    response.writeHead(error.status || 500, { "Content-Type": "text/plain" });
    response.end(error.status === 404 ? "Not found" : String(error.message || error));
  }
});

async function proxyApi(request, response, url) {
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readRequestBody(request);
  const headers = new Headers(request.headers);
  headers.delete("host");
  const apiResponse = await apiWorker.fetch(new Request(`http://${host}:${port}${url.pathname}${url.search}`, { method: request.method, headers, body }));
  response.writeHead(apiResponse.status, Object.fromEntries(apiResponse.headers.entries()));
  response.end(Buffer.from(await apiResponse.arrayBuffer()));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

server.listen(port, host, () => {
  console.log(`Eva Blog preview server: http://${host}:${port}`);
});

async function resolvePath(pathname) {
  if (pathname === "/" || pathname === "") {
    return join(root, "index.html");
  }

  const candidate = normalize(join(root, pathname));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw Object.assign(new Error("Forbidden"), { status: 403 });
  }

  try {
    const info = await stat(candidate);
    if (info.isDirectory()) {
      return join(candidate, "index.html");
    }
    return candidate;
  } catch {
    if (!extname(pathname)) {
      await readFile(join(root, "index.html"));
      return join(root, "index.html");
    }
    throw Object.assign(new Error("Not found"), { status: 404 });
  }
}

function contentType(filePath) {
  const types = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ttf": "font/ttf",
    ".woff2": "font/woff2"
  };
  return types[extname(filePath)] || "application/octet-stream";
}

function argValue(name) {
  const arg = process.argv.find((item) => item.startsWith(`${name}=`));
  return arg ? arg.slice(name.length + 1) : "";
}
