// Outbound HTTP proxy support.
// Node's built-in fetch does not honor HTTPS_PROXY/HTTP_PROXY on its own, so
// when a proxy is configured in the environment we route every outbound
// request through an undici ProxyAgent. The convention follows the standard
// env vars: HTTPS_PROXY (and lowercase) takes precedence, then HTTP_PROXY,
// then ALL_PROXY; NO_PROXY excludes hosts.

import { ProxyAgent, type Dispatcher } from "undici";

let cachedProxyUrl = "";
let cachedAgent: Dispatcher | undefined;

function readProxyUrl(): string {
  const candidates = [
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
    process.env.ALL_PROXY,
    process.env.all_proxy
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return "";
}

// Match a hostname against NO_PROXY: exact match or any subdomain of a listed
// domain. "*" matches everything.
export function noProxyMatches(hostname: string, noProxy?: string): boolean {
  const raw = noProxy ?? process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  if (raw.trim() === "") return false;
  const host = hostname.toLowerCase();
  for (const entry of raw.split(",")) {
    const pattern = entry.trim().toLowerCase().replace(/^\./, "");
    if (pattern === "") continue;
    if (pattern === "*") return true;
    if (host === pattern || host.endsWith(`.${pattern}`)) return true;
  }
  return false;
}

// Resolve the dispatcher for a target URL, or undefined for a direct
// connection. Only http/https proxies are supported (a socks:// value is a
// configuration error worth surfacing loudly).
export function proxyDispatcher(target: string | URL): Dispatcher | undefined {
  const url = typeof target === "string" ? new URL(target) : target;
  if (noProxyMatches(url.hostname)) return undefined;
  const proxyUrl = readProxyUrl();
  if (proxyUrl === "") return undefined;
  if (!/^https?:\/\//i.test(proxyUrl)) {
    throw new Error(`proxy protocol not supported (only http/https): ${proxyUrl}`);
  }
  if (cachedAgent === undefined || cachedProxyUrl !== proxyUrl) {
    cachedAgent = new ProxyAgent({ uri: proxyUrl });
    cachedProxyUrl = proxyUrl;
  }
  return cachedAgent;
}

// fetch wrapper that applies the environment proxy when one is configured.
export function fetchWithProxy(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const dispatcher = proxyDispatcher(url);
  if (dispatcher === undefined) return fetch(input, init);
  return fetch(input, { ...init, dispatcher } as RequestInit);
}
