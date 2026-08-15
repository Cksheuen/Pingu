import type { ChildProcess } from "node:child_process";

try {
  await main();
} catch (error) {
  if (isListenDenied(error) && process.env.SMOKE_STRICT !== "1") {
    console.log("Dev server smoke skipped: loopback listen is not permitted in this environment (EPERM).");
  } else {
    throw error;
  }
}

async function main(): Promise<void> {
  const { spawn } = await import("node:child_process");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const host = process.env.SMOKE_HOST || "127.0.0.1";
  const port = Number.parseInt(String(process.env.SMOKE_PORT || await findOpenPort(host)), 10);
  const baseUrl = `http://${host}:${port}`;
  const stateDir = await mkdtemp(join(tmpdir(), "eva-blog-public-smoke-"));
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/dev-server.ts", `--host=${host}`, `--port=${port}`], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      EVA_BLOG_LOCAL_STATE: join(stateDir, "state.json")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  let exited = false;
  let exitCode: number | null = null;

  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk;
  });

  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk;
  });

  child.on("exit", (code: number | null) => {
    exited = true;
    exitCode = code;
  });

  try {
    await waitForHttp(`${baseUrl}/`, 5000, () => ({ exited, exitCode, output }));
    await verifyText(`${baseUrl}/`, "Eva Blog");
    await verifyText(`${baseUrl}/data/seed.json`, "Building a small publishing loop");
    await verifyText(`${baseUrl}/public/handoff/local-runbook.md`, "Eva Blog Public Reader Runbook");
    await verifyPublicBoundary(baseUrl);
    console.log(`Dev server smoke passed at ${baseUrl} (6 checks).`);
  } finally {
    await stopChild(child, () => exited);
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function verifyPublicBoundary(baseUrl: string): Promise<void> {
  const articlesResponse = await fetch(`${baseUrl}/api/articles`);
  if (!articlesResponse.ok) throw new Error(`${baseUrl}/api/articles returned ${articlesResponse.status}`);
  const articles = await articlesResponse.json() as Array<{ id?: string }>;
  const articleId = articles[0]?.id;
  if (!articleId) throw new Error("Public smoke expected a seeded published article.");
  const commentResponse = await fetch(`${baseUrl}/api/articles/${encodeURIComponent(articleId)}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: "anonymous smoke comment" })
  });
  if (commentResponse.status !== 401) throw new Error(`Anonymous public comment expected 401, received ${commentResponse.status}`);
  const authorResponse = await fetch(`${baseUrl}/api/articles`, { method: "POST", body: JSON.stringify({ title: "forbidden", content: "forbidden" }) });
  if (authorResponse.status !== 404) throw new Error(`Public author route expected 404, received ${authorResponse.status}`);
}

async function verifyText(url: string, expectedText: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  const text = await response.text();
  if (!text.includes(expectedText)) {
    throw new Error(`${url} did not include expected text: ${expectedText}`);
  }
}

interface ProcessState {
  exited: boolean;
  exitCode: number | null;
  output: string;
}

async function waitForHttp(url: string, timeoutMs: number, getProcessState: () => ProcessState): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    const { exited, exitCode, output } = getProcessState();
    if (exited) {
      throw new Error(`Dev server exited early with code ${exitCode}.\n${output}`);
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    await sleep(100);
  }

  throw new Error(`Dev server did not respond within ${timeoutMs}ms: ${lastError?.message || "unknown error"}\n${getProcessState().output}`);
}

async function stopChild(child: ChildProcess, isExited: () => boolean): Promise<void> {
  if (isExited()) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", resolve)),
    sleep(1500).then(() => {
      if (!isExited()) {
        child.kill("SIGKILL");
      }
    })
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function findOpenPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    import("node:net").then(({ createServer }) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, host, () => {
        const address = server.address();
        const selectedPort = typeof address === "object" && address ? address.port : 0;
        server.close(() => resolve(selectedPort));
      });
    }, reject);
  });
}

function isListenDenied(error: unknown): boolean {
  const err = error as { code?: string; syscall?: string; message?: string } | null | undefined;
  if (err?.code === "EPERM" && err?.syscall === "listen") {
    return true;
  }
  const text = String(err?.message || error || "");
  return text.includes("listen EPERM");
}
