import { mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

export interface Credential {
  type: "antigravity";
  access_token: string;
  refresh_token: string;
  expires_in: number;
  timestamp: number;
  expired: string;
  email: string;
  project_id: string;
}

// Mirrors antigravity.CredentialFileName in the Go reference.
export function credentialPath(authDir: string, email: string): string {
  const trimmed = email.trim();
  const filename = trimmed === "" ? "antigravity.json" : `antigravity-${trimmed}.json`;
  return join(authDir, filename);
}

function normalizeCredential(parsed: Partial<Credential>): Credential {
  return {
    type: "antigravity",
    access_token: typeof parsed.access_token === "string" ? parsed.access_token : "",
    refresh_token: typeof parsed.refresh_token === "string" ? parsed.refresh_token : "",
    expires_in: typeof parsed.expires_in === "number" ? parsed.expires_in : 0,
    timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : 0,
    expired: typeof parsed.expired === "string" ? parsed.expired : "",
    email: typeof parsed.email === "string" ? parsed.email : "",
    project_id: typeof parsed.project_id === "string" ? parsed.project_id : ""
  };
}

export async function readCredential(file: string): Promise<Credential> {
  const text = await readFile(file, "utf8");
  const parsed = JSON.parse(text) as Partial<Credential>;
  if (parsed.type !== "antigravity" || typeof parsed.access_token !== "string") {
    throw new Error(`invalid credential file: ${file}`);
  }
  return normalizeCredential(parsed);
}

// Write via tmp file + rename so a crash mid-write cannot corrupt the
// credential. The file is created with mode 0600.
export async function writeCredentialAtomic(authDir: string, cred: Credential): Promise<void> {
  await mkdir(authDir, { recursive: true });
  const target = credentialPath(authDir, cred.email);
  const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const file = await open(tmp, "w", 0o600);
  try {
    await file.writeFile(JSON.stringify(cred, null, 2) + "\n", "utf8");
    await file.chmod(0o600);
  } finally {
    await file.close();
  }
  await rename(tmp, target);
}

// Scan authDir for antigravity-*.json credential files. Unreadable or
// malformed files are skipped so one bad file cannot block startup.
export async function listCredentials(authDir: string): Promise<Credential[]> {
  let entries;
  try {
    entries = await readdir(authDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const credentials: Credential[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^antigravity-.+\.json$/.test(entry.name)) continue;
    try {
      credentials.push(await readCredential(join(authDir, entry.name)));
    } catch {
      // skip malformed credential files
    }
  }
  return credentials;
}
