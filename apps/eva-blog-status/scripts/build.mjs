import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
await execFileAsync("node", ["scripts/generate-assets.mjs"]);
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("app/index.html", "dist/index.html");
await cp("src", "dist/src", { recursive: true });
await cp("public", "dist/public", { recursive: true });
const html = await readFile("app/index.html", "utf8");
const apiOrigin = html.match(/meta name="eva-blog-author-api" content="([^"]+)"/)?.[1] || "http://127.0.0.1:4174";
await writeFile("dist/_headers", `/*\n  Content-Security-Policy: default-src 'self'; img-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${apiOrigin};\n`);
console.log(`Built dist (${Math.round(await directorySize("dist") / 1024)} KB).`);

async function directorySize(path) {
  const info = await stat(path);
  if (!info.isDirectory()) return info.size;
  const entries = await (await import("node:fs/promises")).readdir(path);
  let total = 0;
  for (const entry of entries) total += await directorySize(`${path}/${entry}`);
  return total;
}
