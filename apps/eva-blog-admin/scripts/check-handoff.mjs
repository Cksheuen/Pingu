import { readFile } from "node:fs/promises";

const requiredFiles = [
  "package.json",
  "README.md",
  ".env.example",
  "docs/local-verification.md",
  "docs/deployment-handoff.md",
  "docs/design-handoff.md",
  "docs/verification-evidence.md",
  "vercel.json",
  "wrangler.toml",
  ".github/workflows/verify.yml"
];

const requiredEnv = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "SESSION_SECRET",
  "AI_PROVIDER",
  "AI_API_KEY",
  "BLOG_STORAGE_NAMESPACE"
];

const failures = [];
const contents = new Map();

for (const file of requiredFiles) {
  try {
    contents.set(file, await readFile(file, "utf8"));
  } catch (error) {
    failures.push(`${file}: missing or unreadable (${error.message})`);
  }
}

if (!failures.length) {
  const readme = contents.get("README.md");
  const packageJsonText = contents.get("package.json");
  const envExample = contents.get(".env.example");
  const localVerification = contents.get("docs/local-verification.md");
  const deployment = contents.get("docs/deployment-handoff.md");
  const design = contents.get("docs/design-handoff.md");
  const evidence = contents.get("docs/verification-evidence.md");
  const wrangler = contents.get("wrangler.toml");
  const workflow = contents.get(".github/workflows/verify.yml");
  let vercel;

  try {
    vercel = JSON.parse(contents.get("vercel.json"));
  } catch (error) {
    failures.push(`vercel.json: invalid JSON (${error.message})`);
  }

  let packageJson;
  try {
    packageJson = JSON.parse(packageJsonText);
  } catch (error) {
    failures.push(`package.json: invalid JSON (${error.message})`);
  }

  for (const command of ["pnpm install", "pnpm test", "pnpm build", "pnpm smoke:dev"]) {
    requireIncludes(readme, command, `README.md must document ${command}`);
    requireIncludes(localVerification, command, `docs/local-verification.md must document ${command}`);
  }

  for (const env of requiredEnv) {
    requireIncludes(envExample, `${env}=`, `.env.example must include ${env}`);
    requireIncludes(deployment, env, `docs/deployment-handoff.md must document ${env}`);
  }

  for (const phrase of [
    "No custom VPS",
    "Cloudflare Pages",
    "Cloudflare D1",
    "Cloudflare KV",
    "GitHub OAuth",
    "deterministic-fallback",
    "GET /api/session",
    "wrangler secret put"
  ]) {
    requireIncludes(deployment, phrase, `deployment handoff must include ${phrase}`);
  }

  for (const section of [
    "## Pages",
    "## UI Element Inventory",
    "## Forms And Actions",
    "## Data Objects",
    "## Loading, Empty, And Error States",
    "## Design Model Prompts"
  ]) {
    requireIncludes(design, section, `design handoff must include ${section}`);
  }

  requireIncludes(wrangler, 'main = "server/worker.js"', "wrangler.toml must point at server/worker.js");
  requireIncludes(workflow, "pnpm verify", "GitHub workflow must run pnpm verify");
  for (const command of ["pnpm install", "pnpm test", "pnpm build", "pnpm smoke:dev", "pnpm verify:handoff", "pnpm verify"]) {
    requireIncludes(evidence, command, `verification evidence must include ${command}`);
  }
  requireMatches(evidence, /tests\s+\d+/, "verification evidence must include test count");
  requireMatches(evidence, /pass\s+\d+/, "verification evidence must include passing test count");
  requireIncludes(evidence, "fail 0", "verification evidence must include zero failed tests");
  requireIncludes(evidence, "Built dist", "verification evidence must include build output");
  requireIncludes(evidence, "Dev server smoke", "verification evidence must include bounded dev server smoke output");

  if (vercel) {
    if (vercel.buildCommand !== "pnpm build") {
      failures.push("vercel.json: buildCommand must be pnpm build");
    }
    if (vercel.outputDirectory !== "dist") {
      failures.push("vercel.json: outputDirectory must be dist");
    }
  }

  if (packageJson) {
    for (const script of ["test", "build", "smoke:dev", "verify:handoff", "verify"]) {
      if (!packageJson.scripts?.[script]) {
        failures.push(`package.json: missing ${script} script`);
      }
    }
    if (!packageJson.scripts?.verify?.includes("pnpm smoke:dev")) {
      failures.push("package.json: verify script must run pnpm smoke:dev");
    }
  }
}

if (failures.length) {
  console.error("Handoff verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Handoff verification passed for ${requiredFiles.length} files and ${requiredEnv.length} env vars.`);
}

function requireIncludes(content, needle, message) {
  if (!content.includes(needle)) {
    failures.push(message);
  }
}

function requireMatches(content, pattern, message) {
  if (!pattern.test(content)) {
    failures.push(message);
  }
}
