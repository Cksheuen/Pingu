try {
  await main();
} catch (error) {
  if (isListenDenied(error) && process.env.SMOKE_STRICT !== "1") {
    console.log("Dev server smoke skipped: loopback listen is not permitted in this environment (EPERM).");
  } else {
    throw error;
  }
}

async function main() {
  const { spawn } = await import("node:child_process");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const host = process.env.SMOKE_HOST || "127.0.0.1";
  const port = Number.parseInt(process.env.SMOKE_PORT || await findOpenPort(host), 10);
  const baseUrl = `http://${host}:${port}`;
  const stateDir = await mkdtemp(join(tmpdir(), "eva-blog-author-smoke-"));
  const child = spawn(process.execPath, ["scripts/dev-server.mjs", `--host=${host}`, `--port=${port}`], {
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
  let exitCode = null;

  child.stdout.on("data", (chunk) => {
    output += chunk;
  });

  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
  });

  try {
    await waitForHttp(`${baseUrl}/`, 5000, () => ({ exited, exitCode, output }));
    await verifyText(`${baseUrl}/`, "Eva Author Workspace");
    await verifyText(`${baseUrl}/src/main.js`, "Writing desk");
    await verifyText(`${baseUrl}/src/main.js`, "Status console");
    await verifyText(`${baseUrl}/data/seed.json`, "Building a small publishing loop");
    await verifyText(`${baseUrl}/public/handoff/local-runbook.md`, "Eva Blog Private Author Runbook");
    await verifyPrivateBoundary(baseUrl);
    console.log(`Dev server smoke passed at ${baseUrl} (7 checks).`);
  } finally {
    await stopChild(child, () => exited);
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function verifyPrivateBoundary(baseUrl) {
  const sessionResponse = await fetch(`${baseUrl}/api/session`);
  if (!sessionResponse.ok) throw new Error(`${baseUrl}/api/session returned ${sessionResponse.status}`);
  const statusResponse = await fetch(`${baseUrl}/api/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "work", title: "anonymous smoke status" })
  });
  if (statusResponse.status !== 401) throw new Error(`Anonymous author status expected 401, received ${statusResponse.status}`);
  const mockRoute = await fetch(`${baseUrl}/api/session/mock`, { method: "POST" });
  if (mockRoute.status !== 404) throw new Error(`Mock session route expected 404, received ${mockRoute.status}`);
}

async function verifyText(url, expectedText) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  const text = await response.text();
  if (!text.includes(expectedText)) {
    throw new Error(`${url} did not include expected text: ${expectedText}`);
  }
}

async function waitForHttp(url, timeoutMs, getProcessState) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

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
      lastError = error;
    }

    await sleep(100);
  }

  throw new Error(`Dev server did not respond within ${timeoutMs}ms: ${lastError?.message || "unknown error"}\n${output}`);
}

async function stopChild(child, isExited) {
  if (isExited()) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(1500).then(() => {
      if (!isExited()) {
        child.kill("SIGKILL");
      }
    })
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function findOpenPort(host) {
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

function isListenDenied(error) {
  if (error?.code === "EPERM" && error?.syscall === "listen") {
    return true;
  }
  const text = String(error?.message || error || "");
  return text.includes("listen EPERM");
}
