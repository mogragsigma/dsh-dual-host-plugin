import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Gateway} from '../bundle/index.js';
import {TaskJobs} from '../bundle/task-jobs.js';
import {registerNativeTools} from '../bundle/native-tools.js';
import {CAPABILITIES,requireCapability} from '../bundle/link-contract.js';
import {randomUUID} from 'node:crypto';
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'schedule-budget-')),jobs=new TaskJobs(root,()=>1000);
 t.after(()=>{jobs.db.close();fs.rmSync(root,{recursive:true,force:true});});
 const g={c:{role:'cloud'},io:{},store:{task:()=>({id:'t',blocked:false})},catalog:{head:()=>({goal:'legacy fixture',legacy:true,title:'test',spec_revision:1})},scheduler:{jobs,triggers:{list:()=>[]},workflows:{list:()=>[]}},assertDispatchFamily(){}};
 return {jobs,run:(args={})=>Gateway.prototype.callCore.call(g,'schedule',{task_id:'t',trigger_id:'once',policy:{provider:'p',model:'m'},...args},'cloud')};
}
test('explicit two-batch budget persists and returns separate model-request cap',async t=>{const f=fixture(t),r=await f.run({max_runs:2});assert.equal(r.max_runs,2);assert.equal(r.max_model_requests_per_run,6);assert.equal(f.jobs.get(r.job_id).max_runs,2);assert.equal((await f.run({max_runs:2})).job_id,r.job_id);await assert.rejects(f.run({max_runs:3}),/TRIGGER_CONFLICT/);assert.equal(f.jobs.get(r.job_id).max_runs,2);});
test('omitted budget preserves historical default and replay fingerprint',async t=>{const f=fixture(t),r=await f.run();assert.equal(r.max_runs,4);assert.equal((await f.run()).job_id,r.job_id);});
for(const value of [0,-1,11,1.5,'2',null])test('reject invalid batch budget '+JSON.stringify(value),async t=>{const f=fixture(t);await assert.rejects(f.run({max_runs:value}),/INVALID_JOB/);assert.equal(f.jobs.list('t').length,0);});
test('native schema routes the chosen budget without replacing model policy',async()=>{const tools=new Map(),seen=[];registerNativeTools({taskGateway:{c:{role:'local'},assertNativeAgent(){},call:(...a)=>{seen.push(a);return {status:'queued'};}},tools:{register:d=>tools.set(d.name,d)}});const x=tools.get('task_schedule');assert.equal(x.parameters.properties.max_runs.maximum,10);await x.execute({task_id:'t',provider:'p',model:'m',reasoning_effort:'high',max_runs:2},{agent:{id:'a'},callId:'x'});assert.equal(seen[0][1].max_runs,2);assert.equal(seen[0][1].policy.reasoningEffort,'high');});
for(const role of ['local','cloud'])test('native '+role+' schedule rejects omitted or invalid budget before any dispatch',()=>{
 const tools=new Map(),seen=[];registerNativeTools({taskGateway:{c:{role},assertNativeAgent(){},call:(...a)=>seen.push(a)},tools:{register:d=>tools.set(d.name,d)}});
 const x=tools.get('task_schedule');assert(x.parameters.required.includes('max_runs'));
 for(const value of [undefined,null,0,-1,11,1.5,'1'])assert.throws(()=>x.execute({task_id:'t',provider:'p',model:'m',...(value===undefined?{}:{max_runs:value})},{agent:{id:'a'},callId:'s67'}),/SCHEDULE_RUN_BUDGET_REQUIRED/);
 assert.equal(seen.length,0);
 x.execute({task_id:'t',provider:'p',model:'m',max_runs:1},{agent:{id:'a'},callId:'s67-valid'});assert.equal(seen[0][1].max_runs,1);
});
test('explicit budget fails closed against older peer, legacy schedule remains compatible',()=>{const own={schema:1,protocol:{min:1,max:1},role:'local',namespace:'test',plugin_version:'0.31.0-alpha.63',instance_id:randomUUID(),capabilities:{...CAPABILITIES}},remote={...own,role:'cloud',instance_id:randomUUID(),capabilities:{...CAPABILITIES}};delete remote.capabilities.schedule_budget;assert.throws(()=>requireCapability('schedule',own,remote,{max_runs:2}),/CAPABILITY_VERSION_INCOMPATIBLE/);requireCapability('schedule',own,remote,{});remote.capabilities.schedule_budget=1;requireCapability('schedule',own,remote,{max_runs:2});});
