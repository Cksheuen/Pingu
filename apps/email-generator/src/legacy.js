// Compatibility snapshot of the deployed temp-mail-worker, retrieved 2026-10-08.
// Existing mailbox APIs and storage behavior are preserved by the wrapper.
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, DELETE, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type, x-admin-auth");
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}
__name(json, "json");
function getEmailDomains(env) {
  return (env.EMAIL_DOMAINS || "").split(",").map((domain) => domain.trim().toLowerCase()).filter(Boolean);
}
__name(getEmailDomains, "getEmailDomains");
function normalizeAddress(address) {
  return (address || "").trim().toLowerCase();
}
__name(normalizeAddress, "normalizeAddress");
function isAllowedAddress(address, env) {
  const normalized = normalizeAddress(address);
  const domain = normalized.split("@").at(-1);
  return Boolean(normalized.includes("@") && getEmailDomains(env).includes(domain));
}
__name(isAllowedAddress, "isAllowedAddress");
function isAdminAuthorized(request, env) {
  const configuredPassword = env.ADMIN_PASSWORD;
  if (!configuredPassword) {
    return false;
  }
  const authHeader = request.headers.get("authorization") || "";
  const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  const adminHeader = request.headers.get("x-admin-auth");
  const urlPassword = new URL(request.url).searchParams.get("password");
  return authHeader === configuredPassword || bearer === configuredPassword || adminHeader === configuredPassword || urlPassword === configuredPassword;
}
__name(isAdminAuthorized, "isAdminAuthorized");
function getBearerToken(request) {
  const authHeader = request.headers.get("authorization") || "";
  return authHeader.match(/^Bearer\s+(.+)$/i)?.[1] || "";
}
__name(getBearerToken, "getBearerToken");
function base64UrlEncode(value) {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
__name(base64UrlEncode, "base64UrlEncode");
function createMailboxToken(address) {
  const now = Math.floor(Date.now() / 1e3);
  const header = base64UrlEncode(JSON.stringify({ alg: "dir", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      sub: address,
      jti: crypto.randomUUID(),
      iat: now
    })
  );
  const signature = base64UrlEncode(crypto.randomUUID());
  return `${header}.${payload}.${signature}`;
}
__name(createMailboxToken, "createMailboxToken");
function normalizeName(name) {
  return (name || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
}
__name(normalizeName, "normalizeName");
function paginate(items, request) {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
  return items.slice(offset, offset + limit);
}
__name(paginate, "paginate");
async function getAddressIndex(env) {
  return await env.TEMP_MAIL_MESSAGES.get("addresses:index", "json") || [];
}
__name(getAddressIndex, "getAddressIndex");
async function getAddressRecord(env, address) {
  return env.TEMP_MAIL_MESSAGES.get(`address:${address}`, "json");
}
__name(getAddressRecord, "getAddressRecord");
async function saveAddressRecord(env, record) {
  const index = await getAddressIndex(env);
  const nextIndex = index.includes(record.name) ? index : [record.name, ...index];
  await Promise.all([
    env.TEMP_MAIL_MESSAGES.put(`address:${record.name}`, JSON.stringify(record)),
    env.TEMP_MAIL_MESSAGES.put(`token:${record.jwt}`, record.name),
    env.TEMP_MAIL_MESSAGES.put("addresses:index", JSON.stringify(nextIndex))
  ]);
}
__name(saveAddressRecord, "saveAddressRecord");
async function listAddressRecords(env) {
  const index = await getAddressIndex(env);
  const records = await Promise.all(index.map((address) => getAddressRecord(env, address)));
  return records.filter(Boolean);
}
__name(listAddressRecords, "listAddressRecords");
async function resolveTokenAddress(request, env) {
  const token = getBearerToken(request);
  if (!token) {
    return "";
  }
  return normalizeAddress(await env.TEMP_MAIL_MESSAGES.get(`token:${token}`));
}
__name(resolveTokenAddress, "resolveTokenAddress");
async function listMessages(env, address) {
  const indexKey = `index:${address}`;
  const ids = await env.TEMP_MAIL_MESSAGES.get(indexKey, "json") || [];
  const messages = await Promise.all(
    ids.map((id) => env.TEMP_MAIL_MESSAGES.get(`message:${address}:${id}`, "json"))
  );
  return messages.filter(Boolean).sort((a, b) => b.received_at.localeCompare(a.received_at));
}
__name(listMessages, "listMessages");
async function deleteMessages(env, address) {
  const indexKey = `index:${address}`;
  const ids = await env.TEMP_MAIL_MESSAGES.get(indexKey, "json") || [];
  await Promise.all([
    env.TEMP_MAIL_MESSAGES.delete(indexKey),
    ...ids.map((id) => env.TEMP_MAIL_MESSAGES.delete(`message:${address}:${id}`))
  ]);
  return ids.length;
}
__name(deleteMessages, "deleteMessages");
async function handleMessages(request, env) {
  const url = new URL(request.url);
  const address = normalizeAddress(url.searchParams.get("address"));
  const tokenAddress = await resolveTokenAddress(request, env);
  const canAccess = isAdminAuthorized(request, env) || tokenAddress && tokenAddress === address;
  if (!canAccess) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isAllowedAddress(address, env)) {
    return json({ error: "address must use an allowed email domain" }, { status: 400 });
  }
  if (request.method === "DELETE") {
    const deleted = await deleteMessages(env, address);
    return json({ address, deleted });
  }
  return json({ address, messages: await listMessages(env, address) });
}
__name(handleMessages, "handleMessages");
async function handleCreateAddress(request, env) {
  if (!isAdminAuthorized(request, env)) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, { status: 400 });
  }
  const name = normalizeName(body.name);
  const domain = (body.domain || "").trim().toLowerCase();
  const address = normalizeAddress(`${name}@${domain}`);
  if (!name || !isAllowedAddress(address, env)) {
    return json({ error: "address must use an allowed email domain" }, { status: 400 });
  }
  const existing = await getAddressRecord(env, address);
  if (existing) {
    return json(existing);
  }
  const record = {
    id: crypto.randomUUID(),
    name: address,
    address,
    domain,
    jwt: createMailboxToken(address),
    created_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  await saveAddressRecord(env, record);
  return json(record);
}
__name(handleCreateAddress, "handleCreateAddress");
async function handleListAddresses(request, env) {
  if (!isAdminAuthorized(request, env)) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || url.searchParams.get("search") || url.searchParams.get("query") || url.searchParams.get("keyword") || url.searchParams.get("name") || "").toLowerCase();
  const records = (await listAddressRecords(env)).filter((record) => {
    return !query || record.name.toLowerCase().includes(query);
  });
  return json({ results: paginate(records, request) });
}
__name(handleListAddresses, "handleListAddresses");
async function handleNewAddressToken(request, env, id) {
  if (!isAdminAuthorized(request, env)) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  const records = await listAddressRecords(env);
  const record = records.find((item) => item.id === id);
  if (!record) {
    return json({ error: "address not found" }, { status: 404 });
  }
  record.jwt = createMailboxToken(record.address);
  await saveAddressRecord(env, record);
  return json({ jwt: record.jwt, token: record.jwt, address_token: record.jwt });
}
__name(handleNewAddressToken, "handleNewAddressToken");
async function handleApiMails(request, env) {
  const tokenAddress = await resolveTokenAddress(request, env);
  if (!tokenAddress) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  const messages = await listMessages(env, tokenAddress);
  return json({ results: paginate(messages, request) });
}
__name(handleApiMails, "handleApiMails");
async function handleCloudMailEmailList(request, env) {
  if (!isAdminAuthorized(request, env)) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, { status: 400 });
  }
  const address = normalizeAddress(body.toEmail);
  if (!isAllowedAddress(address, env)) {
    return json({ error: "address must use an allowed email domain" }, { status: 400 });
  }
  const messages = paginate(await listMessages(env, address), request).map((message) => ({
    id: message.id,
    fromEmail: message.from,
    toEmail: message.to,
    subject: message.headers.subject || "",
    text: message.raw,
    raw: message.raw,
    createdAt: message.received_at
  }));
  return json({ data: messages });
}
__name(handleCloudMailEmailList, "handleCloudMailEmailList");
async function storeEmail(message, env) {
  const to = normalizeAddress(message.to);
  if (!isAllowedAddress(to, env)) {
    message.setReject(`Domain is not accepted for ${to}`);
    return;
  }
  const id = crypto.randomUUID();
  const receivedAt = (/* @__PURE__ */ new Date()).toISOString();
  const headers = Object.fromEntries(message.headers.entries());
  const raw = await new Response(message.raw).text();
  const record = {
    id,
    from: message.from,
    to,
    received_at: receivedAt,
    headers,
    raw
  };
  const ttl = Number(env.MESSAGE_TTL_SECONDS) || DEFAULT_TTL_SECONDS;
  const indexKey = `index:${to}`;
  const ids = await env.TEMP_MAIL_MESSAGES.get(indexKey, "json") || [];
  await Promise.all([
    env.TEMP_MAIL_MESSAGES.put(`message:${to}:${id}`, JSON.stringify(record), {
      expirationTtl: ttl
    }),
    env.TEMP_MAIL_MESSAGES.put(indexKey, JSON.stringify([id, ...ids]), {
      expirationTtl: ttl
    })
  ]);
}
__name(storeEmail, "storeEmail");
var src_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return json({}, { status: 204 });
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "temp-mail-worker",
        email_domains: getEmailDomains(env)
      });
    }
    if (url.pathname === "/domains") {
      return json({ email_domains: getEmailDomains(env) });
    }
    if (url.pathname === "/admin/new_address" && request.method === "POST") {
      return handleCreateAddress(request, env);
    }
    if (url.pathname === "/admin/address" && request.method === "GET") {
      return handleListAddresses(request, env);
    }
    const tokenMatch = url.pathname.match(
      /^\/admin\/(?:address\/([^/]+)\/(?:new_token|token)|new_address_token\/([^/]+))$/
    );
    if (tokenMatch && request.method === "POST") {
      return handleNewAddressToken(request, env, tokenMatch[1] || tokenMatch[2]);
    }
    if (url.pathname === "/api/mails" && request.method === "GET") {
      return handleApiMails(request, env);
    }
    if (url.pathname === "/api/public/emailList" && request.method === "POST") {
      return handleCloudMailEmailList(request, env);
    }
    if (url.pathname === "/messages" && ["GET", "DELETE"].includes(request.method)) {
      return handleMessages(request, env);
    }
    return json({ error: "not found" }, { status: 404 });
  },
  async email(message, env, ctx) {
    ctx.waitUntil(storeEmail(message, env));
  }
};
export {
  src_default as default
};
