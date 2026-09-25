import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createInterface } from "node:readline";
import { buildAuthURL, defaultRedirectURI, exchangeCode, fetchUserInfo } from "./client.js";
import { CALLBACK_PATH, CALLBACK_PORT } from "./constants.js";
import { writeCredentialAtomic, type Credential } from "./credentials.js";
import { fetchProjectId } from "./onboard.js";

interface CallbackResult {
  code: string;
  state: string;
  error: string;
}

const CALLBACK_TIMEOUT_MS = 5 * 60_000;
const MANUAL_HINT_DELAY_MS = 15_000;

/**
 * Run the interactive Antigravity OAuth login flow:
 * state -> browser -> localhost callback -> token exchange -> userinfo ->
 * project discovery -> credential persisted to authDir.
 */
export async function runLogin(authDir: string): Promise<Credential> {
  const state = randomBytes(16).toString("hex");
  const redirectURI = defaultRedirectURI();
  const authURL = buildAuthURL(state, redirectURI);
  const { server, waitForCallback } = await startCallbackServer();

  console.log("Opening browser for antigravity authentication");
  openBrowser(authURL);
  console.log(`Visit the following URL to continue authentication:\n${authURL}`);
  console.log("Waiting for antigravity authentication callback...");

  let callback: CallbackResult;
  try {
    callback = await waitForCallbackOrInput(waitForCallback);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  if (callback.error !== "") {
    throw new Error(`antigravity: authentication failed: ${callback.error}`);
  }
  if (callback.state !== state) {
    throw new Error("antigravity: invalid state");
  }
  if (callback.code === "") {
    throw new Error("antigravity: missing authorization code");
  }

  const token = await exchangeCode(callback.code, redirectURI);
  const accessToken = token.access_token.trim();
  if (accessToken === "") {
    throw new Error("antigravity: token exchange returned empty access token");
  }

  const email = (await fetchUserInfo(accessToken)).trim();
  if (email === "") {
    throw new Error("antigravity: empty email returned from user info");
  }

  const projectId = (await fetchProjectId(accessToken)).trim();
  if (projectId === "") {
    throw new Error("antigravity: project ID discovery returned empty project");
  }

  const now = Date.now();
  const credential: Credential = {
    type: "antigravity",
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? "",
    expires_in: token.expires_in,
    timestamp: now,
    expired: new Date(now + token.expires_in * 1000).toISOString(),
    email,
    project_id: projectId
  };
  await writeCredentialAtomic(authDir, credential);
  return credential;
}

function startCallbackServer(): Promise<{
  server: Server;
  waitForCallback: Promise<CallbackResult>;
}> {
  let resolveCallback!: (result: CallbackResult) => void;
  const waitForCallback = new Promise<CallbackResult>((resolve) => {
    resolveCallback = resolve;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === CALLBACK_PATH) {
      const result: CallbackResult = {
        code: url.searchParams.get("code")?.trim() ?? "",
        state: url.searchParams.get("state")?.trim() ?? "",
        error: url.searchParams.get("error")?.trim() ?? ""
      };
      resolveCallback(result);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        result.code !== "" && result.error === ""
          ? "<h1>Login successful</h1><p>You can close this window.</p>"
          : "<h1>Login failed</h1><p>Please check the CLI output.</p>"
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({ server, waitForCallback });
    });
  });
}

// Race the browser callback against a manual paste fallback and a 5-minute
// timeout. After 15s the user is told they can paste the callback URL.
function waitForCallbackOrInput(waitForCallback: Promise<CallbackResult>): Promise<CallbackResult> {
  let resolveManual: ((line: string) => void) | null = null;
  const manualInput = new Promise<CallbackResult>((resolve) => {
    resolveManual = (line: string) => resolve(parseCallbackUrl(line));
  });

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (resolveManual !== null && line.trim() !== "") {
      resolveManual(line);
    }
  });

  const hintTimer = setTimeout(() => {
    console.log(
      "If the browser did not open, authorize manually, then paste the full callback URL here and press Enter."
    );
  }, MANUAL_HINT_DELAY_MS);

  const timeout = new Promise<CallbackResult>((_, reject) => {
    setTimeout(() => reject(new Error("antigravity: authentication timed out")), CALLBACK_TIMEOUT_MS);
  });

  return Promise.race([waitForCallback, manualInput, timeout]).finally(() => {
    clearTimeout(hintTimer);
    rl.close();
  });
}

function parseCallbackUrl(line: string): CallbackResult {
  try {
    const parsed = new URL(line.trim());
    return {
      code: parsed.searchParams.get("code")?.trim() ?? "",
      state: parsed.searchParams.get("state")?.trim() ?? "",
      error: parsed.searchParams.get("error")?.trim() ?? ""
    };
  } catch {
    return { code: "", state: "", error: `invalid callback URL: ${line.trim()}` };
  }
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", (err) => {
      console.warn(
        `Failed to open browser automatically (${err.message}). Open the URL printed above manually.`
      );
    });
    child.unref();
  } catch (err) {
    console.warn(
      `Failed to open browser automatically (${(err as Error).message}). Open the URL printed above manually.`
    );
  }
}
