import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

class KV {
  values = new Map();
  async get(key, type) { const value = this.values.get(key); return value === undefined ? null : type === 'json' ? JSON.parse(value) : value; }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
  async list({ prefix, limit, cursor }) {
    const keys = [...this.values.keys()].filter(k => k.startsWith(prefix)).sort();
    const start = Number(cursor || 0), end = start + limit;
    return { keys: keys.slice(start, end).map(name => ({ name })), list_complete: end >= keys.length, cursor: String(end) };
  }
}
function setup(overrides = {}) {
  const env = { GENERATOR_PASSWORD: 'test-generator-secret', ADMIN_PASSWORD: 'legacy-secret', EMAIL_DOMAINS: 'example.com', FORWARD_TO: 'owner@example.net', TEMP_MAIL_MESSAGES: new KV(), ...overrides };
  const waits = [];
  const ctx = { waitUntil(promise) { waits.push(promise); } };
  const call = (path, method = 'GET', data, extraHeaders = {}) => worker.fetch(new Request('https://mail.example.com/generator/api' + path, {
    method, headers: { Authorization: 'Bearer test-generator-secret', 'Content-Type': 'application/json', ...extraHeaders },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }), env, ctx);
  return { env, ctx, call, waits };
}
function message(to) {
  return { to, from: 'sender@example.net', headers: new Headers({ subject: 'Test' }), raw: new Blob(['Message body']).stream(), forwarded: [], rejected: [], async forward(target) { this.forwarded.push(target); }, setReject(reason) { this.rejected.push(reason); } };
}

