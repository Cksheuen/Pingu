// Minimal credential pool for personal use: scan the auth dir once at
// startup, use the first credential, refresh it in place when it expires,
// and drop it when refresh fails (the caller then tries the next one).
// No round-robin, no cooldown, no single-flight: one user, one or two
// accounts, sequential requests.

import { refreshAccessToken } from "./client.js";
import { listCredentials, writeCredentialAtomic, type Credential } from "./credentials.js";

// Refresh tokens this far before actual expiry to avoid edge-of-lifetime races.
const REFRESH_SKEW_MS = 300_000;

export class CredentialPool {
  private readonly authDir: string;
  private credentials: Credential[];

  private constructor(authDir: string, credentials: Credential[]) {
    this.authDir = authDir;
    this.credentials = credentials;
  }

  static async load(authDir: string): Promise<CredentialPool> {
    return new CredentialPool(authDir, await listCredentials(authDir));
  }

  get size(): number {
    return this.credentials.length;
  }

  // Snapshot of live credentials in fallback order.
  list(): Credential[] {
    return [...this.credentials];
  }

  isExpired(cred: Credential, now: number = Date.now()): boolean {
    return cred.timestamp + cred.expires_in * 1000 <= now + REFRESH_SKEW_MS;
  }

  // Return a usable credential, refreshing and persisting it in place when
  // expired. Returns null (and removes the credential) when refresh fails.
  async ensureFresh(cred: Credential): Promise<Credential | null> {
    if (!this.isExpired(cred)) return cred;
    try {
      const token = await refreshAccessToken(cred.refresh_token);
      const now = Date.now();
      const updated: Credential = {
        ...cred,
        access_token: token.access_token,
        // The refresh token may rotate; persist the new value when present.
        refresh_token: token.refresh_token ?? cred.refresh_token,
        expires_in: token.expires_in,
        timestamp: now,
        expired: new Date(now + token.expires_in * 1000).toISOString()
      };
      await writeCredentialAtomic(this.authDir, updated);
      this.replace(cred, updated);
      return updated;
    } catch {
      this.invalidate(cred);
      return null;
    }
  }

  // Remove a credential that cannot be recovered (refresh failed or the
  // upstream rejected it even with a fresh token).
  invalidate(cred: Credential): void {
    this.credentials = this.credentials.filter((c) => c !== cred && c.email !== cred.email);
  }

  private replace(oldCred: Credential, updated: Credential): void {
    const index = this.credentials.findIndex((c) => c === oldCred || c.email === oldCred.email);
    if (index >= 0) this.credentials[index] = updated;
    else this.credentials.push(updated);
  }
}
