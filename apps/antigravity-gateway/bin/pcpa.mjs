#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(appRoot, "node_modules", ".bin", "tsx");
const cli = join(appRoot, "src", "cli.ts");
const result = spawnSync(tsx, [cli, ...process.argv.slice(2)], {
  cwd: appRoot,
  stdio: "inherit"
});

if (result.error) {
  console.error(`unable to start pcpa: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
