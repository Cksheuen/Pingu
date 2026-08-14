import { cp, readFile, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createWorker } from "./server/worker.js";
import { createFileStorage } from "./server/devStorage.js";

const projectRoot = process.cwd();

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8"
};

const WORKER_ROUTES = ["/feed.xml", "/sitemap.xml", "/robots.txt"];

async function createDevWorker() {
  const seedData = JSON.parse(await readFile(join(projectRoot, "data/seed.json"), "utf8"));
  const statePath = process.env.EVA_BLOG_LOCAL_STATE || join(projectRoot, "../../.local/eva-blog-state.json");
  return createWorker({ seedData, storage: createFileStorage(statePath, seedData), env: process.env });
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function proxyToWorker(worker, request, response, url) {
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readRequestBody(request);
  const headers = new Headers(request.headers);
  headers.delete("host");
  const apiResponse = await worker.fetch(
    new Request(`http://eva-blog.local${url.pathname}${url.search}`, { method: request.method, headers, body }),
  );
  response.writeHead(apiResponse.status, Object.fromEntries(apiResponse.headers.entries()));
  response.end(Buffer.from(await apiResponse.arrayBuffer()));
}

function serveStaticFile(response, filePath) {
  return new Promise((resolve) => {
    response.writeHead(200, { "Content-Type": MIME_TYPES[extname(filePath)] || "application/octet-stream" });
    createReadStream(filePath)
      .on("end", resolve)
      .on("error", () => {
        response.writeHead(500);
        response.end("Internal error");
        resolve();
      })
      .pipe(response);
  });
}

// Dev server: /api and Worker-owned routes go through the same Worker fetch
// handler as production; /public and /data keep their URL prefixes (fonts,
// seed data, handoff docs) and are served straight from disk.
function evaBlogDevPlugin() {
  let worker;
  return {
    name: "eva-blog-dev",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        try {
          const url = new URL(request.url, "http://eva-blog.local");
          const pathname = decodeURIComponent(url.pathname);
          if (pathname.startsWith("/api/") || WORKER_ROUTES.includes(pathname) || pathname.startsWith("/media/")) {
            worker ??= await createDevWorker();
            await proxyToWorker(worker, request, response, url);
            return;
          }
          if (pathname.startsWith("/public/") || pathname.startsWith("/data/")) {
            const baseDir = join(projectRoot, pathname.startsWith("/public/") ? "public" : "data");
            const candidate = normalize(join(projectRoot, pathname));
            if (candidate === baseDir || candidate.startsWith(baseDir + sep)) {
              try {
                const info = await stat(candidate);
                if (info.isFile()) {
                  await serveStaticFile(response, candidate);
                  return;
                }
              } catch {
                // fall through to Vite
              }
            }
          }
          next();
        } catch (error) {
          response.writeHead(500, { "Content-Type": "text/plain" });
          response.end(String(error?.message || error));
        }
      });
    },
    // Build output must match the legacy dist layout consumed by Vercel and
    // the smoke test: hashed assets plus /public, /data and _headers.
    async closeBundle() {
      await cp(join(projectRoot, "public"), join(projectRoot, "dist/public"), { recursive: true });
      await cp(join(projectRoot, "data"), join(projectRoot, "dist/data"), { recursive: true });
      await writeFile(
        join(projectRoot, "dist/_headers"),
        "/*\n  Content-Security-Policy: default-src 'self'; img-src 'self' https://github.com data:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self';\n",
      );
      const size = await directorySize(join(projectRoot, "dist"));
      console.log(`Built dist (${Math.round(size / 1024)} KB).`);
    }
  };
}

async function directorySize(path) {
  const info = await stat(path);
  if (!info.isDirectory()) return info.size;
  const { readdir } = await import("node:fs/promises");
  let total = 0;
  for (const entry of await readdir(path)) {
    total += await directorySize(join(path, entry));
  }
  return total;
}

export default defineConfig({
  plugins: [react(), evaBlogDevPlugin()],
  publicDir: false,
  server: {
    port: 4173,
    strictPort: false
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
