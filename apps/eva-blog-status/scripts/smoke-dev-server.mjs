try {
  await main();
} catch (error) {
  if (error?.code === "EPERM" || String(error?.message || error).includes("listen EPERM")) console.log("Dev server smoke skipped: loopback listen is not permitted in this environment (EPERM).");
  else throw error;
}

async function main() {
  const { spawn } = await import("node:child_process");
  const { createServer } = await import("node:net");
  const host = "127.0.0.1";
  const port = await findOpenPort(host, createServer);
  const child = spawn(process.execPath, ["scripts/dev-server.mjs", `--host=${host}`, `--port=${port}`], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let exited = false;
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("exit", () => { exited = true; });
  try {
    await waitForHttp(`http://${host}:${port}/`, () => ({ exited, output }));
    await verifyText(`http://${host}:${port}/`, "Eva Status Publisher");
    await verifyText(`http://${host}:${port}/`, "eva-blog-author-api");
    await verifyText(`http://${host}:${port}/src/main.js`, "Connect background agent");
    await verifyText(`http://${host}:${port}/src/main.js`, "Publish to reader");
    await verifyJson(`http://${host}:${port}/api/local/signals`);
    await verifyAgent(`http://${host}:${port}/api/local/agent`);
    console.log(`Dev server smoke passed at http://${host}:${port} (4 checks).`);
  } finally {
    if (!exited) child.kill("SIGTERM");
  }
}

async function verifyText(url, expected) { const response = await fetch(url); const text = await response.text(); if (!response.ok || !text.includes(expected)) throw new Error(`${url} did not include ${expected}`); }
async function verifyJson(url) { const response = await fetch(url); const payload = await response.json(); if (!response.ok || !("tokenUsage" in payload) || !("nowPlaying" in payload)) throw new Error(`${url} did not return local signal contract`); }
async function verifyAgent(url) { const response = await fetch(url); const payload = await response.json(); if (!response.ok || typeof payload.status !== "string" || "token" in payload) throw new Error(`${url} did not return a safe local agent contract`); }
async function waitForHttp(url, getState) { const deadline = Date.now() + 5000; while (Date.now() < deadline) { const state = getState(); if (state.exited) throw new Error(`Dev server exited early.\n${state.output}`); try { if ((await fetch(url)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Dev server did not respond within 5000ms."); }
function findOpenPort(host, createServer) { return new Promise((resolve, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, host, () => { const address = server.address(); server.close(() => resolve(address.port)); }); }); }
