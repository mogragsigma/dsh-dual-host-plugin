import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Gateway} from '../bundle/index.js';
import {registerNativeTools} from '../bundle/native-tools.js';
import {createOnboardingFileTransfer} from '../bundle/onboarding-file-transfer.js';

// Synthetic tool events: these tests do not claim actual model or IM acceptance.
async function fixture(t,role='cloud',managed=false){
 const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'file-scope-'))),id=randomUUID();
 const root=path.join(parent,id),source=path.join(parent,'send'),inbox=path.join(parent,'inbox');
 for(const p of [root,source,inbox])fs.mkdirSync(p,{mode:0o700});
 const agent={id:'scope-agent',ctx:{preset:'standard'},session:{header:{cwd:source},deriveMessages:()=>[]}};
 const ctx={on(){},effect(){},agents:{list:()=>[agent],get:id=>id===agent.id?agent:undefined},agentPresets:{composedPreset:c=>c.preset}};
 const g=new Gateway(ctx,{role,stateDir:root+'/state',namespace:'managed-'+id,port:0,entryMode:'native',...(managed?{}:{fileTransfers:{enabled:true,sendRoots:[source],receiveRoot:inbox,maxBytes:2048}})},{now:()=>1000,secrets:{localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}});
 const tools=new Map();registerNativeTools({taskGateway:g,tools:{register:d=>tools.set(d.name,d)}});
 const records=new Map();let writes=0;
 const credentials={readRecord:async k=>structuredClone(records.get(k)),modifyRecord:async(k,fn)=>{const v=fn(structuredClone(records.get(k)));if(v!==undefined){records.set(k,v);writes++;}}};
 const m=managed?createOnboardingFileTransfer({g,root,credentials:()=>credentials}):null;
 const scope=()=>tools.get('task_file_scope').execute({},{agent,callId:randomUUID()});
 const enable=async()=>{const p=await m.preview({enabled:true,sendRoots:[source],maxBytes:2048});return m.apply({id:p.id,fingerprint:p.fingerprint,confirm:true});};
 t.after(async()=>{await m?.close();await g.close();fs.rmSync(parent,{recursive:true,force:true});});
 return {g,m,root,parent,source,inbox,agent,tools,records,scope,enable,writes:()=>writes};
}
for(const role of ['local','cloud'])test(`${role} native scope is read-only, task-independent and limited to current Host`,async t=>{
 const f=await fixture(t,role),before=f.g.db.prepare('SELECT total_changes() n').get().n;
 const s=await f.scope();assert.equal(s.host,role);assert.equal(s.scope,'current_host_only');
 assert.deepEqual(s.send_roots,[f.source]);assert.equal(s.receive_root,f.inbox);assert.equal(s.max_bytes,2048);assert.equal(s.checked_at,1000);
 assert.equal(s.receipt_classification.kind,'diagnostic_snapshot');assert(s.observation_only);assert.equal(s.peer_receipt_verified,false);assert.equal(s.grants_execution,false);assert.equal(s.repository_write_authorized,false);
 assert.equal(f.g.db.prepare('SELECT total_changes() n').get().n,before);
 assert.equal(f.g.files.list('task-'+randomUUID()).sent.length,0);
 s.send_roots.push('/unapproved');assert.deepEqual((await f.scope()).send_roots,[f.source]);
});
test('scope checks directory identity without reading files, enumerating children or using network',async t=>{
 const f=await fixture(t);fs.writeFileSync(path.join(f.source,'not-to-be-read.txt'),'PRIVATE_INPUT');
 const read=fs.readFileSync,list=fs.readdirSync,call=f.g.call;
 fs.readFileSync=fs.readdirSync=()=>{throw Error('UNEXPECTED_CONTENT_READ');};f.g.call=()=>{throw Error('UNEXPECTED_NETWORK');};
 try{const s=await f.scope();assert(!JSON.stringify(s).includes('PRIVATE_INPUT'));assert(!JSON.stringify(s).includes('not-to-be-read'));}
 finally{fs.readFileSync=read;fs.readdirSync=list;f.g.call=call;}
});
test('scope discovery does not grant source or direct-user send permission',async t=>{
 const f=await fixture(t);await f.scope();
 assert.throws(()=>f.tools.get('task_file_send').execute({task_id:'task-'+randomUUID(),file:'unapproved.txt'},{agent:f.agent,callId:randomUUID()}),/HUMAN_REQUEST_UNAVAILABLE/);
 assert.throws(()=>f.g.files.enqueue({id:'file-'+'a'.repeat(64),task_id:'task-'+randomUUID(),file:path.join(f.parent,'outside.txt')}),/SOURCE_DENIED/);
});
test('absent or older file engines report capability unavailable instead of private-state fallback',async t=>{
 const f=await fixture(t);for(const value of [undefined,{list(){throw Error('NOT_SCOPE');}}]){f.g.files=value;assert.throws(f.scope,/CAPABILITY_UNAVAILABLE/);}
});
test('native scope keeps native agent and call identity guards',async t=>{
 const f=await fixture(t),tool=f.tools.get('task_file_scope');
 assert.throws(()=>tool.execute({},{agent:f.agent}),/MISSING_CALL_ID/);
 assert.throws(()=>tool.execute({},{agent:{...f.agent,id:'foreign'},callId:randomUUID()}));
});
test('managed scope requires an enabled live grant, returns revision and never mutates it',async t=>{
 const f=await fixture(t,'cloud',true);assert.throws(f.scope,/CAPABILITY_UNAVAILABLE/);await f.enable();
 const before=JSON.stringify([...f.records]),s=await f.scope();assert.equal(s.revision,1);assert.match(s.scope_hash,/^[a-f0-9]{64}$/);assert.deepEqual(s.send_roots,[f.source]);
 assert.equal(JSON.stringify([...f.records]),before);assert.equal(f.writes(),1);
 const old=f.g.files,[key,p]=[...f.records][0];p.payload.enabled=false;p.payload.revision++;f.records.set(key,p);
 await assert.rejects(old.scope(),/DISABLED/);
});
test('changed authorized root fails rather than returning a fresh-looking stale scope',async t=>{
 const f=await fixture(t,'local',true);await f.enable();fs.renameSync(f.source,f.source+'-old');fs.mkdirSync(f.source,{mode:0o700});
 await assert.rejects(f.scope(),/ROOT_CHANGED/);assert.equal(f.writes(),1);
});
