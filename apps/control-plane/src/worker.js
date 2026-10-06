import {
  digest,
  open,
  seal,
  randomToken,
  session,
  validSession,
} from "./crypto.js";
import { parseNode, renderSubscription } from "./subscription.js";
const now = () => new Date().toISOString();
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
class Problem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new Problem(status, message);
};
const label = (v) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 80;
async function body(req) {
  if (!req.headers.get("content-type")?.startsWith("application/json"))
    fail(415, "需要 JSON 请求");
  const reader = req.body?.getReader();
  let text = "",
    size = 0;
  const decoder = new TextDecoder();
  if (reader)
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        text += decoder.decode();
        break;
      }
      size += value.length;
      if (size > 32768) {
        await reader.cancel();
        fail(413, "请求太大");
      }
      text += decoder.decode(value, { stream: true });
    }
  try {
    return JSON.parse(text);
  } catch {
    fail(400, "无效 JSON");
  }
}
async function all(env, sql, ...values) {
  return (
    await env.DB.prepare(sql)
      .bind(...values)
      .all()
  ).results;
}
async function one(env, sql, ...values) {
  return env.DB.prepare(sql)
    .bind(...values)
    .first();
}
async function run(env, sql, ...values) {
  return env.DB.prepare(sql)
    .bind(...values)
    .run();
}
function origin(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    fail(400, "节点 origin 必须为 HTTPS 地址");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    u.pathname !== "/" ||
    u.search ||
    u.hash ||
    !u.hostname.includes(".") ||
    /(^localhost$|\.local$|\.internal$|^[\d.]+$|:)/.test(u.hostname)
  )
    fail(400, "节点 origin 必须为公开 HTTPS 域名，不能包含路径或凭据");
  return u.origin;
}
async function control(env, node, data, fetcher) {
  const key = await open(node.key_cipher, env.DATA_KEY, `node:${node.id}`);
  const res = await fetcher(
    `${node.origin}/__pingu_gate__/control/v1/devices`,
    {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(12000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "User-Agent": "Pingu-Control/0.1",
      },
      body: JSON.stringify(data),
    },
  );
  if (!res.ok) throw new Error("node_unavailable");
  const result = await res.json();
  if (
    result.id !== data.id ||
    result.state !== (data.action === "revoke" ? "revoked" : "active")
  )
    throw new Error("invalid_node_response");
  return result;
}
async function meshControl(env, node, data, fetcher) {
  const key = await open(node.key_cipher, env.DATA_KEY, `node:${node.id}`);
  const res = await fetcher(`${node.origin}/__pingu_gate__/control/v1/mesh`, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(12000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "User-Agent": "Pingu-Control/0.1" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("mesh_unavailable");
  const result = await res.json();
  if (result.id !== data.id || result.state !== (data.action === "revoke" ? "revoked" : "active"))
    throw new Error("invalid_mesh_response");
  return result;
}
async function revokeMesh(env, id, fetcher) {
  await run(env, "UPDATE devices SET mesh_allowed=0 WHERE id=?", id);
  await run(env, "UPDATE mesh_assignments SET state='revoking' WHERE device_id=? AND state!='revoked'", id);
  const rows = await all(env, "SELECT a.generation,n.* FROM mesh_assignments a JOIN nodes n ON n.id=a.node_id WHERE a.device_id=? AND a.state!='revoked'", id);
  for (const row of rows) {
    try {
      await meshControl(env, row, { action: "revoke", id: `mesh-${id}-${row.generation}` }, fetcher);
      await run(env, "UPDATE mesh_assignments SET state='revoked',error=NULL,updated_at=? WHERE device_id=? AND generation=?", now(),id,row.generation);
    } catch {
      await run(env, "UPDATE mesh_assignments SET error='revoke_pending',updated_at=? WHERE device_id=? AND generation=?", now(),id,row.generation);
    }
  }
  return !(await one(env, "SELECT 1 FROM mesh_assignments WHERE device_id=? AND state!='revoked'",id));
}
async function allowMesh(env, id, fetcher) {
  const device = await one(env,"SELECT * FROM devices WHERE id=? AND status='active'",id);
  if (!device) fail(409,"只有活跃设备可以加入组网");
  if (!env.MESH_NODE_ID || !(await one(env,"SELECT id FROM nodes WHERE id=? AND enabled=1",env.MESH_NODE_ID))) fail(503,"组网控制节点尚未配置");
  if (device.mesh_allowed) return;
  if (!(await revokeMesh(env,id,fetcher))) fail(409,"之前的组网权限尚未完全撤销，请重试");
  const generation = crypto.randomUUID().replaceAll("-", "");
  // The assignment and permission are one transaction, before remote I/O.
  // A concurrent device revoke either sees this responsibility or prevents it.
  await env.DB.batch([
    env.DB.prepare("UPDATE devices SET mesh_allowed=1,mesh_generation=? WHERE id=? AND status='active' AND mesh_allowed=0").bind(generation,id),
    env.DB.prepare("INSERT OR IGNORE INTO mesh_assignments(device_id,generation,node_id,state,updated_at) SELECT ?,?,?,'active',? WHERE EXISTS(SELECT 1 FROM devices WHERE id=? AND mesh_allowed=1 AND mesh_generation=? AND status='active')").bind(id,generation,env.MESH_NODE_ID,now(),id,generation),
  ]);
}
async function enrollMesh(req,env,token,fetcher) {
  if (req.method !== "POST" || req.headers.has("Origin")) fail(403,"组网注册仅限设备客户端");
  const d = await one(env,"SELECT * FROM devices WHERE token_hash=? AND status='active' AND mesh_allowed=1",await digest(token));
  if (!d) fail(403,"此设备未被允许组网，或已撤销");
  const node = await one(env,"SELECT n.* FROM nodes n JOIN mesh_assignments a ON n.id=a.node_id WHERE a.device_id=? AND a.generation=? AND a.state='active' AND n.enabled=1",d.id,d.mesh_generation);
  if (!node) fail(503,"组网控制节点不可用");
  const grant = await meshControl(env,node,{ action:"enroll",id:`mesh-${d.id}-${d.mesh_generation}` },fetcher);
  const current = await one(env,"SELECT id FROM devices WHERE id=? AND status='active' AND mesh_allowed=1 AND mesh_generation=?",d.id,d.mesh_generation);
  if (!current) { await revokeMesh(env,d.id,fetcher); fail(403,"组网权限已撤销"); }
  const control = new URL(grant.control_url);
  if (control.protocol !== "https:" || control.username || control.password || !["", "/"].includes(control.pathname) || control.search || control.hash
    || typeof grant.auth_key !== "string" || !grant.auth_key || !/^pingu-[a-f0-9-]+$/.test(grant.hostname)
    || !/^100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.0\/24$/.test(grant.ipv4_cidr)) fail(503,"组网控制响应无效");
  return json({ control_url:grant.control_url, auth_key:grant.auth_key, hostname:grant.hostname, ipv4_cidr:grant.ipv4_cidr });
}
export async function syncDevice(env, id, fetcher = fetch) {
  const device = await one(env, "SELECT * FROM devices WHERE id=?", id);
  if (!device || !["pending", "active"].includes(device.status))
    fail(409, "设备不处于可同步状态");
  const nodes = await all(env, "SELECT * FROM nodes WHERE enabled=1");
  if (!nodes.length) fail(409, "请先添加可用节点");
  const token = await open(device.token_cipher, env.DATA_KEY, `device:${id}`);
  // Record responsibility before remote I/O, including partial failures. Revocation
  // tombstones on the node prevent a delayed request from resurrecting access.
  for (const node of nodes)
    await run(
      env,
      "INSERT OR IGNORE INTO assignments(device_id,node_id,state,updated_at) SELECT ?,?,'pending',? WHERE EXISTS(SELECT 1 FROM devices WHERE id=? AND status IN ('pending','active'))",
      id,
      node.id,
      now(),
      id,
    );
  const state = await one(env, "SELECT status FROM devices WHERE id=?", id);
  if (!["pending", "active"].includes(state.status)) fail(409, "设备正在撤销");
  await Promise.all(
    nodes.map(async (node) => {
      try {
        const result = await control(
          env,
          node,
          {
            action: "provision",
            id: `cloud-${id}`,
            token,
            owner: device.owner,
            name: device.name,
          },
          fetcher,
        );
        const parsed = parseNode(result.subscription, node.name);
        if (parsed["ws-opts"].path !== `/__pingu_device__/v1/${token}`)
          throw new Error("invalid_node_response");
        const uri = await seal(
          result.subscription.trim(),
          env.DATA_KEY,
          `uri:${id}:${node.id}`,
        );
        await run(
          env,
          "UPDATE assignments SET state='active',uri_cipher=?,error=NULL,updated_at=? WHERE device_id=? AND node_id=? AND EXISTS(SELECT 1 FROM devices WHERE id=? AND status IN ('pending','active'))",
          uri,
          now(),
          id,
          node.id,
          id,
        );
      } catch {
        // Keep the last usable URI through a temporary control API outage.
        await run(
          env,
          "UPDATE assignments SET state=CASE WHEN uri_cipher IS NULL THEN 'error' ELSE state END,error='node_unavailable',updated_at=? WHERE device_id=? AND node_id=? AND EXISTS(SELECT 1 FROM devices WHERE id=? AND status IN ('pending','active'))",
          now(),
          id,
          node.id,
          id,
        );
      }
    }),
  );
  await run(
    env,
    "UPDATE devices SET status='active' WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM assignments WHERE device_id=? AND state='active')",
    id,
    id,
  );
  const finalState = await one(
    env,
    "SELECT status FROM devices WHERE id=?",
    id,
  );
  if (!["pending", "active"].includes(finalState.status))
    fail(409, "设备已被撤销");
  return all(
    env,
    "SELECT node_id,state,error FROM assignments WHERE device_id=?",
    id,
  );
}
export async function revokeDevice(env, id, fetcher = fetch) {
  const d = await one(env, "SELECT id FROM devices WHERE id=?", id);
  if (!d) fail(404, "设备不存在");
  await run(
    env,
    "UPDATE devices SET status='revoking' WHERE id=? AND status!='revoked'",
    id,
  );
  await revokeMesh(env,id,fetcher);
  const nodes = await all(
    env,
    "SELECT n.* FROM nodes n JOIN assignments a ON n.id=a.node_id WHERE a.device_id=? AND a.state!='revoked'",
    id,
  );
  await Promise.all(
    nodes.map(async (node) => {
      try {
        await control(
          env,
          node,
          { action: "revoke", id: `cloud-${id}` },
          fetcher,
        );
        await run(
          env,
          "UPDATE assignments SET state='revoked',uri_cipher=NULL,error=NULL,updated_at=? WHERE device_id=? AND node_id=?",
          now(),
          id,
          node.id,
        );
      } catch {
        await run(
          env,
          "UPDATE assignments SET error='revoke_pending',updated_at=? WHERE device_id=? AND node_id=?",
          now(),
          id,
          node.id,
        );
      }
    }),
  );
  await run(
    env,
    "UPDATE devices SET status='revoked' WHERE id=? AND NOT EXISTS(SELECT 1 FROM assignments WHERE device_id=? AND state!='revoked') AND NOT EXISTS(SELECT 1 FROM mesh_assignments WHERE device_id=devices.id AND state!='revoked')",
    id,
    id,
  );
  return one(env, "SELECT id,status FROM devices WHERE id=?", id);
}
async function dispatch(req, env, fetcher) {
  const u = new URL(req.url),
    path = u.pathname;
  if (path === "/health") return json({ ok: true, service: "pingu-control" });
  if (!env.ADMIN_KEY || env.ADMIN_KEY.length < 32 || !env.DATA_KEY)
    fail(503, "服务尚未完成密钥配置");
  const meshPath = path.match(/^\/s\/([\w-]{43})\/mesh$/);
  if (meshPath) return enrollMesh(req,env,meshPath[1],fetcher);
  if (path.startsWith("/s/")) {
    if (req.method !== "GET") fail(405, "method not allowed");
    const token = path.slice(3),
      fmt = u.searchParams.get("format") || "";
    if (!/^[\w-]{43}$/.test(token)) fail(403, "订阅无效或已撤销");
    if (!["", "clash"].includes(fmt)) fail(400, "不支持的订阅格式");
    const d = await one(
      env,
      "SELECT id FROM devices WHERE token_hash=? AND status='active'",
      await digest(token),
    );
    if (!d) fail(403, "订阅无效或已撤销");
    const rows = await all(
      env,
      "SELECT a.*,n.name FROM assignments a JOIN nodes n ON n.id=a.node_id WHERE a.device_id=? AND a.state='active' AND n.enabled=1 ORDER BY n.id",
      d.id,
    );
    if (!rows.length) fail(503, "暂无可用节点");
    const entries = await Promise.all(
      rows.map(async (r) => ({
        uri: await open(r.uri_cipher, env.DATA_KEY, `uri:${d.id}:${r.node_id}`),
        label: `${r.name} · ${r.node_id}`,
      })),
    );
    return new Response(renderSubscription(entries, fmt), {
      headers: {
        "Content-Type":
          fmt === "clash"
            ? "application/yaml; charset=utf-8"
            : "text/plain; charset=utf-8",
      },
    });
  }
  if (!path.startsWith("/api/")) return env.ASSETS.fetch(req);
  const sameOrigin = req.headers.get("Origin") === u.origin;
  const bearer = req.headers.get("Authorization")?.startsWith("Bearer ")
    ? req.headers.get("Authorization").slice(7)
    : "";
  const bearerOK =
    bearer.length >= 32 &&
    (await digest(bearer)) === (await digest(env.ADMIN_KEY));
  if (req.method !== "GET" && !sameOrigin && !bearerOK)
    fail(403, "跨站请求被拒绝");
  if (path === "/api/login" && req.method === "POST") {
    const bucket = await digest(
      `${req.headers.get("CF-Connecting-IP") || "local"}:${Math.floor(Date.now() / 3600000)}`,
    );
    await run(env, "DELETE FROM login_limits WHERE expires<?", Date.now());
    await run(
      env,
      "INSERT INTO login_limits(bucket,attempts,expires) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1",
      bucket,
      Date.now() + 3600000,
    );
    const limits = await one(
      env,
      "SELECT attempts FROM login_limits WHERE bucket=?",
      bucket,
    );
    if (limits.attempts > 20) fail(429, "登录尝试过多，请稍后再试");
    const data = await body(req);
    const loginKey = typeof data.key === "string" ? data.key.trim() : "";
    const loginDigest = await digest(loginKey);
    if (
      !loginKey ||
      loginKey.length > 256 ||
      (loginDigest !== (await digest(env.ADMIN_KEY)) &&
        (!env.ADMIN_PASSWORD ||
          loginDigest !== (await digest(env.ADMIN_PASSWORD))))
    )
      fail(401, "管理密码无效");
    return json({ ok: true }, 200, {
      "Set-Cookie": `pingu_control=${await session(env.ADMIN_KEY)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600`,
    });
  }
  const cookie = req.headers
    .get("Cookie")
    ?.match(/(?:^|;\s*)pingu_control=([^;]+)/)?.[1];
  if (!bearerOK && !(await validSession(env.ADMIN_KEY, cookie)))
    fail(401, "请先登录");
  if (path === "/api/logout" && req.method === "POST")
    return json({ ok: true }, 200, {
      "Set-Cookie":
        "pingu_control=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
    });
  if (path === "/api/state" && req.method === "GET")
    return json({
      nodes: await all(
        env,
        "SELECT id,name,origin,enabled,updated_at FROM nodes ORDER BY id",
      ),
      devices: await all(
        env,
        "SELECT id,owner,name,status,created_at,mesh_allowed FROM devices ORDER BY created_at DESC",
      ),
      mesh_assignments: await all(env,"SELECT device_id,state,error FROM mesh_assignments"),
      assignments: await all(
        env,
        "SELECT device_id,node_id,state,error,updated_at FROM assignments",
      ),
    });
  if (path === "/api/nodes" && req.method === "POST") {
    const data = await body(req);
    if (
      !Array.isArray(data.nodes) ||
      !data.nodes.length ||
      data.nodes.length > 16
    )
      fail(400, "nodes 必须为 1–16 个节点的数组");
    const existing = await all(env, "SELECT * FROM nodes");
    if (
      new Set([...existing, ...data.nodes].map((n) => n.id)).size > 16 ||
      new Set(data.nodes.map((n) => n.id)).size !== data.nodes.length
    )
      fail(400, "节点重复或超过 16 个");
    const statements = [];
    for (const n of data.nodes) {
      if (
        !/^[a-z0-9-]{1,32}$/.test(n.id || "") ||
        !label(n.name) ||
        typeof n.enabled !== "boolean"
      )
        fail(400, "节点字段无效");
      const o = origin(n.origin),
        previous = existing.find((x) => x.id === n.id);
      if (previous && previous.origin !== o)
        fail(
          409,
          "已有节点 origin 不能覆盖，请使用新的节点 id，以保留旧节点撤销能力",
        );
      const key = n.key
        ? typeof n.key === "string" && /^[\w-]{32,256}$/.test(n.key)
          ? await seal(n.key, env.DATA_KEY, `node:${n.id}`)
          : fail(400, "节点控制密钥无效")
        : previous?.key_cipher;
      if (!key) fail(400, "新节点需要控制密钥");
      statements.push(
        env.DB.prepare(
          "INSERT INTO nodes(id,name,origin,key_cipher,enabled,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,key_cipher=excluded.key_cipher,enabled=excluded.enabled,updated_at=excluded.updated_at",
        ).bind(n.id, n.name.trim(), o, key, Number(n.enabled), now()),
      );
    }
    await env.DB.batch(statements);
    return json({ ok: true });
  }
  if (path === "/api/devices" && req.method === "POST") {
    const data = await body(req),
      id = data.id;
    if (
      !/^[a-f0-9]{32}$/.test(id || "") ||
      !label(data.owner) ||
      !label(data.name)
    )
      fail(400, "请输入用户和设备名称");
    if (!(await one(env, "SELECT id FROM nodes WHERE enabled=1 LIMIT 1")))
      fail(409, "请先添加节点");
    const token = randomToken();
    await run(
      env,
      "INSERT OR IGNORE INTO devices(id,owner,name,token_hash,token_cipher,status,created_at) VALUES(?,?,?,?,?,'pending',?)",
      id,
      data.owner.trim(),
      data.name.trim(),
      await digest(token),
      await seal(token, env.DATA_KEY, `device:${id}`),
      now(),
    );
    const device = await one(env, "SELECT * FROM devices WHERE id=?", id);
    if (device.owner !== data.owner.trim() || device.name !== data.name.trim())
      fail(409, "设备 id 已被使用");
    const assignments = await syncDevice(env, id, fetcher);
    return json(
      {
        id,
        subscription: `${u.origin}/s/${await open(device.token_cipher, env.DATA_KEY, `device:${id}`)}`,
        assignments,
      },
      201,
    );
  }
  const m = path.match(/^\/api\/devices\/([a-f0-9]{32})\/(sync|revoke|link|mesh)$/);
  if (m && req.method === "POST") {
    if (m[2] === "mesh") {
      const data = await body(req);
      if (typeof data.enabled !== "boolean") fail(400,"enabled 必须为布尔值");
      if (data.enabled) { await allowMesh(env,m[1],fetcher); return json({ok:true}); }
      if (!(await one(env,"SELECT id FROM devices WHERE id=?",m[1]))) fail(404,"设备不存在");
      return json({ok:await revokeMesh(env,m[1],fetcher)});
    }

    if (m[2] === "sync")
      return json({ assignments: await syncDevice(env, m[1], fetcher) });
    if (m[2] === "revoke") return json(await revokeDevice(env, m[1], fetcher));
    const d = await one(
      env,
      "SELECT * FROM devices WHERE id=? AND status IN ('active','pending')",
      m[1],
    );
    if (!d) fail(404, "设备不存在或已撤销");
    return json({
      subscription: `${u.origin}/s/${await open(d.token_cipher, env.DATA_KEY, `device:${d.id}`)}`,
    });
  }
  fail(404, "not found");
}
export async function handle(req, env, fetcher = fetch) {
  let result;
  try {
    result = await dispatch(req, env, fetcher);
  } catch (e) {
    result = json(
      { error: e instanceof Problem ? e.message : "服务暂不可用" },
      e instanceof Problem ? e.status : 503,
    );
  }
  const headers = new Headers(result.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  return new Response(result.body, { status: result.status, headers });
}
export default {
  fetch(req, env) {
    return handle(req, env);
  },
};
