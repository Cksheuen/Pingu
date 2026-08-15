import type { Session } from "../types";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 14;

interface SignedCookieOptions {
  ttlSeconds?: number;
  maxAgeSeconds?: number;
}

export async function createSignedSessionCookie(session: Session, secret: string, options: SignedCookieOptions = {}): Promise<string> {
  const ttl = Math.max(60, Number(options.ttlSeconds || DEFAULT_TTL_SECONDS));
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = encodeJson({ session, issuedAt, expiresAt: issuedAt + ttl });
  const signature = await sign(payload, secret);
  return `${payload}.${signature}`;
}

// secret 允许缺省：未配置 SESSION_SECRET 时等同无会话（函数内部已对 falsy 短路）。
export async function readSignedSessionCookie(cookieValue: string | null | undefined, secret: string | undefined, options: SignedCookieOptions = {}): Promise<Session | null> {
  if (!cookieValue || !secret) return null;
  const [payload, signature] = String(cookieValue).split(".");
  if (!payload || !signature || !(await verify(payload, signature, secret))) return null;

  try {
    const decoded = decodeJson(payload) as { session?: Session; expiresAt?: number; issuedAt?: number };
    const now = Math.floor(Date.now() / 1000);
    if (!decoded?.session || Number(decoded.expiresAt) <= now) return null;
    if (options.maxAgeSeconds && Number(decoded.issuedAt) + Number(options.maxAgeSeconds) < now) return null;
    return decoded.session;
  } catch {
    return null;
  }
}

export async function getSessionFromRequest(request: Request, secret: string | undefined, cookieName: string = "eva_session"): Promise<Session | null> {
  const cookies = parseCookies(request.headers.get("Cookie") || request.headers.get("cookie") || "");
  return readSignedSessionCookie(cookies[cookieName], secret);
}

interface CookieHeaderOptions {
  name?: string;
  maxAgeSeconds?: number;
  secure?: boolean;
}

export function createSessionCookieHeader(value: string, options: CookieHeaderOptions = {}): string {
  const parts = [
    `${options.name || "eva_session"}=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.max(60, Number(options.maxAgeSeconds || DEFAULT_TTL_SECONDS))}`
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function createClearSessionCookieHeader(options: CookieHeaderOptions = {}): string {
  const parts = [
    `${options.name || "eva_session"}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0"
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function parseCookies(header: string): Record<string, string> {
  return Object.fromEntries(header.split(";").map((part) => part.trim().split("=")).filter(([key, value]) => key && value));
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  return encodeBytes(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

async function verify(value: string, signature: string, secret: string): Promise<boolean> {
  try {
    const key = await importKey(secret);
    return crypto.subtle.verify("HMAC", key, decodeBytes(signature), new TextEncoder().encode(value));
  } catch {
    return false;
  }
}

function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function encodeJson(value: unknown): string {
  return encodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson(value: string): unknown {
  return JSON.parse(new TextDecoder().decode(decodeBytes(value)));
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
