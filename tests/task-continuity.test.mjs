import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Gateway} from '../bundle/index.js';
import {makeEnvelope} from '../bundle/task-envelope.js';
import {hash} from '../bundle/store.js';
import {registerNativeTools} from '../bundle/native-tools.js';
import {requireCapability} from '../bundle/link-contract.js';
import {fixture} from './helpers/continuity-fixture.mjs';
test('R2 native entry tools are additive, Host captures source and one private task domain',async t=>{
 const f=fixture(t);assert(f.tools.has('task_followup'));assert(f.tools.has('task_submit'));
 for(const entry of ['local-dsh','cloud-dsh','local-im','cloud-im']){const role=entry.split('-')[0],id=await f.create(entry,{role,session:entry});
  const s=f.source('同一意见',role,entry,entry);await f.g.call('task_followup',f.input(id,s),role);assert.equal(f.g.continuity.read(id).items[0].source.role,role);}
 const a=f.agent('new-session'),r=await f.tools.get('task_submit').execute({goal:'换会话测试',target:'cloud',intent:'register'},{agent:a,callId:'submit'});
 assert.equal(r.status,'accepted');assert.equal(f.g.continuity.state(r.task_id).state,'active');
 const reply=await f.tools.get('task_followup').execute({task_ids:[r.task_id],expected_revisions:{[r.task_id]:1}},{agent:f.agent('another-session','补充内容'),callId:'follow'});
 assert.equal(reply.status,'saved');assert.deepEqual(f.sideEffects,{agents:0,model:0});
 assert.throws(()=>f.tools.get('task_followup').execute({}, {agent:{id:'forged'},callId:'bad'}),/UNBOUND_NATIVE/);
});
test('R2 dedup is stable message identity, not text or title; conflicts atomic',async t=>{
 const f=fixture(t),id=await f.create(),a=f.input(id),r=await f.g.call('task_followup',a);
 assert.deepEqual(await f.g.call('task_followup',a),r);assert.equal(f.g.continuity.read(id).items.length,1);
 await assert.rejects(f.g.call('task_followup',{...a,mode:'reference'}),/CONFLICT/);
 await f.g.call('task_followup',f.input(id,f.source(a.source.text,'local')),'local');assert.equal(f.g.continuity.read(id).items.length,2);
 const second=await f.create();assert.notEqual(second,id);const ambiguous=f.g.continuity.resolve({query:'安装说明'});assert.equal(ambiguous.requires_clarification,true);
 assert.equal(f.g.continuity.resolve({query:'不存在'}).requires_clarification,true);assert.throws(()=>f.g.continuity.resolve({}),/REFERENCE_REQUIRED/);
 assert.throws(()=>f.g.continuity.receive('cloud',{...f.input(id),task_ids:[id,second],expected_revisions:{[id]:1,[second]:9}}),/REVISION_CONFLICT/);assert.equal(f.g.continuity.read(second).items.length,0);
});
test('R2 ordinary input preserves contract and authority; artifact ownership is exact',async t=>{
 const f=fixture(t),id=await f.create(),h=f.g.catalog.head(id);await f.g.call('task_followup',f.input(id));
 assert.deepEqual(f.g.catalog.head(id),h);assert.equal(f.g.approvals.list(id).length,0);
 await assert.rejects(f.g.call('task_followup',f.input(id,undefined,{artifact_id:'not-a-real-artifact'})),/ARTIFACT_NOT_FOUND/);
 assert.equal(f.g.continuity.read(id).items.length,1);
 await assert.rejects(f.g.call('task_followup',f.input(id,f.source('fake','local'))),/ORIGIN_MISMATCH/);
});
test('R2 worker delivery is data, all-owner handback gates reroute and no loop',async t=>{
 const f=fixture(t),a=await f.create('A'),b=await f.create('B'),c=await f.create('C');
 const r=await f.g.call('task_followup',{...f.input(a),task_ids:[a,b],expected_revisions:{[a]:1,[b]:1}});
 const job=id=>({task_id:id,run_id:'run-'+id,goal:f.g.catalog.head(id).goal});
 const x=f.g.continuity.workerRead(job(a),{});assert.equal(x.items[0].state,'delivered');assert.equal(x.items[0].applied,false);
 assert.equal(f.g.continuity.handback(job(a),{input_id:r.input_id,reason:'属于另一个对象'}).routing_required,false);
 const change={input_id:r.input_id,task_ids:[c],expected_revisions:{[c]:1},source:f.source('转给 C')};
 assert.throws(()=>f.g.continuity.reroute('cloud',change),/STILL_OWNED/);
 f.g.continuity.workerRead(job(b),{});assert.equal(f.g.continuity.handback(job(b),{input_id:r.input_id,reason:'不在范围'}).routing_required,true);
 const rerouted=f.g.continuity.reroute('cloud',change);assert.deepEqual(f.g.continuity.reroute('cloud',change),rerouted);
 assert.equal(f.g.continuity.read(c).items[0].source.text,f.g.continuity.read(a).items[0].source.text);
 f.g.continuity.workerRead(job(c),{});f.g.continuity.handback(job(c),{input_id:r.input_id,reason:'仍不属于'});
 assert.throws(()=>f.g.continuity.reroute('cloud',{...change,source:f.source(),task_ids:[a],expected_revisions:{[a]:1}}),/ALREADY_ROUTED/);
});
test('R2 extra thread unlink keeps history, origin and other task; reference never claims responsibility',async t=>{
 const f=fixture(t),a=await f.create('A'),b=await f.create('B'),r=await f.g.call('task_followup',f.input(a));
 await f.g.call('task_followup',f.input(b,undefined,{mode:'reference',thread_key:r.thread_key}));
 const u={task_id:a,thread_key:r.thread_key,source:f.source('取消 A 的关联')};assert.equal(f.g.continuity.unlink('cloud',u).history_retained,true);
 assert.equal(f.g.continuity.resolve({thread_key:r.thread_key}).items.length,1);assert.equal(f.g.continuity.read(a).items.length,1);
 assert.equal(f.g.continuity.state(a).state,'active');
 const origin=f.g.continuity.controlStatus(a).links.find(l=>l.origin);assert.throws(()=>f.g.continuity.unlink('cloud',{...u,thread_key:origin.thread_key,source:f.source()}),/ORIGIN_LINK_REQUIRED/);
});
test('R2 pause/drain/resume/stop; stale resume and per-job bypass denied, budgets unchanged',async t=>{
 const f=fixture(t),id=await f.create(),job=await f.g.call('schedule',{task_id:id,expected_revision:1,policy:{provider:'fixture',model:'fixture'},max_runs:3}),j=f.g.scheduler.jobs.get(job.job_id);
 let aborted=false;f.g.scheduler.active.set(j.id,{task_id:id,controller:{abort(){aborted=true;}},run:Promise.resolve()});
 const pause=await f.g.call('task_lifecycle',f.control(id,'pause'));assert.equal(pause.status,'draining');assert.equal(aborted,true);
 await assert.rejects(f.g.call('task_lifecycle',f.control(id,'resume')),/NOT_QUIESCENT/);
 f.g.scheduler.active.delete(j.id);const resumeArgs=f.control(id,'resume');assert.equal((await f.g.call('task_lifecycle',resumeArgs)).state,'active');
 assert.equal(f.g.scheduler.jobs.get(j.id).max_runs,3);
 const stop=await f.g.call('task_lifecycle',f.control(id,'stop'));assert.equal(stop.state,'stopped');assert.equal(f.g.scheduler.jobs.get(j.id).status,'cancelled');
 assert.equal((await f.g.call('task_lifecycle',resumeArgs)).state,'stopped');
 await assert.rejects(f.g.call('task_lifecycle',f.control(id,'resume')),/NOT_ALLOWED/);
 await f.g.call('task_followup',f.input(id));assert.equal(f.g.continuity.state(id).state,'stopped');
 await assert.rejects(f.g.call('schedule',{task_id:id}),/TASK_STOPPED/);await assert.rejects(f.g.call('job_control',{job_id:j.id,action:'resume',event_id:'bypass'}),/TASK_STOPPED/);
});
test('R2 repeated pause cannot lose ownership of paused jobs; independent pause retained',async t=>{
 const f=fixture(t),id=await f.create();const js=[0,1].map(i=>f.g.scheduler.jobs.enqueue({task_id:id,trigger_id:'job-'+i,goal:f.g.catalog.head(id).goal,policy:{provider:'fixture',model:'fixture'},max_runs:2}));
 f.g.scheduler.control({id:js[1].id,action:'pause',event_id:'independent',actor:'user'});
 await f.g.call('task_lifecycle',f.control(id,'pause'));await assert.rejects(f.g.call('task_lifecycle',f.control(id,'pause')),/NOT_ALLOWED/);
 await f.g.call('task_lifecycle',f.control(id,'resume'));assert.equal(f.g.scheduler.jobs.get(js[0].id).status,'queued');assert.equal(f.g.scheduler.jobs.get(js[1].id).status,'paused');
});
test('R2 new capability gates old peer; disabled adds no tools/tables; legacy stays legacy',async t=>{
 const off=fixture(t,{enabled:false}),on=fixture(t);assert(!off.tools.has('task_followup'));assert.equal(off.g.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='task_continuity_outbox'").get().n,0);
 const id=await off.create();assert.equal(off.g.catalog.head(id).spec_revision,1);
 const old=off.g.hello();old.role='local';assert.throws(()=>requireCapability('accept',on.g.hello(),old,{goal:JSON.stringify({continuity:1})}),/CAPABILITY/);
 await assert.rejects(off.g.call('task_followup',{}),/CAPABILITY/);
});
test('R2 durable offline outbox, unknown result replay, stale control and maintenance',async t=>{
 const cloud=fixture(t),local=fixture(t,{role:'local'}),id=await cloud.create();let offline=true,unknown=true;
 local.g.remoteTransport=async(method,args)=>{if(offline)throw Error('TRANSIENT_FAILURE');if(method==='negotiate')return {hello:cloud.g.hello()};const result=await cloud.g.call(method,args,'local');if(unknown){unknown=false;throw Error('TRANSIENT_FAILURE');}return {result,observation:cloud.g.observation()};};
 const a=cloud.input(id,local.source('离线补充','local'));
 assert.equal((await local.g.continuityOutbox.submit('task_followup',a)).cloud_accepted,false);
 offline=false;local.advance();await local.g.continuityOutbox.tick();assert.equal(cloud.g.continuity.read(id).items.length,1);
 local.advance();await local.g.continuityOutbox.tick();assert.equal(cloud.g.continuity.read(id).items.length,1);
 assert.equal((await local.g.continuityOutbox.submit('task_followup',a)).status,'saved');
 const preview=local.g.maintenance.preview(),hold=local.g.maintenance.apply({confirm:true,id:preview.id,fingerprint:preview.fingerprint});
 assert.throws(()=>local.g.continuityOutbox.submit('task_followup',{...a,source:local.source()}),/MAINTENANCE/);local.g.maintenance.release({operationId:hold.operationId,instanceId:hold.instanceId,confirm:true});
});
test('R2 worker binding checks current run; final report requires delivery; non-waking hint is not a receipt',async t=>{
 const f=fixture(t),id=await f.create();f.g.scheduler.jobs.enqueue({task_id:id,trigger_id:'claim',goal:f.g.catalog.head(id).goal,policy:{provider:'fixture',model:'fixture'},max_runs:3});
 const j=f.g.scheduler.jobs.claim(new Set(['plan']),new Set(['plan']),()=>true),a=f.agent('worker-probe');let hints=0;a.inject=()=>hints++;
 f.g.scheduler.worker.active.set(a.id,{agent:a,job:j,signal:new AbortController().signal,report:null});
 await f.g.call('task_followup',f.input(id));assert.equal(hints,1);assert.equal(f.g.continuity.read(id).items[0].state,'saved');
 assert.throws(()=>f.g.scheduler.worker.report(a,{outcome:'done',summary:'done'}),/PENDING_READ/);
 f.g.continuity.workerRead(f.g.scheduler.worker.binding(a).job,{});f.g.scheduler.worker.report(a,{outcome:'done',summary:'只读成果'});
 await f.g.call('task_lifecycle',f.control(id,'stop'));assert.throws(()=>f.g.scheduler.worker.binding(a),/STALE|STOPPED/);
 f.g.scheduler.worker.active.clear();
});
test('R2 restart retains tasks, inputs, links and terminal fence without replay',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'r2-reopen-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const f=fixture(t,{root:dir}),id=await f.create();const a=f.input(id),r=await f.g.call('task_followup',a);await f.g.call('task_lifecycle',f.control(id,'stop'));await f.g.close();
 const reopened=fixture(t,{root:dir});assert.equal(reopened.g.continuity.state(id).state,'stopped');assert.equal(reopened.g.continuity.read(id).items.length,1);
 assert.deepEqual(await reopened.g.call('task_followup',a),r);assert.equal(reopened.g.continuity.resolve({thread_key:r.thread_key}).items[0].task_id,id);
 assert.equal(reopened.g.continuity.canRun(id),false);
});
test('R2 task-wide fence prevents periodic materialization, preserves schedule and independent controls',async t=>{
 const f=fixture(t),id=await f.create(),h=f.g.catalog.head(id);
 const s=f.g.scheduler.triggers.create({task_id:id,revision:1,goal:h.goal,policy:JSON.parse(h.goal).model_policy,timing:{rule:{kind:'once',at:100000},end_at:1000000,max_occurrences:1,max_runs:2},dependencies:[],source:[f.source()],event_id:'schedule'});
 await f.g.call('task_lifecycle',f.control(id,'pause'));f.g.scheduler.triggers.tick();assert.equal(f.g.scheduler.jobs.list(id).length,0);
 assert.match(f.g.scheduler.triggers.get(s.id).status,/active/);
 await f.g.call('task_lifecycle',f.control(id,'resume'));f.g.scheduler.triggers.tick();assert.equal(f.g.scheduler.jobs.list(id).length,1);
 await f.g.call('task_lifecycle',f.control(id,'stop'));f.g.scheduler.triggers.tick();assert.equal(f.g.scheduler.jobs.list(id)[0].status,'cancelled');
});
test('R2 bounded input pages do not imply all context read; unlink forbids stale chain reuse',async t=>{
 const f=fixture(t),id=await f.create();let first;
 for(let i=0;i<23;i++){const r=await f.g.call('task_followup',f.input(id));first??=r;}
 const page=f.g.continuity.read(id);assert.equal(page.items.length,20);assert.notEqual(page.next_cursor,null);assert.equal(f.g.continuity.read(id,{after:page.next_cursor}).items.length,3);
 f.g.continuity.unlink('cloud',{task_id:id,thread_key:first.thread_key,source:f.source()});
 await assert.rejects(f.g.call('task_followup',f.input(id,undefined,{thread_key:first.thread_key})),/THREAD_NOT_FOUND|THREAD_UNLINKED/);
 assert.deepEqual(f.sideEffects,{agents:0,model:0});
});
