import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runModelCommand } from '../src/modelCli';
import { loadConfig } from '../src/config/config';
import { Dispatcher } from '../src/routing/dispatcher';

test('model CLI preserves config; removal blocks discovery and fallback; add re-enables', async () => {
 const root=mkdtempSync(join(tmpdir(),'pcpa-models-')); const path=join(root,'config.json');
 writeFileSync(path,JSON.stringify({apiKeys:['secret'],custom:42,providers:{relay:{type:'anthropic',baseUrl:'https://example.test',models:['old','other']}},routes:[{match:['old','other'],provider:'relay'}]}));
 try {
  runModelCommand(root,['add','new','--provider','relay','--target','upstream-new']);
  let config=loadConfig(root);
  const dispatcher=()=>new Dispatcher({config,fetch:async()=>{throw Error('No network');}});
  assert.equal((await dispatcher().resolveRoute('new'))?.targetModel,'upstream-new');
  runModelCommand(root,['remove','old']); config=loadConfig(root);
  assert.equal(await dispatcher().resolveRoute('old'),undefined);
  config.providers.relay.models=['old','other'];
  assert.equal(await dispatcher().resolveRoute('old'),undefined);
  assert.ok(!(await dispatcher().getAggregatedModels()).some(m=>m.id==='old'));
  assert.ok((await dispatcher().getAggregatedModels()).some(m=>m.id==='other'));
  runModelCommand(root,['add','old','--provider','relay']); config=loadConfig(root);
  assert.equal((await dispatcher().resolveRoute('old'))?.targetModel,'old');
  const saved=readFileSync(path,'utf8'); const doc=JSON.parse(saved);
  assert.equal(doc.custom,42); assert.deepEqual(doc.apiKeys,['secret']); assert.equal(statSync(path).mode & 0o777,0o600);
  assert.throws(()=>runModelCommand(root,['add','bad','--provider','absent']));
  assert.throws(()=>runModelCommand(root,['remove','old','--unexpected']));
  assert.equal(readFileSync(path,'utf8'),saved);
  runModelCommand(root,['list']);
 } finally {rmSync(root,{recursive:true,force:true});}
});
