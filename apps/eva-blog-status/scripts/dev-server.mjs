import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { readLocalSignals } from "./localSources.mjs";
import { readAgentState } from "./agentState.mjs";

const port = Number.parseInt(process.env.PORT || argValue("--port") || "4175", 10);
const host = process.env.HOST || argValue("--host") || "127.0.0.1";
if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
  throw new Error("Eva Status Publisher must bind to a loopback host; refusing to expose local signals on the network.");
}
const root = process.cwd();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/api/local/signals") {
      const signals = await readLocalSignals({ cwd: root, env: process.env });
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify(signals));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/local/agent") {
      const agent = await readAgentState(process.env);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify(agent));
      return;
    }
    const filePath = await resolvePath(decodeURIComponent(url.pathname));
    response.writeHead(200, { "Content-Type": contentType(filePath) });
    createReadStream(filePath).pipe(response);
  } catch (error) {
    response.writeHead(error.status || 500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(error.status === 404 ? "Not found" : String(error.message || error));
  }
});

server.listen(port, host, () => console.log(`Eva Status Publisher dev server: http://${host}:${port}`));

async function resolvePath(pathname) {
  if (pathname === "/" || pathname === "") return join(root, "app/index.html");
  const candidate = normalize(join(root, pathname));
  if (!candidate.startsWith(root)) throw Object.assign(new Error("Forbidden"), { status: 403 });
  try {
    const info = await stat(candidate);
    return info.isDirectory() ? join(candidate, "index.html") : candidate;
  } catch {
    if (!extname(pathname)) { await readFile(join(root, "app/index.html")); return join(root, "app/index.html"); }
    throw Object.assign(new Error("Not found"), { status: 404 });
  }
}

function contentType(filePath) {
  return ({ ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".ttf": "font/ttf" })[extname(filePath)] || "application/octet-stream";
}
function argValue(name) { const arg = process.argv.find((item) => item.startsWith(`${name}=`)); return arg ? arg.slice(name.length + 1) : ""; }