test('auth and origin checks protect creation, listing, target and status mutations', async () => {
  const { call } = setup();
  for (const [path, method, data] of [['/config','GET'],['/addresses','GET'],['/addresses','POST',{}],['/address','PATCH',{}]]) {
    assert.equal((await call(path,method,data,{Authorization:'Bearer wrong'})).status,401);
    assert.equal((await call(path,method,data,{Origin:'https://untrusted.example'})).status,403);
  }
  const response = await call('/config');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.equal((await response.json()).destination,'owner@example.net');
});
test('create exact-prefix addresses without a random suffix and forward only to the configured target', async () => {
  const { call, env, ctx } = setup();
  const a = await call('/addresses','POST',{prefix:'shopping',label:'购物'});
  assert.equal(a.status,201);
  const first = await a.json();
  const second = await (await call('/addresses','POST',{prefix:'work',destination:'attacker@example.org'})).json();
  assert.notEqual(first.address,second.address);
  assert.equal(first.address,'shopping@example.com');
  assert.equal(second.address,'work@example.com');
  const mail = message(first.address.toUpperCase());
  await worker.email(mail,env,ctx);
  assert.deepEqual(mail.forwarded,['owner@example.net']);
  assert.equal([...env.TEMP_MAIL_MESSAGES.values.keys()].some(k=>k.startsWith('message:')),false);
  assert.equal((await (await call('/addresses')).json()).results.length,2);
});
test('duplicate prefixes cannot replace or re-enable an existing address, including legacy mailboxes', async () => {
  const { call, env } = setup();
  const created = await (await call('/addresses','POST',{prefix:'mail',label:'Original'})).json();
  assert.equal(created.address,'mail@example.com');
  await call('/address','PATCH',{address:created.address,enabled:false});
  const duplicate = await call('/addresses','POST',{prefix:' MAIL ',label:'Replacement'});
  assert.equal(duplicate.status,409);
  assert.match((await duplicate.json()).error,/已存在/);
  const saved = await env.TEMP_MAIL_MESSAGES.get('forward-address:mail@example.com','json');
  assert.equal(saved.label,'Original'); assert.equal(saved.enabled,false);
  await env.TEMP_MAIL_MESSAGES.put('address:legacy@example.com',JSON.stringify({address:'legacy@example.com'}));
  assert.equal((await call('/addresses','POST',{prefix:'legacy'})).status,409);
  assert.equal(await env.TEMP_MAIL_MESSAGES.get('forward-address:legacy@example.com'),null);
});
test('previously generated addresses with random suffixes continue to forward', async () => {
  const { env, ctx } = setup();
  const address = 'mail.2847210b95d296195156@example.com';
  await env.TEMP_MAIL_MESSAGES.put('forward-address:'+address,JSON.stringify({address,label:'Original',enabled:true,created_at:new Date().toISOString()}));
  const mail = message(address); await worker.email(mail,env,ctx);
  assert.deepEqual(mail.forwarded,['owner@example.net']);
});
test('disabled addresses reject incoming mail and can be re-enabled without changing address', async () => {
  const { call, env, ctx } = setup();
  const { address } = await (await call('/addresses','POST',{})).json();
  assert.equal((await call('/address','PATCH',{address,enabled:false})).status,200);
  const denied = message(address); await worker.email(denied,env,ctx);
  assert.equal(denied.rejected.length,1); assert.deepEqual(denied.forwarded,[]);
  const list = await (await call('/addresses')).json(); assert.equal(list.results[0].enabled,false);
  await call('/address','PATCH',{address,enabled:true});
  const accepted = message(address); await worker.email(accepted,env,ctx);
  assert.deepEqual(accepted.forwarded,['owner@example.net']);
});
test('forward failures propagate instead of being swallowed or reported as successful', async () => {
  const { call, env, ctx } = setup();
  const { address } = await (await call('/addresses','POST',{})).json();
  const mail = message(address); mail.forward = async () => { throw new Error('destination not verified'); };
  await assert.rejects(worker.email(mail,env,ctx),/destination not verified/);
});
test('invalid targets, local loops and missing configuration cannot generate active addresses', async () => {
  for (const FORWARD_TO of ['', 'bad', 'another@example.com']) {
    const { call } = setup({FORWARD_TO});
    assert.equal((await call('/addresses','POST',{})).status,503);
    assert.equal((await (await call('/config')).json()).ready,false);
  }
  const { call } = setup({GENERATOR_PASSWORD:''}); assert.equal((await call('/config')).status,503);
});
test('strict validation covers domain, prefix, payload limits and mutation types', async () => {
  const { call } = setup();
  for (const data of [{domain:'another.example'}, {prefix:'has spaces'}, {prefix:'.'}, {prefix:'x'.repeat(25)}, {label:'x'.repeat(81)}, null, []]) {
    assert.equal((await call('/addresses','POST',data)).status,400);
  }
  assert.equal((await call('/addresses','POST',{label:'x'.repeat(5000)})).status,413);
  assert.equal((await call('/address','PATCH',{address:'test@example.com',enabled:'false'})).status,400);
  assert.equal((await call('/address','PATCH',{address:'test@example.com',enabled:false})).status,404);
});
test('pagination does not hide addresses when more than 100 exist', async () => {
  const { call, env } = setup();
  for (let i=0;i<101;i++) { const record={address:`mail.${i}@example.com`,label:'',enabled:true,created_at:new Date().toISOString()}; await env.TEMP_MAIL_MESSAGES.put('forward-address:'+record.address,JSON.stringify(record)); }
  const first=await (await call('/addresses')).json(); assert.equal(first.results.length,100); assert.ok(first.cursor);
  const second=await (await call('/addresses?cursor='+first.cursor)).json(); assert.equal(second.results.length,1); assert.equal(second.cursor,null);
});
test('legacy mailboxes and health remain functional, and old mail is never forwarded automatically', async () => {
  const { env, ctx, waits } = setup();
  const health=await worker.fetch(new Request('https://mail.example.com/health'),env,ctx);
  assert.equal((await health.json()).service,'temp-mail-worker');
  const created=await worker.fetch(new Request('https://mail.example.com/admin/new_address', {method:'POST',headers:{Authorization:'Bearer legacy-secret','Content-Type':'application/json'},body:JSON.stringify({name:'existing',domain:'example.com'})}),env,ctx);
  const account=await created.json(); assert.equal(account.address,'existing@example.com');
  const mail=message(account.address); await worker.email(mail,env,ctx); await Promise.all(waits);
  assert.deepEqual(mail.forwarded,[]);
  const inbox=await worker.fetch(new Request('https://mail.example.com/api/mails',{headers:{Authorization:'Bearer '+account.jwt}}),env,ctx);
  assert.equal((await inbox.json()).results.length,1);
});
test('generator assets have CSP, no-store, and no framing; legacy response remains unchanged', async () => {
  const { env, ctx } = setup({ASSETS:{fetch:async()=>new Response('<html>generator</html>',{headers:{'Content-Type':'text/html'}})}});
  const response=await worker.fetch(new Request('https://mail.example.com/generator/'),env,ctx);
  assert.match(response.headers.get('Content-Security-Policy'),/script-src 'self'/);
  assert.equal(response.headers.get('Cache-Control'),'no-store'); assert.equal(response.headers.get('X-Frame-Options'),'DENY');
  const redirect=await worker.fetch(new Request('https://mail.example.com/generator'),env,ctx);
  assert.equal(redirect.headers.get('Location'),'/generator/');
});
