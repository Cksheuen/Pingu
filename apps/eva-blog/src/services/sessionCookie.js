const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 14;

export async function createSignedSessionCookie(session, secret, options = {}) {
  const ttl = Math.max(60, Number(options.ttlSeconds || DEFAULT_TTL_SECONDS));
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = encodeJson({ session, issuedAt, expiresAt: issuedAt + ttl });
  const signature = await sign(payload, secret);
  return `${payload}.${signature}`;
}

export async function readSignedSessionCookie(cookieValue, secret, options = {}) {
  if (!cookieValue || !secret) return null;
  const [payload, signature] = String(cookieValue).split(".");
  if (!payload || !signature || !(await verify(payload, signature, secret))) return null;

  try {
    const decoded = decodeJson(payload);
    const now = Math.floor(Date.now() / 1000);
    if (!decoded?.session || Number(decoded.expiresAt) <= now) return null;
    if (options.maxAgeSeconds && Number(decoded.issuedAt) + Number(options.maxAgeSeconds) < now) return null;
    return decoded.session;
  } catch {
    return null;
  }
}

export async function getSessionFromRequest(request, secret, cookieName = "eva_session") {
  const cookies = parseCookies(request.headers.get("Cookie") || request.headers.get("cookie") || "");
  return readSignedSessionCookie(cookies[cookieName], secret);
}

export function createSessionCookieHeader(value, options = {}) {
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

export function createClearSessionCookieHeader(options = {}) {
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

function parseCookies(header) {
  return Object.fromEntries(header.split(";").map((part) => part.trim().split("=")).filter(([key, value]) => key && value));
}

async function sign(value, secret) {
  const key = await importKey(secret);
  return encodeBytes(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

async function verify(value, signature, secret) {
  try {
    const key = await importKey(secret);
    return crypto.subtle.verify("HMAC", key, decodeBytes(signature), new TextEncoder().encode(value));
  } catch {
    return false;
  }
}

function importKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function encodeJson(value) {
  return encodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson(value) {
  return JSON.parse(new TextDecoder().decode(decodeBytes(value)));
}

function encodeBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBytes(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
