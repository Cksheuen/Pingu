import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const dist = "dist";

await execFileAsync("node", ["scripts/generate-assets.mjs"]);
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp("app/index.html", `${dist}/index.html`);
await mkdir(`${dist}/src/domain`, { recursive: true });
await mkdir(`${dist}/src/services`, { recursive: true });
await cp("src/main.js", `${dist}/src/main.js`);
await cp("src/styles.css", `${dist}/src/styles.css`);
await cp("src/domain/publicBlog.js", `${dist}/src/domain/publicBlog.js`);
await cp("src/domain/publicStatus.js", `${dist}/src/domain/publicStatus.js`);
await cp("src/services/locale.js", `${dist}/src/services/locale.js`);
await cp("data", `${dist}/data`, { recursive: true });
await mkdir(`${dist}/public/assets`, { recursive: true });
await cp("public/assets", `${dist}/public/assets`, { recursive: true });
await writeFile(`${dist}/_headers`, `/*\n  Content-Security-Policy: default-src 'self'; img-src 'self' https://github.com data:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self';\n`);

const size = await directorySize(dist);
console.log(`Built ${dist} (${Math.round(size / 1024)} KB).`);

async function directorySize(path) {
  const info = await stat(path);
  if (!info.isDirectory()) {
    return info.size;
  }
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(path);
  let total = 0;
  for (const entry of entries) {
    total += await directorySize(`${path}/${entry}`);
  }
  return total;
}
