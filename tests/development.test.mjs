import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,symlinkSync,linkSync,realpathSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fixture,proposal} from './approval-fixture.mjs';
import {RepositoryCatalog} from '../bundle/repository-catalog.js';
import {approvedDevelopment,developmentSpec} from '../bundle/development-contract.js';
import {DevelopmentGate} from '../bundle/development-gate.js';
import {digest} from '../bundle/approval-ledger.js';
import {renderChatProposal} from '../bundle/approval-chat.js';
import {renderReceipt} from '../bundle/approval-receipts.js';
const url='https://gitee.com/isolated-fixture/development',file='s35-task-summary.mjs';
const spec={kind:'bounded-js-v1',branch:'dsh-task/s35-minimal',file,validator:'task-summary-v1',max_writes:3};
const good=`export function summarize({completed,queued,review}) {
 const values=[completed,queued,review];
 if(values.some(n=>!Number.isSafeInteger(n)||n<0)) throw new TypeError('counts');
 const total=completed+queued+review;
 return {total,completionRate:total?Math.round(completed/total*1000)/10:0};
}`;
const git=(root,...a)=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgsign=false','-C',root,...a],{encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
async function setup(t,{approve=true,enabled=true,bridge=false}={}){
 const selectedSpec=bridge?{...spec,executors:['cloud','local']}:spec;
 const f=fixture(t),root=realpathSync(mkdtempSync(tmpdir()+'/dsh-development-fixture-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 git(root,'init','-b',spec.branch);git(root,'-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','--allow-empty','-m','isolated test only');git(root,'remote','add','origin',url);
 const base_sha=git(root,'rev-parse','HEAD'),snapshot={provider:'gitee',repository_id:1,url,branch:'main',base_sha,private:true,workspace:null};
 const repos=new RepositoryCatalog(f.store,f.catalog,{reference:r=>({url:r}),inspect:async()=>snapshot},f.ledger.now);f.ledger.repositories=repos;
 const resolved=await repos.resolve({reference:url}),source={role:'local',session_id:'fixture',message_id:'fixture-message',text:url,sha256:digest(url)};
 const bound=repos.mutate('local',{task_id:f.task.id,expected_revision:1,expected_binding_revision:0,resolution_id:resolved.resolution_id,event_id:'fixture-bind',sources:[source]});
 const request=()=>f.ledger.request('local',{task_id:f.task.id,expected_revision:1,event_id:'fixture-proposal',proposal:{...proposal,repository:{binding_revision:bound.binding_revision,fingerprint:bound.repository.fingerprint},development:selectedSpec}});
 const req=request();f.chat.queue(req.id);await f.chat.tick();const prompt=[...f.messages.values()][0];
 if(approve){f.reply(prompt);await f.chat.tick();assert.equal(f.ledger.view(req.id).state,'approved');}
 const authorizationHash=digest({approval:req.id,proposal_hash:req.proposal_hash,spec:selectedSpec});
 const bindings={[f.task.id]:{root,url,branch:spec.branch,base_sha,approval_hash:authorizationHash}};
 const gate=new DevelopmentGate({store:f.store,ledger:f.ledger,bindings,enabled,now:f.ledger.now});
 const enqueue=(node='cloud',event_id='run')=>gate.enqueue(node,{task_id:f.task.id,approval_id:req.id,policy:proposal.model_policy,event_id});
 return {...f,root,base_sha,req,prompt,repos,bindings,gate,enqueue};
}
const start=f=>{const q=f.enqueue();return f.gate.acquire(q.id);};
const write=(f,q,content=good,call_id='write',expected_hash=q.expected_hash)=>f.gate.write(q.id,q.node,q.epoch,{call_id,expected_hash,content});
test('spec rejects shell commands, extra fields, broad paths, branch injection and unbounded budgets',()=>{
 assert.deepEqual(developmentSpec(spec),spec);
 for(const extra of [{file:'../x'},{file:'.git/config'},{file:'nested/x.mjs'},{branch:'main'},{branch:'dsh-task/x;rm'},{max_writes:4},{command:'node arbitrary'},{validator:'npm-test'}])assert.throws(()=>developmentSpec({...spec,...extra}),/INVALID_SPEC/);
});
test('pending/disabled/model mismatch/operator mismatch do not enqueue or write',async t=>{
 const f=await setup(t,{approve:false});assert.throws(()=>f.enqueue(),/APPROVAL_REQUIRED/);assert.equal(f.gate.db.prepare('SELECT COUNT(*) n FROM development_requests').get().n,0);
 f.reply(f.prompt);await f.chat.tick();f.gate.enabled=false;assert.throws(()=>f.enqueue(),/DISABLED/);f.gate.enabled=true;
 assert.throws(()=>approvedDevelopment(f.ledger,f.task.id,f.req.id,{provider:'wrong',model:'wrong'}),/APPROVAL_REQUIRED/);
 f.gate.bindings[f.task.id].approval_hash='wrong';assert.throws(()=>f.enqueue(),/OPERATOR_BINDING_REQUIRED/);
 assert.equal(git(f.root,'status','--porcelain'),'');
});
test('approved narrow file writes do not commit/push; test result required before safe point',async t=>{
 const f=await setup(t),q=start(f);assert(q.acquired);assert.equal(f.gate.read(q.id,'cloud',q.epoch).content,null);
 const receipt=write(f,q);assert.equal(receipt.committed,false);assert.equal(git(f.root,'rev-parse','HEAD'),f.base_sha);
 assert.throws(()=>f.gate.finish(q.id,'cloud',q.epoch,{agentDrained:true}),/TEST_REQUIRED/);
 const result=await f.gate.test(q.id,'cloud',q.epoch);assert.equal(result.passed,true);assert.equal(result.cases,6);
 assert.throws(()=>f.gate.finish(q.id,'cloud',q.epoch),/NOT_DRAINED/);
 assert.equal(f.gate.finish(q.id,'cloud',q.epoch,{agentDrained:true}).state,'completed');assert.equal(f.store.task(f.task.id).busy,0);
 assert.equal(git(f.root,'diff','--cached','--name-only'),'');assert.equal(git(f.root,'rev-parse','HEAD'),f.base_sha);
});
test('cloud busy queues local, only drained safe point permits new epoch, old executor fenced',async t=>{
 const f=await setup(t),cloud=start(f),local=f.enqueue('local','local-write');
 assert.equal(f.gate.acquire(local.id).acquired,false);write(f,cloud);await f.gate.test(cloud.id,'cloud',cloud.epoch);
 assert.equal(f.gate.acquire(local.id).acquired,false);f.gate.finish(cloud.id,'cloud',cloud.epoch,{agentDrained:true});
 const granted=f.gate.acquire(local.id);assert(granted.acquired);assert(granted.epoch>cloud.epoch);assert.equal(f.store.task(f.task.id).owner,'local');
 assert.throws(()=>write(f,cloud),/STALE_FENCE/);assert.throws(()=>f.gate.read(granted.id,'cloud',granted.epoch),/STALE_FENCE/);
 write(f,granted,good+'\n// local handoff fixture','local');await f.gate.test(granted.id,'local',granted.epoch);f.gate.finish(granted.id,'local',granted.epoch,{agentDrained:true});
});
test('idempotent calls do not repeat writes, conflicting IDs and stale content are denied',async t=>{
 const f=await setup(t),queued=f.enqueue();assert.equal(f.enqueue().id,queued.id);assert.throws(()=>f.enqueue('local'),/EVENT_CONFLICT/);
 const q=f.gate.acquire(queued.id),r=write(f,q);assert.equal(write(f,q).replayed,true);assert.throws(()=>write(f,q,good+'\n'),/WRITE_CONFLICT/);
 assert.throws(()=>write(f,q,good+'\n','new'),/FILE_CONFLICT/);assert.equal(readFileSync(f.root+'/'+file,'utf8'),good);assert.equal(r.sha256.length,64);
});
test('expiry and revocation are rechecked at each write, not copied into lease authority',async t=>{
 const f=await setup(t),q=start(f);f.time(3600001);assert.throws(()=>write(f,q),/APPROVAL_REQUIRED/);
 const g=await setup(t),r=start(g);g.reply(g.prompt,'撤销此方案');await g.chat.tick();assert.equal(g.ledger.view(g.req.id).state,'revoked');assert.throws(()=>write(g,r),/APPROVAL_REQUIRED/);
});
test('restart never retries uncertain active writes or grants their resource to queued local',async t=>{
 const f=await setup(t),q=start(f),local=f.enqueue('local','later');write(f,q);
 const reopened=new DevelopmentGate({store:f.store,ledger:f.ledger,bindings:f.bindings,enabled:true,now:f.ledger.now});reopened.recover();
 assert.equal(reopened.view(q.id).state,'needs_review');assert.equal(f.store.task(f.task.id).blocked,1);assert.throws(()=>reopened.acquire(local.id),/TASK_BLOCKED/);
 assert.equal(readFileSync(f.root+'/'+file,'utf8'),good);assert.throws(()=>write(f,q),/STALE_FENCE/);
});
test('test failure is real; a changed file invalidates previous successful test',async t=>{
 const f=await setup(t),q=start(f);let r=write(f,q,'export const summarize=()=>({total:0,completionRate:0});');
 assert.equal((await f.gate.test(q.id,'cloud',q.epoch)).passed,false);assert.throws(()=>f.gate.finish(q.id,'cloud',q.epoch,{agentDrained:true}),/TEST_REQUIRED/);
 r=write(f,q,good,'fix',r.sha256);assert.equal((await f.gate.test(q.id,'cloud',q.epoch)).passed,true);
 write(f,q,good+'\n','changed',r.sha256);assert.throws(()=>f.gate.finish(q.id,'cloud',q.epoch,{agentDrained:true}),/TEST_REQUIRED/);
 assert.throws(()=>write(f,q,good,'over-budget',f.gate.view(q.id).expected_hash),/WRITE_BUDGET/);
});
test('native test subprocess cannot read unrelated files or write to workspace',async t=>{
 const f=await setup(t),q=start(f);let r=write(f,q,"import fs from 'node:fs'; fs.readFileSync('/etc/passwd');\n"+good);
 assert.equal((await f.gate.test(q.id,'cloud',q.epoch)).passed,false);
 write(f,q,"import fs from 'node:fs'; fs.writeFileSync('unauthorized','x');\n"+good,'write-denied',r.sha256);
 assert.equal((await f.gate.test(q.id,'cloud',q.epoch)).passed,false);assert.throws(()=>readFileSync(f.root+'/unauthorized'),/ENOENT/);
});
test('running tests cannot be mistaken for drained and cancellation does not release ownership',async t=>{
 const f=await setup(t),q=start(f);write(f,q,good);const controller=new AbortController();
 const run=f.gate.test(q.id,'cloud',q.epoch,controller.signal);assert.throws(()=>f.gate.finish(q.id,'cloud',q.epoch,{agentDrained:true}),/NOT_DRAINED/);
 assert.throws(()=>write(f,q,good,'parallel',f.gate.view(q.id).expected_hash),/OPERATION_IN_FLIGHT/);
 controller.abort();await assert.rejects(run,/TEST_CANCELLED/);assert.equal(f.gate.inflight.size,0);assert.equal(f.store.task(f.task.id).busy,1);
});
for(const kind of ['dirty','symlink','hardlink','head','branch','remote'])test('workspace rejects '+kind+' interference before writing',async t=>{
 const f=await setup(t),q=f.enqueue();
 if(kind==='dirty')writeFileSync(f.root+'/unrelated','user file');
 if(kind==='symlink')symlinkSync('/etc/passwd',f.root+'/'+file);
 if(kind==='hardlink'){writeFileSync(f.root+'/other','user file');linkSync(f.root+'/other',f.root+'/'+file);}
 if(kind==='head')git(f.root,'-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','--allow-empty','-m','changed');
 if(kind==='branch')git(f.root,'checkout','-b','other');
 if(kind==='remote')git(f.root,'remote','set-url','origin','https://example.com/other');
 assert.throws(()=>f.gate.acquire(q.id),/DEVELOPMENT_/);assert.equal(f.store.task(f.task.id).busy,0);
});
test('bound spec is included in proposal hash and confirmation never promises nonexistent execution',async t=>{
 const f=await setup(t);const v=f.ledger.view(f.req.id),text=renderChatProposal(v);assert(text.includes('受限开发授权'));assert(text.includes(spec.file));assert(text.includes(spec.branch));assert(!text.includes('当前仅记账，不执行'));
 const receipt=renderReceipt(v,{action:'approve',created:f.ledger.now(),id:'fixture'},f.ledger.now());assert(receipt.includes('不证明执行是否开始或结束'));assert(receipt.includes('提交、推送、发布、部署不在授权内'));
});

import {TaskJobs} from '../bundle/task-jobs.js';
import {TaskArtifacts} from '../bundle/task-artifacts.js';
import {DevelopmentRuntime} from '../bundle/development-runtime.js';
import {validateDevelopmentSource} from '../bundle/development-source.js';
for(const code of ["import 'node:fs';\n"+good,good+'\nprocess.exit(0)',good.replace('completed+queued+review','globalThis.fetch("https://example.com")'),good.replace('Math.round','Function'),good.replace('Math.round','Math["round"]'),good.replace('completed+queued+review','summarize({completed,queued,review})'),good.replace('const total=','const process=1; const total=')])test('pure subset rejects code with additional authority: '+code.slice(0,30),()=>assert.throws(()=>validateDevelopmentSource(code),/DEVELOPMENT_SOURCE/));
async function workerSetup(t,{wrongModel=false}={}){
 const f=await setup(t);let disposed=false,flushed=false,captured=null,requestHook;
 const agent={id:'task-worker-11111111-1111-1111-1111-111111111111',session:{},ctx:{tools:{restrict(x){assert.deepEqual([...x.allow].sort(),['development_read','development_report','development_test','development_write','skill']);}},on(n,fn){if(n==='agent/request')requestHook=fn;}},followup(m){captured=m;},cancel(){},async whenIdle(){
  assert.equal(f.runtime.worker.active.get(agent.id).requestLimit,13);
  await requestHook({},async()=>({...proposal.model_policy,...(wrongModel?{model:'fallback'}:{})}));
  const r=f.runtime.requestFor(f.job);f.runtime.gate.write(r.id,'cloud',r.epoch,{call_id:'fixture-model-call',expected_hash:null,content:good});
  await f.runtime.gate.test(r.id,'cloud',r.epoch);f.runtime.worker.report(agent,{summary:'明确标注的模型接口夹具，非真实模型输出'});
 }};
 const jobs=new TaskJobs(f.dir+'/runtime-jobs',f.ledger.now);t.after(()=>jobs.close());
 const ctx={on(){},agents:{get:id=>id===agent.id?agent:null,withoutInitiator:fn=>fn(),create:async o=>{assert.equal(await o.setup(agent.ctx),undefined);assert.equal(o.meta.agentPreset,'dsh-development-worker');assert.deepEqual(o.agentOptions,{...proposal.model_policy,maxTokens:2048});return {agent,dispose:async()=>{disposed=true;}};}},agentPresets:{mount:async()=>({notATransaction:true})},sessions:{flush:async()=>{flushed=true;}}};
 const g={ctx,c:{role:'cloud',stateDir:f.dir+'/runtime-artifacts'},store:f.store,catalog:f.catalog,approvals:f.ledger,repositories:f.repos,scheduler:{jobs},now:f.ledger.now,closed:false};g.artifacts=new TaskArtifacts(g);t.after(()=>g.artifacts.close());
 f.runtime=g.development=new DevelopmentRuntime(g,{enabled:true,bindings:f.bindings});
 const scheduled=await f.runtime.schedule({task_id:f.task.id,approval_id:f.req.id,model_policy:proposal.model_policy});
 f.job=jobs.claim(new Set(['development']),new Set(),j=>f.runtime.canClaim(j));assert.equal(f.job.id,scheduled.job_id);
 return Object.assign(f,{g,jobs,agent,observed:()=>({disposed,flushed,captured})});
}
test('isolated native adapter binds model, drains before durable batch completion and registers real tested-file report',async t=>{
 const f=await workerSetup(t),result=await f.runtime.run(f.job,new AbortController().signal);assert(f.observed().disposed&&f.observed().flushed);assert(f.observed().captured.content[0].text.includes('task-development'));
 assert.equal(f.g.artifacts.list(f.task.id).items[0].state,'pending_run');assert.equal(f.store.task(f.task.id).busy,1);
 f.jobs.finish(f.job,result);f.runtime.finished(f.job);assert.equal(f.g.artifacts.list(f.task.id).items[0].state,'needs_verification');assert.equal(f.store.task(f.task.id).busy,0);
 assert.equal(git(f.root,'rev-parse','HEAD'),f.base_sha);
});
test('native adapter rejects model fallback before any code write and retains review fence',async t=>{
 const f=await workerSetup(t,{wrongModel:true});await assert.rejects(f.runtime.run(f.job,new AbortController().signal),/MODEL_MISMATCH/);
 assert(f.observed().disposed);assert.equal(f.runtime.gate.view(f.runtime.requestFor(f.job).id).state,'needs_review');assert.equal(git(f.root,'status','--porcelain'),'');assert.equal(f.g.artifacts.list(f.task.id).items.length,0);
});
test('failed repository revalidation cannot use a previously approved but now stale snapshot',async t=>{
 const f=await setup(t),q=start(f);f.repos.provider.inspect=async()=>{throw Error('REPOSITORY_PROVIDER_UNAVAILABLE');};await f.repos.refresh(f.task.id);
 assert.throws(()=>write(f,q),/REPOSITORY_NOT_FRESH/);assert.equal(git(f.root,'status','--porcelain'),'');
});
import {cpSync} from 'node:fs';
import {makeEnvelope} from '../bundle/task-envelope.js';
async function secondTask(t,f,sameRepo){
 const root=realpathSync(mkdtempSync(tmpdir()+'/dsh-development-second-'));t.after(()=>rmSync(root,{recursive:true,force:true}));cpSync(f.root,root,{recursive:true});
 const target=sameRepo?url:url+'-other';git(root,'remote','set-url','origin',target);
 const e=makeEnvelope({id:'fixture-second',session:{deriveMessages:()=>[{id:'fixture-second',role:'user',source:{kind:'user'},content:[{type:'text',text:target}]}]}},'local',{goal:'Separate fixture task',target:'cloud',intent:'register'});
 const task=f.store.accept('local',{goal:e.goal,task_key:e.task_key,source:'native-local',ingress_id:e.ingress_id});f.catalog.head(task.id);
 f.repos.provider.inspect=async()=>({provider:'gitee',repository_id:sameRepo?1:2,url:target,branch:'main',base_sha:f.base_sha,private:true,workspace:null});
 const resolution=await f.repos.resolve({reference:target}),binding=f.repos.mutate('local',{task_id:task.id,expected_revision:1,expected_binding_revision:0,resolution_id:resolution.resolution_id,event_id:'bind-second',sources:[{role:'local',session_id:'fixture-second',message_id:'fixture-second',text:target,sha256:digest(target)}]});
 const req=f.ledger.request('local',{task_id:task.id,expected_revision:1,event_id:'approve-second',proposal:{...proposal,repository:{binding_revision:1,fingerprint:binding.repository.fingerprint},development:spec}});
 f.chat.queue(req.id);f.time(6000);await f.chat.tick();const delivery=f.store.db.prepare('SELECT message_id FROM approval_chat_deliveries WHERE request_id=?').get(req.id);f.reply(f.messages.get(delivery.message_id));await f.chat.tick();assert.equal(f.ledger.view(req.id).state,'approved');
 f.gate.bindings[task.id]={root,url:target,branch:spec.branch,base_sha:f.base_sha,approval_hash:digest({approval:req.id,proposal_hash:req.proposal_hash,spec})};
 return f.gate.enqueue('local',{task_id:task.id,approval_id:req.id,policy:proposal.model_policy,event_id:'second'});
}
test('different tasks sharing one repository serialize; idle task alone is not enough',async t=>{
 const f=await setup(t),other=await secondTask(t,f,true),first=f.enqueue();
 // FIFO is the persisted order, not the task that calls acquire first.
 assert.equal(f.gate.acquire(first.id).acquired,false);const owner=f.gate.acquire(other.id);assert(owner.acquired);
 assert.equal(f.gate.acquire(first.id).acquired,false);write(f,owner);await f.gate.test(owner.id,'local',owner.epoch);f.gate.finish(owner.id,'local',owner.epoch,{agentDrained:true});
 assert.equal(f.gate.acquire(first.id).acquired,true);
});
test('repository gate does not make an unrelated repository busy',async t=>{
 const f=await setup(t),other=await secondTask(t,f,false);assert(start(f).acquired);assert(f.gate.acquire(other.id).acquired);
});
test('queued snapshot ageing does not discard work; fresh remote verification is required before file access',async t=>{
 const f=await setup(t),q=f.enqueue();f.time(300001);const lease=f.gate.acquire(q.id);assert(lease.acquired);
 assert.throws(()=>write(f,lease),/REPOSITORY_NOT_FRESH/);assert.throws(()=>f.gate.read(lease.id,'cloud',lease.epoch),/REPOSITORY_NOT_FRESH/);
 await f.repos.refresh(f.task.id);write(f,lease);assert.equal((await f.gate.test(lease.id,'cloud',lease.epoch)).passed,true);
});

import {apply as mountDevelopmentTools} from '../bundle/development-tools.js';
function wireTools(f,q){
 const tools=new Map(),agent={},b={job:{task_id:f.task.id},signal:new AbortController().signal};let refreshes=0;
 const runtime={gate:f.gate,worker:{binding:a=>{assert.equal(a,agent);return b;}},requestFor:()=>f.gate.view(q.id),
  g:{repositories:{refresh:async id=>{refreshes++;return f.repos.refresh(id);}}}};
 mountDevelopmentTools({taskGateway:{development:runtime},inject(_n,fn){fn({systemPrompt:{context(){}}});},
  tools:{register:d=>tools.set(d.name,d),guard(){}}});
 return {tools,refreshes:()=>refreshes,call:(name,args={},callId='fixture-'+name)=>tools.get(name).execute(args,{agent,callId})};
}
test('real failure reproduction: string null is not JSON null and cannot write or consume an applied slot',async t=>{
 const f=await setup(t),q=start(f);assert.equal(f.gate.read(q.id,'cloud',q.epoch).hash,null);
 for(let i=0;i<3;i++)assert.throws(()=>write(f,q,good,'invalid-'+i,'null'),/FILE_CONFLICT/);
 assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_writes').get().n,0);
 assert.equal(git(f.root,'status','--porcelain'),'');
});
test('string version wire contract round-trips absent and hash through the real gate and six-case fixture',async t=>{
 const f=await setup(t),q=start(f),w=wireTools(f,q),schema=w.tools.get('development_write').parameters;
 assert.deepEqual(schema.required,['content','base_version']);assert.equal(schema.properties.base_version.type,'string');
 assert(!JSON.stringify(schema).includes('oneOf'));assert.equal(schema.additionalProperties,false);
 const read=w.call('development_read');assert.deepEqual(read,{base_version:'absent',content:null});
 const saved=await w.call('development_write',{base_version:read.base_version,content:good},'fixture-first');
 const next=w.call('development_read');assert.equal(next.base_version,'sha256:'+saved.sha256);assert.equal(next.content,good);
 await w.call('development_write',{base_version:next.base_version,content:good+'\n'},'fixture-second');
 const tested=await w.call('development_test');assert(tested.passed);assert.equal(tested.cases,6);
 f.gate.finish(q.id,'cloud',q.epoch,{agentDrained:true});assert.equal(f.store.task(f.task.id).busy,0);
 assert.equal(git(f.root,'rev-parse','HEAD'),f.base_sha);assert.equal(git(f.root,'diff','--cached','--name-only'),'');
});
test('wire rejects null, string null, malformed versions and legacy fields before refresh or write',async t=>{
 const f=await setup(t),q=start(f),w=wireTools(f,q);
 for(const base_version of [null,'null',undefined,{},0,'',' absent','absent\n','sha256:'+'A'.repeat(64),'sha256:'+'a'.repeat(63),'a'.repeat(64)])
  await assert.rejects(w.call('development_write',{base_version,content:good}),/BASE_VERSION_INVALID/);
 for(const args of [{content:good,expected_hash:null},{content:good,base_version:'absent',expected_hash:null},{base_version:'absent'}])
  await assert.rejects(w.call('development_write',args),/BASE_VERSION_INVALID/);
 assert.equal(w.refreshes(),0);assert.equal(git(f.root,'status','--porcelain'),'');
});
test('stale absent or fabricated hash cannot overwrite a file after wire write',async t=>{
 const f=await setup(t),q=start(f),w=wireTools(f,q);
 await w.call('development_write',{base_version:w.call('development_read').base_version,content:good},'fixture-first');
 for(const base_version of ['absent','sha256:'+'0'.repeat(64)])
  await assert.rejects(w.call('development_write',{base_version,content:good+'\n'},'fixture-stale'),/FILE_CONFLICT/);
 assert.equal(readFileSync(f.root+'/'+file,'utf8'),good);
 assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_writes').get().n,1);
});
test('absent version never overwrites external file creation',async t=>{
 const f=await setup(t),q=start(f),w=wireTools(f,q),read=w.call('development_read');
 writeFileSync(f.root+'/'+file,'external fixture file');
 await assert.rejects(w.call('development_write',{base_version:read.base_version,content:good}),/FILE_CONFLICT/);
 assert.equal(readFileSync(f.root+'/'+file,'utf8'),'external fixture file');
 assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_writes').get().n,0);
});
test('file version is not authorization after revocation',async t=>{
 const f=await setup(t),q=start(f),w=wireTools(f,q),read=w.call('development_read');
 f.reply(f.prompt,'撤销此方案');await f.chat.tick();
 await assert.rejects(w.call('development_write',{base_version:read.base_version,content:good}),/APPROVAL_REQUIRED/);
 assert.equal(git(f.root,'status','--porcelain'),'');
});
test('file version does not bypass needs-review fence after recovery',async t=>{
 const f=await setup(t),q=start(f),w=wireTools(f,q),read=w.call('development_read');f.gate.recover();
 await assert.rejects(w.call('development_write',{base_version:read.base_version,content:good}),/STALE_FENCE/);
 assert.equal(f.gate.view(q.id).state,'needs_review');assert.equal(f.store.task(f.task.id).blocked,1);
 assert.equal(git(f.root,'status','--porcelain'),'');
});
test('valid string version still requires fresh remote repository verification',async t=>{
 const f=await setup(t),q=start(f),w=wireTools(f,q),read=w.call('development_read');
 f.repos.provider.inspect=async()=>{throw Error('REPOSITORY_PROVIDER_UNAVAILABLE');};
 await assert.rejects(w.call('development_write',{base_version:read.base_version,content:good}),/REPOSITORY_NOT_FRESH/);
 assert.equal(git(f.root,'status','--porcelain'),'');
});

import {recoverZeroWriteDevelopment} from '../bundle/development-review.js';
async function reviewSetup(t){
 const f=await workerSetup(t,{wrongModel:true});
 await assert.rejects(f.runtime.run(f.job,new AbortController().signal),/MODEL_MISMATCH/);
 f.jobs.fail(f.job,'DEVELOPMENT_MODEL_MISMATCH');
 const r=f.runtime.requestFor(f.job);
 const args={event_id:'fixture-operator-review',job_id:f.job.id,failed_run_id:f.job.run_id,
  expected_epoch:r.epoch,authority_hash:r.authority_hash,evidence_sha256:digest('fixture verified zero effects'),
  operator_note:'Explicit fixture operator grant; not a human approval or a real retry'};
 return Object.assign(f,{reviewArgs:args,review:()=>recoverZeroWriteDevelopment({gate:f.runtime.gate,jobs:f.jobs,assertExclusive(){}},args)});
}
test('operator zero-write review preserves job, failed run, attempts, approval and original write budget',async t=>{
 const f=await reviewSetup(t),r=f.runtime.requestFor(f.job),approval=f.ledger.row(f.req.id),out=f.review();
 assert.equal(out.job_id,f.job.id);assert.equal(out.request_id,r.id);assert.equal(out.max_runs,2);assert.equal(out.attemptsRetained,1);
 assert.equal(f.jobs.get(f.job.id).attempts,1);assert.equal(f.jobs.db.prepare('SELECT status FROM runs WHERE id=?').get(f.job.run_id).status,'failed');
 assert.deepEqual(f.ledger.row(f.req.id),approval);assert.equal(f.ledger.view(f.req.id).state,'approved');
 assert.equal(f.runtime.gate.view(r.id).state,'queued');assert(f.store.task(f.task.id).epoch>r.epoch);
 assert.throws(()=>f.runtime.gate.read(r.id,'cloud',r.epoch),/STALE_FENCE/);
 assert.equal(f.review().replayed,true);assert.equal(f.jobs.get(f.job.id).max_runs,2);
 f.jobs.control({id:f.job.id,action:'resume',event_id:'fixture-explicit-round2',actor:'fixture-operator'});
 const next=f.jobs.claim(new Set(['development']),new Set(),j=>f.runtime.canClaim(j));
 assert.equal(next.id,f.job.id);assert.notEqual(next.run_id,f.job.run_id);assert.equal(next.attempts,2);
 assert.equal(f.runtime.gate.read(r.id,'cloud',f.runtime.requestFor(next).epoch).hash,null);
 assert.equal(f.ledger.view(f.req.id).proposal.development.max_writes,3);
});
for(const kind of ['expired','revoked','file','identity','revision','wrong-epoch','wrong-hash','missing-lock','write-intent'])
test('operator review refuses '+kind+' without removing review fence',async t=>{
 const f=await reviewSetup(t),r=f.runtime.requestFor(f.job);
 if(kind==='expired')f.time(3600001);
 if(kind==='revoked')f.store.db.prepare("UPDATE approval_requests SET state='revoked' WHERE id=?").run(f.req.id);
 if(kind==='file')writeFileSync(f.root+'/'+file,'external');
 if(kind==='identity')f.store.db.prepare('UPDATE approval_chat_bindings SET disabled=1').run();
 if(kind==='revision')f.store.db.prepare("UPDATE task_revisions SET goal=goal||' changed' WHERE task_id=?").run(f.task.id);
 if(kind==='wrong-epoch')f.reviewArgs.expected_epoch++;
 if(kind==='wrong-hash')f.reviewArgs.authority_hash='0'.repeat(64);
 if(kind==='write-intent')f.store.db.prepare("INSERT INTO development_writes VALUES ('fixture-intent',?,'fp',NULL,'hash','writing',0)").run(r.id);
 const execute=kind==='missing-lock'?()=>recoverZeroWriteDevelopment({gate:f.runtime.gate,jobs:f.jobs,assertExclusive(){throw Error('LOCK_REQUIRED');}},f.reviewArgs):f.review;
 assert.throws(execute);assert.equal(f.store.task(f.task.id).blocked,1);assert.equal(f.store.task(f.task.id).busy,1);
 assert.equal(f.runtime.gate.view(r.id).state,'needs_review');assert.equal(f.jobs.get(f.job.id).status,'needs_review');
 assert.equal(f.jobs.get(f.job.id).max_runs,1);
});
test('operator review intent survives job transaction failure without adding attempts',async t=>{
 const f=await reviewSetup(t),original=f.jobs.event;f.jobs.event=()=>{throw Error('fixture crash');};
 assert.throws(f.review,/fixture crash/);assert.equal(f.jobs.get(f.job.id).status,'needs_review');assert.equal(f.store.task(f.task.id).blocked,1);
 f.jobs.event=original;assert.equal(f.review().max_runs,2);assert.equal(f.jobs.get(f.job.id).attempts,1);
 assert.throws(()=>recoverZeroWriteDevelopment({gate:f.runtime.gate,jobs:f.jobs,assertExclusive(){}},{...f.reviewArgs,event_id:'new-id'}),/REVIEW_CONFLICT/);
});
test('partial cross-database review is fenced and can reconcile the same operator event',async t=>{
 const f=await reviewSetup(t);let checks=0;
 assert.throws(()=>recoverZeroWriteDevelopment({gate:f.runtime.gate,jobs:f.jobs,assertExclusive(){if(++checks===4)throw Error('fixture final-phase stop');}},f.reviewArgs),/final-phase stop/);
 assert.equal(f.jobs.get(f.job.id).status,'paused');assert.equal(f.store.task(f.task.id).blocked,1);
 assert.equal(f.runtime.gate.view(f.runtime.requestFor(f.job).id).state,'needs_review');
 const out=f.review();assert.equal(out.max_runs,2);assert.equal(f.review().replayed,true);
});

test('native write admission counts rejected calls durably and never grants a fourth distinct call',async t=>{
 const f=await setup(t),q=start(f),w=wireTools(f,q);
 for(let i=0;i<3;i++)await assert.rejects(w.call('development_write',{content:good,base_version:'null'},'rejected-'+i),/BASE_VERSION_INVALID/);
 await assert.rejects(w.call('development_write',{content:good,base_version:'absent'},'fourth'),/WRITE_CALL_BUDGET/);
 assert.equal(f.gate.db.prepare("SELECT count(*) n FROM development_events WHERE type='write_tool_called'").get().n,3);
 assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_writes').get().n,0);
 assert.equal(git(f.root,'status','--porcelain'),'');
});

test('test close is durably recorded before inflight clears and success can release a resource',async t=>{
 const f=await setup(t),q=start(f);write(f,q);await f.gate.test(q.id,'cloud',q.epoch);
 const op=f.gate.db.prepare('SELECT * FROM development_operations WHERE request_id=?').get(q.id);assert.equal(op.state,'closed');assert(op.pid>0);assert(op.closed!==null);assert.equal(op.exit_code,0);assert.equal(f.gate.inflight.size,0);assert.equal(f.gate.unresolved(q.id),false);
 const events=f.gate.db.prepare('SELECT type FROM development_events WHERE request_id=? ORDER BY seq').all(q.id).map(x=>x.type);assert(events.indexOf('test_intent')<events.indexOf('test_drained'));assert(events.indexOf('test_drained')<events.indexOf('tested'));
 f.gate.finish(q.id,'cloud',q.epoch,{agentDrained:true});
});
test('cancelled test records close and invalidates the earlier successful test, without releasing task',async t=>{
 const f=await setup(t),q=start(f);write(f,q);await f.gate.test(q.id,'cloud',q.epoch);const c=new AbortController();const run=f.gate.test(q.id,'cloud',q.epoch,c.signal);c.abort();await assert.rejects(run,/TEST_CANCELLED/);
 assert.equal(f.gate.view(q.id).test_result,null);assert.equal(f.gate.unresolved(q.id),false);assert.equal(f.store.task(f.task.id).busy,1);assert.throws(()=>f.gate.finish(q.id,'cloud',q.epoch,{agentDrained:true}),/TEST_REQUIRED/);
});
test('uncertain durable child blocks release even when memory has no running operation',async t=>{
 const f=await setup(t),q=start(f);write(f,q);await f.gate.test(q.id,'cloud',q.epoch);
 f.gate.db.prepare("INSERT INTO development_operations VALUES ('unknown-child',?,?,'test','intent',NULL,0,NULL,NULL,NULL)").run(q.id,q.epoch);
 assert.equal(f.gate.inflight.size,0);assert.throws(()=>write(f,q,good+'\n','after-unknown',f.gate.view(q.id).expected_hash),/CHILD_DRAIN_UNKNOWN/);assert.throws(()=>f.gate.finish(q.id,'cloud',q.epoch,{agentDrained:true}),/NOT_DRAINED/);await assert.rejects(f.gate.test(q.id,'cloud',q.epoch),/CHILD_DRAIN_UNKNOWN/);
 f.gate.recover();assert.equal(f.gate.view(q.id).state,'needs_review');assert.equal(f.gate.unresolved(q.id),true);assert.equal(f.store.task(f.task.id).busy,1);
});
test('zero-write operator review cannot ignore a persisted unclosed child operation',async t=>{
 const f=await reviewSetup(t),r=f.runtime.requestFor(f.job);f.gate.db.prepare("INSERT INTO development_operations VALUES ('unknown-child',?,?,'test','spawned',1234567,0,NULL,NULL,NULL)").run(r.id,r.epoch);
 assert.throws(f.review,/CHILD_DRAIN_UNKNOWN/);assert.equal(f.runtime.gate.view(r.id).state,'needs_review');assert.equal(f.jobs.get(f.job.id).max_runs,1);
});

test('queued authority cannot be redirected to a different clean checkout with the same repository and baseline',async t=>{
 const f=await setup(t),q=f.enqueue(),other=f.root+'-replacement';t.after(()=>rmSync(other,{recursive:true,force:true}));cpSync(f.root,other,{recursive:true});
 f.gate.bindings[f.task.id].root=other;
 assert.throws(()=>f.gate.acquire(q.id),/DEVELOPMENT_WORKSPACE_IDENTITY_CHANGED/);assert.equal(f.store.task(f.task.id).busy,0);
 assert.equal(git(other,'status','--porcelain'),'');
});
for(const part of ['root','gitdir'])test('active fence rejects physical '+part+' replacement even if path, content and Git baseline are unchanged',async t=>{
 const f=await setup(t),q=start(f),target=part==='root'?f.root:f.root+'/.git',saved=f.root+'-saved';t.after(()=>rmSync(saved,{recursive:true,force:true}));
 renameSync(target,saved);cpSync(saved,target,{recursive:true});
 assert.throws(()=>write(f,q),/DEVELOPMENT_WORKSPACE_IDENTITY_CHANGED/);
 assert.equal(git(f.root,'status','--porcelain'),'');assert.equal(f.store.task(f.task.id).busy,1);
});
test('reopened queued request retains its exact physical workspace identity without rebinding',async t=>{
 const f=await setup(t),q=f.enqueue(),before=f.gate.row(q.id).workspace_identity;
 assert.equal(typeof before,'string');assert(before.length>20);
 const reopened=new DevelopmentGate({store:f.store,ledger:f.ledger,bindings:f.bindings,enabled:true,now:f.ledger.now});
 assert(reopened.acquire(q.id).acquired);assert.equal(reopened.row(q.id).workspace_identity,before);
});
test('legacy queued request without a recorded workspace identity is held, not silently adopted',async t=>{
 const f=await setup(t),q=f.enqueue();f.gate.db.prepare('UPDATE development_requests SET workspace_identity=NULL WHERE id=?').run(q.id);
 assert.throws(()=>f.gate.acquire(q.id),/DEVELOPMENT_WORKSPACE_IDENTITY_REQUIRED/);assert.equal(f.store.task(f.task.id).busy,0);
});

import {DevelopmentBridge} from '../bundle/development-bridge.js';
import {randomUUID} from 'node:crypto';
const bridgeArgs=(f,event_id)=>({task_id:f.task.id,approval_id:f.req.id,policy:proposal.model_policy,event_id});
const bridgeBinding=c=>({id:c.id,endpoint_id:c.endpoint_id,ticket:c.ticket,epoch:c.epoch});
async function bridgeSetup(t,options={}){
 const f=await setup(t,{bridge:true,...options});f.bridge=new DevelopmentBridge({g:{repositories:f.repos},gate:f.gate});
 f.call=(op,args,node='local')=>f.bridge.call('development_bridge_'+op,args,node);return f;
}
async function bridgeStart(f,node='local'){
 const q=await f.call('enqueue',bridgeArgs(f,node),node);return f.call('acquire',{id:q.id,endpoint_id:randomUUID()},node);
}
test('bridge requires explicit endpoint authorization; old proposal and unapproved proposal do not gain a new executor',async t=>{
 const old=await bridgeSetup(t,{bridge:false});await assert.rejects(old.call('enqueue',bridgeArgs(old,'old')),/EXECUTOR_REQUIRED/);assert.equal(old.gate.db.prepare('SELECT count(*) n FROM development_requests').get().n,0);
 const pending=await bridgeSetup(t,{approve:false});await assert.rejects(pending.call('enqueue',bridgeArgs(pending,'pending')),/APPROVAL_REQUIRED/);
 for(const executors of [[],['local','local'],['other'],true])assert.throws(()=>developmentSpec({...spec,executors}),/INVALID_SPEC/);
 const f=await bridgeSetup(t);assert.match(renderChatProposal(f.ledger.view(f.req.id)),/执行端 云端大肥鱼、本地大肥鱼/);
});
test('bridge cloud and local share the existing real write gate, FIFO and total approved write budget',async t=>{
 const f=await bridgeSetup(t),cloud=await bridgeStart(f,'cloud'),local=await f.call('enqueue',bridgeArgs(f,'local'));
 const blocked=await f.call('acquire',{id:local.id,endpoint_id:randomUUID()});assert.equal(blocked.acquired,false);assert.equal(blocked.reason,'task_busy');
 const c=bridgeBinding(cloud);await f.call('write',{...c,call_id:'one',expected_hash:null,content:good},'cloud');await f.call('test',{...c,call_id:'test-one'},'cloud');
 await f.call('finish',c,'cloud');const next=await f.call('acquire',{id:local.id,endpoint_id:randomUUID()});assert(next.epoch>cloud.epoch);const l=bridgeBinding(next);
 await assert.rejects(f.call('write',{...c,call_id:'stale',expected_hash:null,content:good},'cloud'),/STALE_FENCE/);
 const current=await f.call('read',l);assert.equal(current.storage_host,'cloud');
 await f.call('write',{...l,call_id:'two',expected_hash:current.hash,content:good+'\n// local proposal'});await f.call('test',{...l,call_id:'test-two'});
 const finished=await f.call('finish',l);assert.equal(finished.state,'completed');assert.equal(finished.drain_scope,'managed_cloud_io_only');assert.equal(finished.committed,false);
 assert.equal(f.store.task(f.task.id).busy,0);assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_writes').get().n,2);assert.equal(git(f.root,'rev-parse','HEAD'),f.base_sha);
});
test('bridge tickets are bound to role, endpoint, request and epoch; acquisition retry returns the same fence',async t=>{
 const f=await bridgeSetup(t),q=await bridgeStart(f),b=bridgeBinding(q);
 assert.equal((await f.call('acquire',{id:q.id,endpoint_id:q.endpoint_id})).ticket,q.ticket);
 for(const patch of [{ticket:randomUUID()},{endpoint_id:randomUUID()},{epoch:q.epoch+1},{id:'unknown'}])await assert.rejects(f.call('read',{...b,...patch}),/STALE_FENCE/);
 await assert.rejects(f.call('read',b,'cloud'),/STALE_FENCE/);
 await assert.rejects(f.call('read',{...b,node:'cloud'}),/BRIDGE_INVALID/);
 await assert.rejects(f.call('finish',{...b,agentDrained:true}),/BRIDGE_INVALID/);
});
test('lost successful write and test responses can be read idempotently without repeating effects',async t=>{
 const f=await bridgeSetup(t),q=await bridgeStart(f),b=bridgeBinding(q),w={...b,call_id:'write-once',expected_hash:null,content:good};
 await f.call('write',w);assert.equal((await f.call('write',w)).replayed,true);
 const a={...b,call_id:'test-once'};await f.call('test',a);assert.equal((await f.call('test',a)).replayed,true);
 assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_operations').get().n,1);
 assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_writes').get().n,1);
 await f.call('finish',b);assert.equal((await f.call('finish',b)).replayed,true);
});
test('in-flight cloud child cannot be bypassed by duplicate HTTP test or finish from the peer',async t=>{
 const f=await bridgeSetup(t),q=await bridgeStart(f),b=bridgeBinding(q);await f.call('write',{...b,call_id:'write',expected_hash:null,content:good});
 const testing=f.call('test',{...b,call_id:'one'});
 await assert.rejects(f.call('test',{...b,call_id:'one'}),/TEST_UNCERTAIN/);await assert.rejects(f.call('finish',b),/NOT_DRAINED/);
 assert.equal(f.store.task(f.task.id).busy,1);await testing;await f.call('finish',b);assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_operations').get().n,1);
});
test('bridge failure and cloud restart retain the original fence; status reads never repair it',async t=>{
 const f=await bridgeSetup(t),q=await bridgeStart(f),b=bridgeBinding(q);f.gate.recover();
 const before=f.gate.db.prepare('SELECT * FROM development_requests').all();for(let n=0;n<3;n++){const v=await f.call('status',{id:q.id});assert.equal(v.waiting_reason,'development_review');assert.equal(v.grants_execution,false);}
 assert.deepEqual(f.gate.db.prepare('SELECT * FROM development_requests').all(),before);
 await assert.rejects(f.call('acquire',{id:q.id,endpoint_id:randomUUID()}));await assert.rejects(f.call('write',{...b,call_id:'after-restart',expected_hash:null,content:good}));
 const f2=await bridgeSetup(t),q2=await bridgeStart(f2);await f2.call('fail',bridgeBinding(q2));assert.equal(f2.store.task(f2.task.id).busy,1);assert.equal(f2.store.task(f2.task.id).blocked,1);
});
test('bridge rechecks approval at operation boundaries rather than trusting a cached ticket',async t=>{
 const f=await bridgeSetup(t),q=await bridgeStart(f);f.reply(f.prompt,'撤销此方案');await f.chat.tick();
 await assert.rejects(f.call('write',{...bridgeBinding(q),call_id:'revoked',expected_hash:null,content:good}),/APPROVAL_REQUIRED/);assert.equal(git(f.root,'status','--porcelain'),'');
});
test('resource diagnostics distinguish FIFO, busy owner and unresolved child without granting ownership',async t=>{
 const f=await setup(t),other=await secondTask(t,f,true),later=f.enqueue();assert.equal(f.gate.waiting(later.id),'development_fifo');
 const owner=f.gate.acquire(other.id);assert.equal(f.gate.waiting(later.id),'development_resource_busy');write(f,owner);
 const p=f.gate.test(owner.id,'local',owner.epoch);assert.equal(f.gate.waiting(later.id),'development_resource_draining');await p;
 f.gate.block(owner.id,'DEVELOPMENT_TEST_REVIEW');assert.equal(f.gate.waiting(later.id),'development_resource_review');assert.equal(f.store.task(f.task.id).busy,0);
});

import {Gateway} from '../bundle/index.js';
test('actual authenticated HTTP binds local bridge calls to local identity and blocks unnegotiated/disabled callers',async t=>{
 const f=await bridgeSetup(t),tokens=f.root+'-tokens.json';writeFileSync(tokens,JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});t.after(()=>rmSync(tokens,{force:true}));
 const ctx={on(){},effect(){},get(){return null;},agents:{list:()=>[]}},base={namespace:'s40-http',entryMode:'native',port:0,tokenFile:tokens};
 const cloud=new Gateway(ctx,{...base,role:'cloud',stateDir:f.dir+'/gateway-cloud'});await cloud.start();
 const local=new Gateway(ctx,{...base,role:'local',stateDir:f.dir+'/gateway-local',coordinatorUrl:'http://127.0.0.1:'+cloud.server.address().port});t.after(async()=>{await local.close();await cloud.close();});
 await assert.rejects(local.call('development_bridge_enqueue',bridgeArgs(f,'disabled')),/CAPABILITY_UNAVAILABLE/);
 // Only an explicit test mount supplies the independently approved fixture runtime.
 cloud.development={bridge:f.bridge};
 const q=await local.call('development_bridge_enqueue',bridgeArgs(f,'http'));assert.equal(q.node,'local');
 await assert.rejects(local.call('development_bridge_enqueue',{...bridgeArgs(f,'spoof'),node:'cloud'}),/BRIDGE_INVALID/);
 const claim=await local.call('development_bridge_acquire',{id:q.id,endpoint_id:randomUUID()});assert(claim.acquired);
 const b=bridgeBinding(claim);await local.call('development_bridge_write',{...b,call_id:'http-write',expected_hash:null,content:good});assert.equal(readFileSync(f.root+'/'+file,'utf8'),good);
 await local.call('development_bridge_test',{...b,call_id:'http-test'});assert.equal((await local.call('development_bridge_finish',b)).state,'completed');
 const r=await fetch(local.c.coordinatorUrl+'/rpc',{method:'POST',headers:{Authorization:'Bearer '+'l'.repeat(32),'Content-Type':'application/json'},body:JSON.stringify({method:'development_bridge_status',args:{id:q.id}})});assert.equal((await r.json()).error,'PROTOCOL_NEGOTIATION_REQUIRED');
});

import {DevelopmentPeer} from '../bundle/development-peer.js';
async function peerSetup(t){
 const f=await bridgeSetup(t),g={c:{role:'local'},db:f.gate.db,now:f.ledger.now,call:(m,a)=>f.bridge.call(m,a,'local')};
 const peers=[];f.open=async()=>{const p=new DevelopmentPeer(g,{lockPort:0},{allowEphemeralLock:true});peers.push(p);await p.start();return p;};t.after(async()=>{for(const p of peers)await p.close();});
 f.clientGateway=g;f.peer=await f.open();return f;
}
test('peer durable offline submission survives restart; reconnect only enqueues, never auto-acquires or writes',async t=>{
 const f=await peerSetup(t),p=f.peer,args=bridgeArgs(f,'offline'),call=f.clientGateway.call;f.clientGateway.call=async()=>{throw Error('COORDINATOR_UNAVAILABLE');};
 p.submit(args);await p.tick();assert.equal(p.view('offline').state,'pending');await p.close();const next=await f.open();
 f.clientGateway.call=call;await next.tick();assert.equal(next.view('offline').state,'cloud_queued');assert.equal(f.store.task(f.task.id).busy,0);assert.equal(git(f.root,'status','--porcelain'),'');
 assert.equal(next.submit(args).request_id,next.view('offline').request_id);assert.throws(()=>next.submit({...args,policy:{...proposal.model_policy,model:'changed'}}),/PEER_CONFLICT/);
});
test('peer acquires, submits exactly one cloud patch and drains tests without touching local paths',async t=>{
 const f=await peerSetup(t),p=f.peer;p.submit(bridgeArgs(f,'peer'));await p.tick();assert((await p.acquire('peer')).acquired);
 const v=await p.read('peer');assert.equal(v.storage_host,'cloud');
 const w={call_id:'one',expected_hash:v.hash,content:good};await p.operation('peer','write',w);assert.equal((await p.operation('peer','write',w)).replayed,true);
 await p.operation('peer','test',{call_id:'test'});assert.equal((await p.finish('peer')).state,'completed');assert.equal(f.store.task(f.task.id).busy,0);
 await assert.rejects(p.operation('peer','write',{...w,call_id:'late'}),/STALE_FENCE/);assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_writes').get().n,1);
});
test('lost acquire response holds the cloud fence and cannot restart as a new writer',async t=>{
 const f=await peerSetup(t),p=f.peer;p.submit(bridgeArgs(f,'claim-unknown'));await p.tick();const original=f.clientGateway.call;
 f.clientGateway.call=async(m,a)=>{const r=await original(m,a);if(m==='development_bridge_claim_acquire')throw Error('COORDINATOR_UNAVAILABLE');return r;};
 await assert.rejects(p.acquire('claim-unknown'));assert.equal(p.view('claim-unknown').state,'needs_review');assert.equal(f.store.task(f.task.id).busy,1);
 await p.close();const next=await f.open();f.clientGateway.call=original;await next.tick();await assert.rejects(next.acquire('claim-unknown'),/NOT_QUEUED/);assert.equal(f.store.task(f.task.id).busy,1);
 assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_bridge_claims').get().n,1);
});
test('lost write result persists uncertainty, blocks local retry and does not hand off after restart',async t=>{
 const f=await peerSetup(t),p=f.peer;p.submit(bridgeArgs(f,'write-unknown'));await p.tick();await p.acquire('write-unknown');const original=f.clientGateway.call;
 f.clientGateway.call=async(m,a)=>{const r=await original(m,a);if(m==='development_bridge_write')throw Error('COORDINATOR_UNAVAILABLE');return r;};
 const a={call_id:'one',expected_hash:null,content:good};await assert.rejects(p.operation('write-unknown','write',a));assert.equal(readFileSync(f.root+'/'+file,'utf8'),good);
 await assert.rejects(p.operation('write-unknown','write',a),/STALE_FENCE/);await p.close();const next=await f.open();await next.tick();assert.equal(next.view('write-unknown').state,'needs_review');
 assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_writes').get().n,1);assert.equal(f.store.task(f.task.id).busy,1);
});
test('peer cannot finish while a test response is in flight; only recorded completion removes the local barrier',async t=>{
 const f=await peerSetup(t),p=f.peer;p.submit(bridgeArgs(f,'test'));await p.tick();await p.acquire('test');await p.operation('test','write',{call_id:'one',expected_hash:null,content:good});
 const testing=p.operation('test','test',{call_id:'test'});await assert.rejects(p.finish('test'),/NOT_DRAINED/);await testing;await p.finish('test');assert.equal(p.view('test').state,'completed');
});
test('unapproved peer request is held for review instead of endless admission retries',async t=>{
 const f=await peerSetup(t),p=f.peer;f.reply(f.prompt,'撤销此方案');await f.chat.tick();p.submit(bridgeArgs(f,'revoked'));await p.tick();assert.equal(p.view('revoked').state,'needs_review');
 let calls=0;f.clientGateway.call=async()=>{calls++;throw Error('must not retry');};await p.tick();assert.equal(calls,0);
});
test('peer startup cannot replace the persisted lock coordinate or survive concurrent close',async t=>{
 const f=await peerSetup(t),g=f.clientGateway,p=f.peer;
 const bad=new DevelopmentPeer(g,{lockPort:1});await assert.rejects(bad.start(),/OWNER_CHANGED/);await bad.close();
 const other=new DevelopmentPeer(g,{lockPort:0},{allowEphemeralLock:true});await assert.rejects(other.start(),/EADDRINUSE/);await other.close();await p.close();
 const closing=new DevelopmentPeer(g,{lockPort:0},{allowEphemeralLock:true}),started=closing.start(),check=assert.rejects(started,/PEER_CLOSED/);await closing.close();await check;assert.equal(closing.lock.listening,false);
});

test('active read-only worker prevents bridge acquisition without blocking unrelated task resources',async t=>{
 const f=await bridgeSetup(t),local=await f.call('enqueue',bridgeArgs(f,'waiting'));
 f.gate.busy=id=>id===f.task.id;assert.equal((await f.call('acquire',{id:local.id,endpoint_id:randomUUID()})).reason,'task_busy');assert.equal(f.store.task(f.task.id).busy,0);
 f.gate.busy=()=>false;assert((await f.call('acquire',{id:local.id,endpoint_id:randomUUID()})).acquired);
});
test('queued bridge cancellation is role-bound and idempotent, but cannot release an active fence',async t=>{
 const f=await peerSetup(t),p=f.peer;p.submit(bridgeArgs(f,'cancel-queued'));await p.tick();const id=p.view('cancel-queued').request_id;
 await assert.rejects(f.call('cancel',{id},'cloud'),/ROLE_DENIED/);assert.equal((await p.cancel('cancel-queued')).state,'cancelled');assert.equal((await f.call('cancel',{id})).replayed,true);
 p.submit(bridgeArgs(f,'active'));await p.tick();await p.acquire('active');const held=p.view('active').request_id;await assert.rejects(f.call('cancel',{id:held}),/NOT_QUEUED/);assert.equal(f.store.task(f.task.id).busy,1);
});

const reviewArgs=(b,proof,event_id='review-one')=>({...b,event_id,proof_hash:proof.proof_hash,note:'operator verified durable evidence; resume same scope',new_endpoint_id:randomUUID()});
async function lostPeer(t,kind='write'){
 const f=await peerSetup(t),p=f.peer,id='lost-'+kind;p.submit(bridgeArgs(f,id));await p.tick();await p.acquire(id);
 if(kind!=='write')await p.operation(id,'write',{call_id:'write',expected_hash:null,content:good});
 if(kind==='finish')await p.operation(id,'test',{call_id:'test'});
 const original=f.clientGateway.call;f.clientGateway.call=async(m,a)=>{const result=await original(m,a);if(m==='development_bridge_'+kind)throw Error('COORDINATOR_UNAVAILABLE');return result;};
 await assert.rejects(kind==='finish'?p.finish(id):p.operation(id,kind,kind==='write'?{call_id:'write',expected_hash:null,content:good}:{call_id:'test'}));
 f.clientGateway.call=original;return {...f,id};
}
test('read-only evidence matches durable unknown write without mutating cloud state or exposing content/ticket/path',async t=>{
 const f=await lostPeer(t),p=f.peer,claim=JSON.parse(p.row(f.id).claim),before=f.gate.db.prepare('SELECT * FROM development_requests').all();
 const evidence=await f.call('evidence',claim);assert.equal(evidence.proof_hash,digest(evidence.evidence));assert.equal(evidence.evidence.writes.length,1);
 const text=JSON.stringify(evidence);for(const secret of [claim.ticket,f.root,good])assert(!text.includes(secret));
 const result=await p.reconcile(f.id);assert.equal(result.unresolved_calls,0);assert.equal(result.state,'needs_review');assert.equal(result.grants_execution,false);assert.equal(f.gate.db.prepare('SELECT error FROM development_peer_calls').get().error,'COORDINATOR_UNAVAILABLE');
 assert.deepEqual(f.gate.db.prepare('SELECT * FROM development_requests').all(),before);assert.equal(f.store.task(f.task.id).busy,1);await assert.rejects(p.read(f.id),/STALE_FENCE/);
 await assert.rejects(f.call('evidence',claim,'cloud'),/STALE_FENCE/);await assert.rejects(f.call('evidence',{...claim,ticket:randomUUID()}),/STALE_FENCE/);
});
test('both sides restart unknown write; explicit reviewed rotation preserves request and budget and fences old client',async t=>{
 const f=await lostPeer(t),old=JSON.parse(f.peer.row(f.id).claim);await f.peer.close();f.gate.recover();const p=await f.open();
 const evidence=await p.reconcile(f.id),r=await p.resumeReviewed(f.id,{event_id:'review-restart',proof_hash:evidence.proof_hash,note:'zero-model fault fixture reviewed'});
 assert.equal(r.epoch,old.epoch+1);assert.equal(r.budget_reset,false);assert.equal(r.request_id,old.id);assert.equal(f.store.task(f.task.id).blocked,0);
 await assert.rejects(f.call('write',{...old,call_id:'stale',expected_hash:null,content:good}),/STALE_FENCE/);
 const result=await p.operation(f.id,'test',{call_id:'after-review-test'});assert.equal(result.cases,6);assert.equal(result.passed,true);await p.finish(f.id);
 assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_writes').get().n,1);assert.equal(f.store.task(f.task.id).busy,0);
 assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_bridge_reviews').get().n,1);
});
for(const kind of ['test','finish'])test('lost '+kind+' result reconciles only original receipts, never reexecutes',async t=>{
 const f=await lostPeer(t,kind),p=f.peer,counts=()=>({w:f.gate.db.prepare('SELECT count(*) n FROM development_writes').get().n,t:f.gate.db.prepare('SELECT count(*) n FROM development_operations').get().n});
 const before=counts(),result=await p.reconcile(f.id);assert.equal(result.unresolved_calls,0);assert.deepEqual(counts(),before);
 if(kind==='finish'){assert.equal(result.state,'completed');assert.equal(f.store.task(f.task.id).busy,0);await assert.rejects(p.resumeReviewed(f.id,{event_id:'cannot-reopen',proof_hash:result.proof_hash,note:'completed'}),/NOT_AVAILABLE/);}
 else{assert.equal(result.state,'needs_review');await p.resumeReviewed(f.id,{event_id:'test-review',proof_hash:result.proof_hash,note:'attested test result'});await p.finish(f.id);assert.deepEqual(counts(),before);}
});
test('mismatching or legacy local fingerprint cannot adopt a remote write receipt or resume',async t=>{
 for(const value of [null,'0'.repeat(64)]){
  const f=await lostPeer(t),p=f.peer;f.gate.db.prepare('UPDATE development_peer_calls SET wire_fingerprint=?').run(value);
  const evidence=await p.reconcile(f.id);assert.equal(evidence.unresolved_calls,1);await assert.rejects(p.resumeReviewed(f.id,{event_id:'deny',proof_hash:evidence.proof_hash,note:'must hold'}),/NOT_AVAILABLE/);assert.equal(f.store.task(f.task.id).busy,1);
 }
});
test('stale proof denies a review after file mutation; evidence cannot be forged by changing its hash',async t=>{
 const f=await bridgeSetup(t),q=await bridgeStart(f),b=bridgeBinding(q),proof=await f.call('evidence',b);
 await f.call('write',{...b,call_id:'write',expected_hash:null,content:good});
 await assert.rejects(f.call('review',reviewArgs(b,proof)),/STALE_EVIDENCE/);assert.equal(f.gate.row(q.id).epoch,q.epoch);
 const g=await lostPeer(t),p=g.peer,original=g.clientGateway.call;g.clientGateway.call=async(m,a)=>{const v=await original(m,a);if(m==='development_bridge_evidence')v.evidence.request_id='tampered';return v;};
 await assert.rejects(p.reconcile(g.id),/EVIDENCE_MISMATCH/);
});
for(const reason of ['expired','revoked','disabled','busy','workspace','unclosed','unsettled','test-unknown','native-job','legacy-intent'])test('review holds '+reason+' without releasing or rebinding scope',async t=>{
 const f=await bridgeSetup(t),q=await bridgeStart(f),b=bridgeBinding(q);f.gate.recover();
 if(reason==='expired')f.time(3600001);
 if(reason==='revoked')f.gate.db.prepare("UPDATE approval_requests SET state='revoked' WHERE id=?").run(f.req.id);
 if(reason==='disabled')f.gate.enabled=false;
 if(reason==='busy')f.gate.busy=()=>true;
 if(reason==='workspace')writeFileSync(f.root+'/'+file,'external unapproved bytes');
 if(reason==='unclosed')f.gate.db.prepare("INSERT INTO development_operations VALUES ('unknown',?,?,'test','spawned',1234567,0,NULL,NULL,NULL)").run(q.id,q.epoch);
 if(reason==='unsettled')f.gate.event(q.id,'write_tool_called',{epoch:q.epoch,call_id:'unknown'});
 if(reason==='test-unknown')f.gate.db.prepare("INSERT INTO development_bridge_tests VALUES ('unknown',?,'fp','running',NULL)").run(q.id);
 if(reason==='legacy-intent')f.gate.db.prepare("INSERT INTO intents(id,task_id,status) VALUES ('legacy-uncertain',?,'writing')").run(f.task.id);
 if(reason==='native-job'){f.gate.db.exec('CREATE TABLE development_jobs(request_id TEXT)');f.gate.db.prepare('INSERT INTO development_jobs VALUES (?)').run(q.id);}
 // Keep freshness stable so this assertion tests the denial reason, not a stale metadata snapshot.
 await f.repos.refresh(f.task.id);const e=await f.call('evidence',b);await assert.rejects(f.call('review',reviewArgs(b,e)),/NOT_AVAILABLE/);
 assert.equal(f.gate.row(q.id).state,'needs_review');assert.equal(f.gate.row(q.id).epoch,q.epoch);assert.equal(f.store.task(f.task.id).busy,1);
});
test('simultaneous exact review retries rotate once; altered event is rejected',async t=>{
 const f=await bridgeSetup(t),q=await bridgeStart(f),b=bridgeBinding(q);f.gate.recover();const a=reviewArgs(b,await f.call('evidence',b));
 const results=await Promise.all([f.call('review',a),f.call('review',a)]);assert.equal(results[0].ticket,results[1].ticket);assert.equal(results[1].replayed,true);
 await assert.rejects(f.call('review',{...a,note:'different'}),/REVIEW_CONFLICT/);await assert.rejects(f.call('review',a,'cloud'),/REVIEW_CONFLICT/);
 assert.equal(f.gate.row(q.id).epoch,q.epoch+1);
});
test('lost review response and client restart reuse same review then require a fresh endpoint rotation',async t=>{
 const f=await lostPeer(t),p=f.peer,e=await p.reconcile(f.id),a={event_id:'review-lost',proof_hash:e.proof_hash,note:'same review'},original=f.clientGateway.call;
 f.clientGateway.call=async(m,args)=>{const v=await original(m,args);if(m==='development_bridge_review')throw Error('COORDINATOR_UNAVAILABLE');return v;};
 await assert.rejects(p.resumeReviewed(f.id,a));const remote=f.gate.row(p.row(f.id).request_id);assert.equal(remote.epoch,3);
 await p.close();const next=await f.open();f.clientGateway.call=original;const replay=await next.resumeReviewed(f.id,a);
 assert.equal(replay.state,'needs_review');assert.equal(replay.grants_execution,false);assert.equal(f.gate.row(remote.id).epoch,3);await assert.rejects(next.read(f.id),/STALE_FENCE/);
 const fresh=await next.reconcile(f.id);await next.resumeReviewed(f.id,{event_id:'review-new-process',proof_hash:fresh.proof_hash,note:'bind new process only'});assert.equal(f.gate.row(remote.id).epoch,4);
 const before=f.gate.row(remote.id).epoch;await next.resumeReviewed(f.id,a);assert.equal(f.gate.row(remote.id).epoch,before);assert.equal(next.view(f.id).state,'active');
 assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_writes').get().n,1);
});
test('write call budget spans rotated epochs and request handoffs, never reset by review',async t=>{
 const f=await bridgeSetup(t),q=await bridgeStart(f),b=bridgeBinding(q);let hash=null;
 for(let i=0;i<3;i++)hash=(await f.call('write',{...b,call_id:'write-'+i,expected_hash:hash,content:good+'\n// '+i})).sha256;
 f.gate.recover();const r=await f.call('review',reviewArgs(b,await f.call('evidence',b))),next=bridgeBinding(r);
 await assert.rejects(f.call('write',{...next,call_id:'fourth',expected_hash:hash,content:good}),/WRITE_CALL_BUDGET/);
 assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_writes').get().n,3);assert.equal(f.gate.row(q.id).expected_hash,hash);
});

test('recovered review acknowledgement cannot reactivate a now revoked approval',async t=>{
 const f=await lostPeer(t),p=f.peer,e=await p.reconcile(f.id),a={event_id:'review-then-revoke',proof_hash:e.proof_hash,note:'same review'},original=f.clientGateway.call;
 f.clientGateway.call=async(m,args)=>{const v=await original(m,args);if(m==='development_bridge_review')throw Error('COORDINATOR_UNAVAILABLE');return v;};
 await assert.rejects(p.resumeReviewed(f.id,a));f.clientGateway.call=original;f.gate.db.prepare("UPDATE approval_requests SET state='revoked' WHERE id=?").run(f.req.id);
 await assert.rejects(p.resumeReviewed(f.id,a),/APPROVAL_REQUIRED/);assert.equal(p.view(f.id).state,'needs_review');await assert.rejects(p.read(f.id),/STALE_FENCE/);
 assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_writes').get().n,1);
});

import {TaskBoard} from '../bundle/task-board.js';
import {developmentSnapshot,developmentPeerSnapshot} from '../bundle/task-board-development.js';
function developmentBoard(f){
 const g={c:{role:'cloud'},store:f.store,db:f.store.db,catalog:f.catalog,approvals:f.ledger,repositories:f.repos,development:{gate:f.gate,bridge:f.bridge},now:f.ledger.now,instanceId:'board-fixture',hello:()=>({plugin_version:'test'}),inboundSnapshot:()=>({state:'unknown'})};
 return {g,board:new TaskBoard({get:()=>null},g)};
}
const allRows=db=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.prepare('SELECT * FROM '+name).all()]);
test('development-only requests appear by task name and task policy; board never acquires, refreshes or checks files',async t=>{
 const f=await bridgeSetup(t),q=await f.call('enqueue',bridgeArgs(f,'board')),{g,board}=developmentBoard(f),before=allRows(f.store.db);
 f.gate.authority=()=>{throw Error('no authority during rendering');};f.repos.refresh=()=>{throw Error('no provider read during rendering');};
 const list=await board.call('board_list',{}),item=list.items.find(x=>x.task_id===f.task.id);assert.equal(item.display_state,'development_queued');assert.equal(item.jobs_total,0);assert.equal(list.development_enabled,true);assert.equal(list.grants_execution,false);assert.equal(item.development_summary.current.requested_model.model,proposal.model_policy.model);
 const d=(await board.call('board_detail',{task_id:f.task.id})).item;assert.equal(d.development.items[0].id,q.id);assert.equal(d.approvals[0].execution_boundary,'requires_runtime_gate');assert.equal(d.approvals[0].execution_enabled,false);assert.equal(d.repository.workspace,'managed_binding_recorded');assert.equal(d.repository.write_enabled,false);assert.deepEqual(allRows(f.store.db),before);
 for(const secret of [f.root,'synthetic-not-a-real-key','approval_hash','workspace_identity','ticket','fingerprint'])assert(!JSON.stringify(d.development).includes(secret));
});
test('development timeline separates held, unclosed test, passed test and handoff; it exposes no ticket or source',async t=>{
 const f=await bridgeSetup(t),q=await bridgeStart(f),b=bridgeBinding(q),{board}=developmentBoard(f),detail=async()=>(await board.call('board_detail',{task_id:f.task.id})).item;
 assert.equal((await detail()).display_state,'development_held');await f.call('write',{...b,call_id:'board-write',expected_hash:null,content:good});
 const run=f.call('test',{...b,call_id:'board-test'}),during=await detail();assert.equal(during.display_state,'development_testing');assert.equal(during.development.items[0].operations.unclosed,1);await run;
 const tested=await detail();assert.equal(tested.display_state,'development_tested');assert.equal(tested.development.items[0].test.cases,6);await f.call('finish',b);
 const done=await detail();assert.equal(done.display_state,'development_handed_off');assert(done.development.items[0].timeline.some(e=>e.type==='safe_point'));assert.equal(done.development.items[0].budget.writes_recorded,1);for(const secret of [q.ticket,q.endpoint_id,good,f.root])assert(!JSON.stringify(done.development).includes(secret));
});
test('queued peer reason follows task holder, resource conflicts and review rather than falsely disabled',async t=>{
 const f=await bridgeSetup(t),q=await bridgeStart(f,'cloud');await f.call('enqueue',bridgeArgs(f,'board-peer'));const {board}=developmentBoard(f),d=(await board.call('board_detail',{task_id:f.task.id})).item;
 assert.equal(d.development.items.find(r=>r.node==='local').state,'task_busy');assert.equal(d.display_state,'development_held');
 f.gate.recover();const blocked=(await board.call('board_detail',{task_id:f.task.id})).item;assert.equal(blocked.display_state,'development_review');assert.equal(blocked.development.items[0].recorded_state,'needs_review');assert.equal(blocked.development.items[0].epoch,q.epoch);
});
test('finished old revision cannot label new register-only task completed; unresolved history stays visible',async t=>{
 const f=await bridgeSetup(t),q=await bridgeStart(f),b=bridgeBinding(q),{board}=developmentBoard(f);await f.call('write',{...b,call_id:'w',expected_hash:null,content:good});await f.call('test',{...b,call_id:'t'});await f.call('finish',b);
 const {selectedHumanContext}=await import('../bundle/task-envelope.js'),agent={id:'board-revision',session:{deriveMessages:()=>[{id:'new-context',role:'user',source:{kind:'user'},content:[{type:'text',text:'只登记新修订，不执行旧方案。'}]}]}};
 f.catalog.amend('cloud',{task_id:f.task.id,expected_revision:1,event_id:'new-revision',summary:'新修订',intent:'register',sources:selectedHumanContext(agent,'cloud')},()=>{});
 const d=(await board.call('board_detail',{task_id:f.task.id})).item;assert.equal(d.display_state,'registered');assert.equal(d.development.items[0].spec_revision,1);assert.equal(d.spec_revision,2);
});
test('projection never adopts missing evidence or a foreign approval as valid ownership',async t=>{
 const f=await bridgeSetup(t),q=await bridgeStart(f),{g,board}=developmentBoard(f);f.gate.db.prepare('UPDATE development_requests SET workspace_identity=NULL WHERE id=?').run(q.id);
 assert.equal((await board.call('board_detail',{task_id:f.task.id})).item.display_state,'development_evidence_missing');
 f.gate.db.prepare('UPDATE approval_requests SET task_id=? WHERE id=?').run('other-task',f.req.id);const d=developmentSnapshot(g,f.task.id,1);assert.equal(d.items[0].approval_id,null);assert.equal(d.items[0].budget,null);assert.equal(d.items[0].state,'development_evidence_missing');
});
test('stopped runtime with historical held fence does not imply no development requests or free resource',async t=>{
 const f=await bridgeSetup(t);await bridgeStart(f);const {g,board}=developmentBoard(f);g.development=null;
 const d=(await board.call('board_detail',{task_id:f.task.id})).item;assert.equal(d.development.configuration.runtime_enabled,false);assert.equal(d.display_state,'development_runtime_unavailable');assert.equal(d.coordination.busy,true);assert.equal(d.development.total,1);
});
test('bounded projection prioritizes unfinished history over many completed requests without losing total',async t=>{
 const f=await bridgeSetup(t),q=await bridgeStart(f),{g}=developmentBoard(f),db=f.store.db,cols=db.prepare('PRAGMA table_info(development_requests)').all().map(c=>c.name).filter(n=>n!=='seq');
 for(let i=0;i<25;i++){const r={...f.gate.row(q.id),id:'history-'+i,event_id:'history-'+i,state:'completed',created:i};db.prepare('INSERT INTO development_requests('+cols.join(',')+') VALUES ('+cols.map(()=>'?').join(',')+')').run(...cols.map(n=>r[n]));}
 const d=developmentSnapshot(g,f.task.id,1);assert.equal(d.total,26);assert.equal(d.items.length,20);assert.equal(d.items[0].id,q.id);assert.equal(d.current.state,'development_held');
});
test('local peer view is independent of cloud approval; unknown receipt remains visible without exposing claim or payload',async t=>{
 const f=await lostPeer(t),p=f.peer,before=allRows(f.store.db),v=developmentPeerSnapshot(f.clientGateway,f.task.id);
 assert.equal(v.total,1);assert.equal(v.items[0].state,'needs_review');assert.equal(v.items[0].unresolved_calls,1);assert.equal(v.items[0].authority,'viewer_local_only');assert.equal(v.items[0].grants_execution,false);
 const claim=JSON.parse(p.row(f.id).claim);assert(!JSON.stringify(v).includes(claim.ticket));assert(!JSON.stringify(v).includes(claim.endpoint_id));assert.deepEqual(allRows(f.store.db),before);
 assert.equal(developmentPeerSnapshot(f.clientGateway,'unrelated-task').total,0);
});

