import legacy from './legacy.js';

const PREFIX = 'forward-address:';
const API = '/generator/api';
const domains = (env) => (env.EMAIL_DOMAINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const normalize = (value) => String(value || '').trim().toLowerCase();
const publicRecord = ({ address, label, enabled, created_at }) => ({ address, label, enabled, created_at });
const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' },
});
class Problem extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function authorized(request, env) {
  const expected = env.GENERATOR_PASSWORD;
  if (!expected) throw new Problem(503, '管理密码尚未配置');
  const supplied = request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!supplied || supplied.length > 1024) return false;
  const encode = (s) => new TextEncoder().encode(s);
  const [a, b] = await Promise.all([expected, supplied].map(s => crypto.subtle.digest('SHA-256', encode(s))));
  let difference = 0;
  new Uint8Array(a).forEach((v, i) => { difference |= v ^ new Uint8Array(b)[i]; });
  return difference === 0;
}

function forwardingTarget(env) {
  const target = normalize(env.FORWARD_TO);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target) || domains(env).includes(target.split('@')[1])) {
    throw new Problem(503, '收件邮箱尚未配置，或会造成循环转发');
  }
  return target;
}

async function body(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new Problem(415, '需要 JSON 请求');
  const reader = request.body?.getReader();
  let size = 0, text = '';
  const decoder = new TextDecoder();
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) { await reader.cancel(); throw new Problem(413, '请求内容太长'); }
    text += decoder.decode(value, { stream: true });
  }
  try {
    const data = JSON.parse(text + decoder.decode());
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new Problem(400, '无效 JSON'); }
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ error: '不接受跨站请求' }, 403);
  if (!await authorized(request, env)) return json({ error: '密码不正确，请重新登录' }, 401);
  if (request.method === 'GET' && url.pathname === `${API}/config`) {
    let destination = '', ready = false;
    try { destination = forwardingTarget(env); ready = true; } catch {}
    return json({ domains: domains(env), destination, ready });
  }
  if (url.pathname === `${API}/addresses` && request.method === 'GET') {
    const cursor = url.searchParams.get('cursor') || undefined;
    if (cursor?.length > 2048) throw new Problem(400, '无效分页参数');
    const page = await env.TEMP_MAIL_MESSAGES.list({ prefix: PREFIX, limit: 100, cursor });
    // Read records, not list metadata: the latter may have a different cache age.
    const records = await Promise.all(page.keys.map(k => env.TEMP_MAIL_MESSAGES.get(k.name, 'json')));
    return json({ results: records.filter(Boolean).map(publicRecord), cursor: page.list_complete ? null : page.cursor });
  }
  if (url.pathname === `${API}/addresses` && request.method === 'POST') {
    forwardingTarget(env);
    const data = await body(request);
    const domain = normalize(data.domain || domains(env)[0]);
    const label = typeof data.label === 'string' ? data.label.trim() : '';
    const prefix = typeof data.prefix === 'string' ? data.prefix.trim().toLowerCase() : 'mail';
    if (!domains(env).includes(domain)) throw new Problem(400, '请选择可用域名');
    if (label.length > 80) throw new Problem(400, '备注不能超过 80 个字符');
    if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(prefix)) throw new Problem(400, '前缀需为 1–24 位小写字母、数字或连字符');
    const address = `${prefix}@${domain}`;
    if (await env.TEMP_MAIL_MESSAGES.get(`address:${address}`) || await env.TEMP_MAIL_MESSAGES.get(PREFIX + address)) {
      throw new Problem(409, '该邮箱地址已存在，请更换前缀或管理已有地址');
    }
    const record = { address, label, enabled: true, created_at: new Date().toISOString() };
    await env.TEMP_MAIL_MESSAGES.put(PREFIX + address, JSON.stringify(record));
    return json(record, 201);
  }
  if (url.pathname === `${API}/address` && request.method === 'PATCH') {
    const data = await body(request);
    const address = normalize(data.address);
    if (typeof data.enabled !== 'boolean' || address.length > 254) throw new Problem(400, '无效地址状态');
    const record = await env.TEMP_MAIL_MESSAGES.get(PREFIX + address, 'json');
    if (!record) throw new Problem(404, '未找到生成的地址');
    if (data.enabled) forwardingTarget(env);
    record.enabled = data.enabled;
    await env.TEMP_MAIL_MESSAGES.put(PREFIX + address, JSON.stringify(record));
    return json(publicRecord(record));
  }
  return json({ error: '未找到接口' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === API || url.pathname.startsWith(`${API}/`)) {
      try { return await handleApi(request, env); }
      catch (error) { return json({ error: error instanceof Problem ? error.message : '服务暂时不可用，请稍后重试' }, error instanceof Problem ? error.status : 503); }
    }
    if (url.pathname === '/generator' || url.pathname.startsWith('/generator/')) {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: securityHeaders });
      if (url.pathname === '/generator') return new Response(null, { status: 302, headers: { ...securityHeaders, Location: '/generator/' } });
      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(securityHeaders)) headers.set(key, value);
      return new Response(response.body, { status: response.status, headers });
    }
    return legacy.fetch(request, env, ctx);
  },
  async email(message, env, ctx) {
    const address = normalize(message.to);
    const record = await env.TEMP_MAIL_MESSAGES.get(PREFIX + address, 'json');
    if (!record) return legacy.email(message, env, ctx);
    if (!record.enabled) { message.setReject('This email address is disabled'); return; }
    const destination = forwardingTarget(env);
    // Await delivery handoff; never report a successful invocation on forward failure.
    // The generator does not store message bodies or change existing mailbox APIs.
    await message.forward(destination);
  },
};
