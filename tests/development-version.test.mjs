import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';
import {TaskJobs} from '../bundle/task-jobs.js';import {TaskJobs as PriorJobs} from './fixtures/v020-alpha6/task-jobs.js';
import {DevelopmentRuntime} from '../bundle/development-runtime.js';import {CAPABILITIES,requireCapability} from '../bundle/link-contract.js';
const policy={provider:'task-provider',model:'task-model',reasoningEffort:'high'};
for(const running of [false,true])test('actual alpha6 consumer holds new development job '+(running?'running':'queued')+' without replaying writes',()=>{
 const root=mkdtempSync(tmpdir()+'/s40-version-');let j=new TaskJobs(root);
 try{
  const row=j.enqueue({task_id:'fixture',trigger_id:'fixture',kind:'development',goal:'synthetic approved job',policy,version:'0.21.0',max_runs:1});j.db.prepare("UPDATE jobs SET approved_by='synthetic',status='queued' WHERE id=?").run(row.id);
  if(running)j.claim(new Set(['development']),new Set());j.close();j=new PriorJobs(root);j.recover(new Set(['development']));assert.equal(j.claim(new Set(['development']),new Set(['development'])),null);assert.equal(j.get(row.id).status,'needs_review');assert.equal(j.get(row.id).attempts,running?1:0);
  j.close();j=new TaskJobs(root);j.recover(new Set());assert.equal(j.claim(new Set(['development']),new Set()),null);assert.equal(j.get(row.id).version,'0.21.0');
 }finally{j.close();rmSync(root,{recursive:true,force:true});}
});
test('new runtime does not auto-upgrade an old development job into its new drain contract',async()=>{
 const runtime=Object.create(DevelopmentRuntime.prototype);let touched=false;runtime.g={scheduler:{jobs:{db:{prepare:()=>({get:()=>({version:'0.5.0'})})}}},repositories:{refresh:async()=>{touched=true;}}};
 await assert.rejects(runtime.schedule({approval_id:'old'}),/DEVELOPMENT_JOB_VERSION_REQUIRED/);assert.equal(touched,false);assert.throws(()=>runtime.canClaim({version:'0.19.2'}),/DEVELOPMENT_JOB_VERSION_REQUIRED/);
});
test('new development contract cannot silently forward to an older peer; ordinary intake remains compatible',()=>{
 const base={schema:1,protocol:{min:1,max:1},plugin_version:'0.21.0-alpha.1',namespace:'fixture',instance_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',capabilities:{...CAPABILITIES}};
 const local={...base,role:'local'},cloud={...base,role:'cloud',capabilities:{...CAPABILITIES,development:1}};
 assert.throws(()=>requireCapability('development_schedule',local,cloud),/CAPABILITY_VERSION/);assert.doesNotThrow(()=>requireCapability('accept',local,cloud));assert.equal(CAPABILITIES.development,2);
});
test('development-only durable contract cannot be assigned to a readonly plan',()=>{
 const root=mkdtempSync(tmpdir()+'/s40-version-'),j=new TaskJobs(root);try{assert.throws(()=>j.enqueue({task_id:'fixture',trigger_id:'fixture',kind:'plan',goal:'readonly',policy,version:'0.21.0'}),/INVALID_JOB_VERSION/);}finally{j.close();rmSync(root,{recursive:true,force:true});}
});

test('claim recovery capability refuses old peers without downgrading to untracked acquisition',()=>{
 const own={schema:1,protocol:{min:1,max:1},plugin_version:'0.21.0-alpha.5',namespace:'fixture',instance_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',role:'local',capabilities:{...CAPABILITIES}},remote={...own,role:'cloud',capabilities:{...CAPABILITIES}};delete remote.capabilities.development_claim;
 for(const method of ['development_bridge_claim_acquire','development_bridge_claim_receipt'])assert.throws(()=>requireCapability(method,own,remote),/CAPABILITY_UNAVAILABLE/);
 assert.doesNotThrow(()=>requireCapability('accept',own,remote));
});
