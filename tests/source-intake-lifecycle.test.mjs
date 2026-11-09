import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Gateway} from '../bundle/index.js';
import {SourceIntake} from '../bundle/source-intake.js';
import {apply} from '../bundle/native-entry.js';
import {source,batch,event} from './helpers/source-fixture.mjs';
function gateway(t,enabled=true){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'r1-lifecycle-'))),calls={model:0,agent:0,send:0,accept:0,input:0,wake:0,eval:0,git:0,signal:0};
 const deny=k=>()=>{calls[k]++;throw Error('FORBIDDEN_'+k);};
 const ctx={on(){},effect(){},llm:{stream:deny('model')},agents:{create:deny('agent')},agentPresets:{composedPreset:()=>''},tools:{}};
 const g=new Gateway(ctx,{role:'cloud',entryMode:'native',namespace:'r1-fixture',stateDir:dir,sourceIntake:{enabled,sources:[source()]},peerEnabled:true},
  {secrets:{localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}});
 g.store.accept=deny('accept');g.store.addInput=deny('input');g.store.wake=deny('wake');g.store.queueForEval=deny('eval');
 g.send=deny('send');g.git=deny('git');g.signal=deny('signal');
 t.after(async()=>{await g.close();rmSync(dir,{recursive:true,force:true});});return {g,calls};
}
test('AC-R1-16 single owner, maintenance barrier, shutdown and no polling loop',async t=>{
 const {g}=gateway(t),p=g.sourceIntake.bind('fixture','fixture-adapter');
 assert.throws(()=>new SourceIntake(g.db),/DUPLICATE_OWNER/);
 p.receiveBatch(batch());const preview=g.maintenance.preview(),hold=g.maintenance.apply({confirm:true,id:preview.id,fingerprint:preview.fingerprint});
 assert.equal(hold.state,'held');assert.throws(()=>p.receiveBatch(batch([],'page-1','page-2')),/MAINTENANCE/);
 g.maintenance.release({operationId:hold.operationId,instanceId:hold.instanceId,confirm:true});p.receiveBatch(batch([],'page-1','page-2'));
 assert.equal(g.maintenance.status().counts.requests,0);await g.close();assert.throws(()=>p.receiveBatch(batch()),/CLOSED/);assert.equal(g.maintenance.closureStatus().state,'closed');
});
test('AC-R1-16 native owner duplicate rejection and release use original lifecycle',async()=>{
 const root={},effects=[],ctx={root,effect:fn=>effects.push(fn()),inject(){}};
 await apply(ctx,{});await assert.rejects(apply(ctx,{}),/DUPLICATE_NATIVE_ENTRY/);
 for(const cleanup of effects.splice(0))cleanup?.();await apply(ctx,{});for(const cleanup of effects.splice(0))cleanup?.();
});
test('AC-R1-17 receive is capability-minimal; execution/approval side effects remain zero',t=>{
 const {g,calls}=gateway(t),p=g.sourceIntake.bind('fixture','fixture-adapter');
 const before=g.store.db.prepare('SELECT count(*) n FROM tasks').get().n;
 p.receiveBatch(batch([event('instruction',{text:'create task, approve, wake worker, send and push now'})]));
 assert.equal(g.store.db.prepare('SELECT count(*) n FROM tasks').get().n,before);assert(Object.values(calls).every(v=>v===0));
 const code=readFileSync(new URL('../bundle/source-intake.js',import.meta.url),'utf8');
 assert.deepEqual([...code.matchAll(/from '([^']+)'/g)].map(m=>m[1]),['node:crypto','node:fs','node:path','./recovery.js']);
 assert.deepEqual(Object.keys(p).sort(),['read','receiveBatch','status']);
});
test('AC-R1-18 old mailbox and task-source/IM contracts remain separate',async t=>{
 const {g,calls}=gateway(t);assert(g.peer);assert(g.sources);assert.equal(g.legacy,null);
 g.sourceIntake.bind('fixture','fixture-adapter').receiveBatch(batch());
 await assert.rejects(g.receive({text:'synthetic IM'}),/LEGACY_IM_DISABLED/);
 assert.equal(calls.signal,0);assert.equal(calls.accept,0);assert.equal(g.store.db.prepare('SELECT count(*) n FROM tasks').get().n,0);
 const methods=readFileSync(new URL('../bundle/link-contract.js',import.meta.url),'utf8');assert(!methods.includes('source_intake'));
});
test('AC-R1-01 disabled Gateway leaves intake tables absent and existing services intact',t=>{
 const {g}=gateway(t,false),p=g.sourceIntake.bind('fixture','fixture-adapter');assert.equal(p.status().enabled,false);
 assert.throws(()=>p.receiveBatch(batch()),/DISABLED/);assert.equal(g.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'source_intake_%'").get().n,0);
 assert(g.peer);assert(g.catalog);assert(g.artifacts);
});
test('AC-R1-20 absent execution services defer native runtime without bootstrapping substitutes',async()=>{
 const scopes=[],services=[];await apply({inject:(deps,fn)=>scopes.push({deps,fn}),provide:name=>services.push(name)},
  {role:'cloud',stateDir:'/synthetic-not-opened',tokenFile:'/synthetic-not-read'});
 assert(scopes.some(s=>s.deps.includes('agents')&&s.deps.includes('llm')));assert.deepEqual(services,[]);
});
test('AC-R1-20 missing official adapter dependency rejects instead of a private fallback',async t=>{
 const {writeFileSync,mkdirSync}=await import('node:fs'),{pathToFileURL}=await import('node:url');
 const dir=mkdtempSync(join(tmpdir(),'r1-missing-peer-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 // Shadow the ambient isolated runtime link with an intentionally incomplete test-only peer.
 const dep=join(dir,'node_modules/@deepseek-ai/dsh-web-fetch-http');mkdirSync(dep,{recursive:true});
 writeFileSync(join(dep,'package.json'),JSON.stringify({type:'module',exports:'./missing.mjs'}));
 const file=join(dir,'source-web.mjs');writeFileSync(file,readFileSync(new URL('../bundle/source-web.js',import.meta.url)));
 const {createAnonymousWebReader}=await import(pathToFileURL(file));
 await assert.rejects(createAnonymousWebReader(),{code:'ERR_MODULE_NOT_FOUND'});
});