test('development projections map unrecognized ledger states to unknown rather than echo arbitrary payloads',async t=>{
 const f=await lostPeer(t),{g}=developmentBoard(f),p=f.peer,id=p.view(f.id).request_id,db=f.store.db;
 db.prepare("UPDATE development_requests SET state='PRIVATE_STATE_NOT_FOR_UI' WHERE id=?").run(id);
 db.prepare("UPDATE development_writes SET state='PRIVATE_WRITE_STATE' WHERE request_id=?").run(id);
 db.prepare("UPDATE development_peer_requests SET state='PRIVATE_PEER_STATE' WHERE id=?").run(f.id);
 const before=allRows(db),d=developmentSnapshot(g,f.task.id,1),v=developmentPeerSnapshot(f.clientGateway,f.task.id);
 assert.equal(d.items[0].recorded_state,'unknown');assert.equal(d.items[0].state,'development_unknown');assert.equal(d.items[0].writes[0].state,'unknown');assert.equal(v.items[0].state,'unknown');
 assert(!JSON.stringify({d,v}).includes('PRIVATE_'));assert.deepEqual(allRows(db),before);
});

async function lostAcquire(t){
 const f=await peerSetup(t),p=f.peer,id='claim-receipt';p.submit(bridgeArgs(f,id));await p.tick();const original=f.clientGateway.call;
 f.clientGateway.call=async(m,a)=>{const r=await original(m,a);if(m==='development_bridge_claim_acquire')throw Error('COORDINATOR_UNAVAILABLE');return r;};
 await assert.rejects(p.acquire(id));f.clientGateway.call=original;return {...f,id};
}
test('durable pre-acquire secret recovers a lost claim after both restarts, but requires explicit same-scope review',async t=>{
 const f=await lostAcquire(t),id=f.id,originalRequest=f.peer.view(id).request_id;assert.equal(f.peer.row(id).claim,null);
 const old=f.gate.db.prepare('SELECT * FROM development_bridge_claims').get();await f.peer.close();f.gate.recover();const p=await f.open(),before=allRows(f.store.db).filter(([n])=>!n.startsWith('development_peer'));
 const e=await p.reconcile(id);assert.equal(e.state,'needs_review');assert.equal(e.grants_execution,false);assert.equal(e.unresolved_calls,0);await assert.rejects(p.read(id),/STALE_FENCE/);
 assert.deepEqual(allRows(f.store.db).filter(([n])=>!n.startsWith('development_peer')),before);
 const r=await p.resumeReviewed(id,{event_id:'claim-recovered',proof_hash:e.proof_hash,note:'operator verified original claim receipt'});assert.equal(r.epoch,old.epoch+1);assert.equal(r.request_id,originalRequest);assert.equal(r.budget_reset,false);
 await p.operation(id,'write',{call_id:'one',expected_hash:null,content:good});await p.operation(id,'test',{call_id:'one-test'});await p.finish(id);
 assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_writes').get().n,1);assert.equal(f.store.task(f.task.id).busy,0);
});
test('claim receipt requires original secret, role, endpoint and epoch; legacy acquire cannot bypass it',async t=>{
 const f=await lostAcquire(t),i=f.gate.db.prepare('SELECT * FROM development_peer_claim_intents').get(),args={id:i.request_id,endpoint_id:i.endpoint_id,recovery_key:i.recovery_key};
 const c=await f.call('claim_receipt',args);assert.equal(c.grants_execution,false);
 for(const patch of [{recovery_key:randomUUID()},{endpoint_id:randomUUID()},{id:'other'}])await assert.rejects(f.call('claim_receipt',{...args,...patch}),/RECEIPT_UNAVAILABLE/);
 await assert.rejects(f.call('claim_receipt',args,'cloud'),/RECEIPT_UNAVAILABLE/);await assert.rejects(f.call('acquire',{id:i.request_id,endpoint_id:i.endpoint_id}),/RECEIPT_UNAVAILABLE/);
 const e=await f.peer.reconcile(f.id);await f.peer.resumeReviewed(f.id,{event_id:'rotate',proof_hash:e.proof_hash,note:'verified'});await assert.rejects(f.call('claim_receipt',args),/RECEIPT_UNAVAILABLE/);
});
test('receipt lookup never treats absent or delayed acquire as safely ungranted',async t=>{
 const f=await peerSetup(t),p=f.peer,id='not-sent';p.submit(bridgeArgs(f,id));await p.tick();const original=f.clientGateway.call;
 f.clientGateway.call=async()=>{throw Error('COORDINATOR_UNAVAILABLE');};await assert.rejects(p.acquire(id));f.clientGateway.call=original;
 await assert.rejects(p.reconcile(id),/RECEIPT_UNAVAILABLE/);assert.equal(p.view(id).state,'needs_review');assert.equal(f.gate.row(p.view(id).request_id).state,'queued');await assert.rejects(p.acquire(id),/NOT_QUEUED/);
});
for(const condition of ['revoked','legacy','tampered'])test('lost claim remains held for '+condition,async t=>{
 const f=await lostAcquire(t),p=f.peer;
 if(condition==='legacy')f.gate.db.prepare('DELETE FROM development_peer_claim_intents').run();
 if(condition==='tampered')f.gate.db.prepare('UPDATE development_peer_claim_intents SET recovery_key=?').run(randomUUID());
 if(condition==='revoked'){
  f.gate.db.prepare("UPDATE approval_requests SET state='revoked'").run();const e=await p.reconcile(f.id);await assert.rejects(p.resumeReviewed(f.id,{event_id:'revoked',proof_hash:e.proof_hash,note:'denied'}),/NOT_AVAILABLE/);
 }else await assert.rejects(p.reconcile(f.id),/NOT_AVAILABLE|RECEIPT_UNAVAILABLE/);
 assert.equal(p.view(f.id).state,'needs_review');assert.equal(f.store.task(f.task.id).busy,1);assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_writes').get().n,0);
});
test('model-facing projections never reveal durable acquire recovery secrets',async t=>{
 const f=await lostAcquire(t),i=f.gate.db.prepare('SELECT * FROM development_peer_claim_intents').get(),{g}=developmentBoard(f);
 const projected=JSON.stringify({cloud:developmentSnapshot(g,f.task.id,1),local:developmentPeerSnapshot(f.clientGateway,f.task.id)});assert(!projected.includes(i.recovery_key));assert(!projected.includes(i.endpoint_id));
});

test('explicit cancel of unknown claim closes only a still-queued request; an applied claim cannot be released',async t=>{
 const f=await peerSetup(t),p=f.peer,id='lost-before-send';p.submit(bridgeArgs(f,id));await p.tick();const call=f.clientGateway.call;
 f.clientGateway.call=async()=>{throw Error('COORDINATOR_UNAVAILABLE');};await assert.rejects(p.acquire(id));f.clientGateway.call=call;
 assert.equal((await p.cancel(id)).state,'cancelled');assert.equal(f.gate.row(p.view(id).request_id).state,'rejected');assert.equal(f.store.task(f.task.id).busy,0);
 const g=await lostAcquire(t);await assert.rejects(g.peer.cancel(g.id),/NOT_QUEUED/);assert.equal(g.store.task(g.task.id).busy,1);
});
test('cancelled queued request prevents a delayed initial acquire from subsequently gaining ownership',async t=>{
 const f=await peerSetup(t),p=f.peer,id='delayed-claim';p.submit(bridgeArgs(f,id));await p.tick();const refresh=f.repos.refresh.bind(f.repos);let release;
 f.repos.refresh=()=>new Promise(r=>{release=()=>r();});const acquiring=p.acquire(id);const checked=assert.rejects(acquiring,/NOT_QUEUED/);
 await new Promise(r=>setImmediate(r));assert(release);p.state(id,'needs_review','COORDINATOR_UNAVAILABLE'); // observer timed out while server is still awaiting metadata
 await p.cancel(id);release();await checked;f.repos.refresh=refresh;
 assert.equal(f.store.task(f.task.id).busy,0);assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_bridge_claims').get().n,0);assert.equal(f.gate.row(p.view(id).request_id).state,'rejected');assert.equal(p.view(id).state,'cancelled');
});

import {DeliveryPreview} from '../bundle/delivery-preview.js';
test('legacy bounded unit fixture gets file-specific delivery preview without pretending it is a tested commit',async t=>{
 const f=await setup(t),q=start(f);write(f,q);await f.gate.test(q.id,'cloud',q.epoch);f.gate.finish(q.id,'cloud',q.epoch,{agentDrained:true});
 const service=new DeliveryPreview({store:f.store,approvals:f.ledger,repositories:f.repos,development:{gate:f.gate},now:f.ledger.now,assertTaskQuiescent(){}});
 const p=service.create('cloud',{task_id:f.task.id,expected_revision:1,event_id:'legacy-unit-preview'}).snapshot;
 assert.equal(p.tested_content.kind,'file_sha256');assert.equal(p.tested_content.test.cases,6);assert.equal(p.tested_content.bound_commit,null);assert.equal(p.files.length,1);assert.equal(p.files[0].path,file);assert.equal(p.files[0].comparison.after,good);assert.equal(git(f.root,'rev-parse','HEAD'),f.base_sha);
});
