import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOnboardingState} from '../bundle/onboarding-state.js';
import {createOnboardingRepository} from '../bundle/onboarding-repository.js';
import {createOnboardingRepositories} from '../bundle/onboarding-repositories.js';
import {createOnboardingService} from '../bundle/onboarding-host.js';
import {ManagedGiteeReadOnly} from '../bundle/repository-managed.js';
import {GiteeReadOnly} from '../bundle/repository-gitee.js';
import {Gateway} from '../bundle/index.js';
import {makeEnvelope} from '../bundle/task-envelope.js';
const url='https://gitee.com/fixture/results',sha='a'.repeat(40),key='dsh-task-gateway/onboarding-repositories-v1',secret='SYNTHETIC_GITEE_ONLY_12345678';
const input={url,alias:'任务成果',authentication:'anonymous',enabled:true};
const confirm=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true});
function fixture(){
 const records=new Map(),calls=[];let tail=Promise.resolve(),writes=0,time=1000,lose=false;
 const credentials={readRecord:async k=>structuredClone(records.get(k)),describeRecord:async()=>({writable:true}),modifyRecord(k,fn){const p=tail.then(()=>{const v=fn(structuredClone(records.get(k)));if(v!==undefined){writes++;records.set(k,structuredClone(v));if(lose){lose=false;throw Error('LOST');}}});tail=p.catch(()=>{});return p;}};
 const config={role:'cloud',repositoryAccess:{managedOnboarding:true}},runtime={credentials,platform:'linux',home:'/isolated/home',env:{},now:()=>time};
 runtime.repositoryFetch=async(u,o)=>{calls.push({u,o});const full=u.slice('https://gitee.com/api/v5/repos/'.length).split('/').slice(0,2).join('/');return Response.json(u.includes('/branches/')?{name:decodeURIComponent(u.split('/branches/')[1]),commit:{sha}}:{id:8,full_name:full,private:false,default_branch:'main'});};
 const state=createOnboardingState({},config,runtime),repo=createOnboardingRepository({state,config,runtime,now:runtime.now});
 const deps={state,credentials:()=>credentials,repository:repo,config,runtime,now:runtime.now};
 const registry=createOnboardingRepositories(deps);
 const adapter=(c={})=>new ManagedGiteeReadOnly(c,{registry,state,fetch:(...a)=>runtime.repositoryFetch(...a)});
 return {records,calls,state,runtime,config,credentials,deps,registry,adapter,writes:()=>writes,advance:n=>time+=n,lose:()=>lose=true,put:(rev=0,slot='gitee',value=secret)=>state.put({slot,secret:value,expectedRevision:rev,operation:randomUUID(),confirm:true})};
}
async function register(f,a=input){const p=await f.registry.preview(a);return f.registry.apply(confirm(p));}
test('fresh registry/status and drafts are not task/runtime activation; preview reads only',async()=>{
 const f=fixture(),s=await f.registry.status({});assert.equal(s.revision,0);assert.equal(f.calls.length,0);assert.equal(f.writes(),0);
 const p=await f.registry.preview(input);assert.equal(f.writes(),0);assert.equal(p.registryRevision,0);assert(!p.taskBound&&!p.writeAuthorized);assert.equal(f.calls.length,2);
 assert.equal((await f.adapter().reference('任务成果')).reason,'UNKNOWN_REPOSITORY_ALIAS');
});
test('explicit registration persists metadata only and restart restores natural aliases',async()=>{
 const f=fixture(),s=await register(f);assert.equal(s.revision,1);assert(!s.taskBound&&!s.writeAuthorized);assert(!JSON.stringify(s).includes(secret));
 const restarted=createOnboardingRepositories(f.deps);assert.deepEqual(await restarted.status({}),s);
 assert.deepEqual(await f.adapter().reference(' 任务成果 '),{url});assert.equal((await f.adapter().resolve('任务成果')).snapshot.repository_id,8);
 assert(f.calls.every(c=>c.o.method==='GET'&&c.o.redirect==='error'&&!c.o.headers.Authorization));
});
test('no explicit runtime opt-in leaves static provider and aliases unchanged',async t=>{
 const f=fixture();await register(f);const root=await mkdtemp(join(tmpdir(),'s56-registry-static-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const tokenFile=join(root,'gateway.json');await writeFile(tokenFile,JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});
 const g=new Gateway({on(){},effect(){}}, {role:'cloud',stateDir:join(root,'state'),tokenFile,peerEnabled:false,entryMode:'native'}, {repository:{registry:f.registry,state:f.state,fetch:f.runtime.repositoryFetch}});t.after(()=>g.close());
 assert(g.repositories.provider instanceof GiteeReadOnly);assert.equal((await g.repositories.resolve({reference:'任务成果'})).reason,'UNKNOWN_REPOSITORY_ALIAS');
});
test('opt-in Gateway repository catalog consumes confirmed registry but grants no development',async t=>{
 const f=fixture();await register(f);const root=await mkdtemp(join(tmpdir(),'s56-registry-runtime-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const tokenFile=join(root,'gateway.json');await writeFile(tokenFile,JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});
 const g=new Gateway({on(){},effect(){}}, {role:'cloud',stateDir:join(root,'state'),tokenFile,peerEnabled:false,entryMode:'native',repositoryAccess:{managedOnboarding:true}}, {repository:{registry:f.registry,state:f.state,fetch:f.runtime.repositoryFetch}});t.after(()=>g.close());
 const r=await g.repositories.resolve({reference:'任务成果'});assert(r.resolution_id);assert.equal(r.url,url);assert.equal(r.execution,'disabled');assert.equal(r.access.write,'unknown');assert.equal(r.workspace,null);assert.equal(r.branch_source,'provider_default');
 assert.equal(g.development,undefined);assert.equal(g.store.db.prepare('SELECT count(*) AS n FROM repository_associations').get().n,0);
 const message={id:'m1',role:'user',source:{kind:'user'},content:[{type:'text',text:'将回归任务关联到任务成果，不开发'}]},agent={id:'fixture-session',session:{deriveMessages:()=>[message]}};
 const envelope=makeEnvelope(agent,'cloud',{target:'cloud',intent:'register',goal:'只登记仓库关联测试'}),task=g.store.accept('cloud',{...envelope,source:'unit'});
 const binding={task_id:task.id,event_id:randomUUID(),expected_revision:1,expected_binding_revision:0,resolution_id:r.resolution_id,sources:[{role:'cloud',session_id:agent.id,...envelope.request}]};
 g.store.begin('cloud',{task_id:task.id,epoch:1});await assert.rejects(g.call('repository_bind',binding),/TASK_NOT_QUIESCENT/);
 g.store.db.prepare('UPDATE tasks SET busy=0 WHERE id=?').run(task.id);
 const b=await g.call('repository_bind',binding);assert.equal(b.state,'bound');assert.equal(b.execution,'disabled');
 const gate=await g.call('repository_gate',{task_id:task.id});assert.equal(gate.executable,false);assert(gate.blockers.includes('WORKSPACE_NOT_BOUND'));assert(gate.blockers.includes('APPROVAL_NOT_VALID_FOR_OPERATION'));assert.equal(gate.queued,false);

});
test('managed registration/runtime uses only target Gitee slot and never staged/model credentials',async()=>{
 const f=fixture();await f.put(0,'gitee-cloud');await f.put(0,'deepseek-local');await assert.rejects(register(f,{...input,authentication:'managed'}),/CREDENTIAL_REQUIRED/);assert.equal(f.calls.length,0);
 await f.put();await register(f,{...input,authentication:'managed'});f.calls.length=0;await f.adapter().inspect(url);assert(f.calls.every(c=>c.o.headers.Authorization==='Bearer '+secret));
 await f.state.remove({slot:'gitee',operation:randomUUID(),expectedRevision:1,confirm:true});f.calls.length=0;await assert.rejects(f.adapter({aliases:[{name:'Legacy',url}]}).inspect(url),/CREDENTIAL_REQUIRED/);assert.equal(f.calls.length,0);
});
test('explicit anonymous registration ignores both managed and legacy credentials',async t=>{
 const f=fixture();await f.put();await register(f);const root=await mkdtemp(join(tmpdir(),'s56-registry-token-'));t.after(()=>rm(root,{recursive:true,force:true}));const tokenFile=join(root,'legacy-token');await writeFile(tokenFile,'SYNTHETIC_LEGACY_UNUSED_123456',{mode:0o600});await f.adapter({tokenFile}).inspect(url);assert(f.calls.every(c=>!c.o.headers.Authorization));
});
test('static vs registered alias ambiguity asks instead of overriding legacy mapping',async()=>{
 const f=fixture();await register(f,{...input,alias:'Results'});const r=await f.adapter({aliases:[{name:'results',url:'https://gitee.com/other/repo'}]}).reference('RESULTS');assert(r.requires_clarification);assert.equal(r.reason,'AMBIGUOUS_REPOSITORY_ALIAS');assert.equal(r.candidates.length,2);
});
test('NFKC duplicate alias conflicts do not overwrite another registration',async()=>{
 const f=fixture();await register(f,{...input,alias:'Result'});await assert.rejects(register(f,{...input,url:'https://gitee.com/other/repo',alias:'Ｒｅｓｕｌｔ'}),/ALIAS_CONFLICT/);assert.equal((await f.registry.status({})).revision,1);
});
test('disable is confirmed, retains tombstone, does not delete credential or fall back to legacy',async()=>{
 const f=fixture();await f.put();await register(f);const n=f.calls.length;await register(f,{...input,enabled:false});assert.equal(f.calls.length,n);assert.equal((await f.state.readManagedSecret('gitee')).value,secret);
 assert.equal((await f.adapter().reference('任务成果')).reason,'REGISTERED_REPOSITORY_DISABLED');await assert.rejects(f.adapter().inspect(url),/REGISTRATION_DISABLED/);
 assert.equal((await f.registry.status({})).entries.length,1);await register(f);assert.equal((await f.adapter().inspect(url)).repository_id,8);
});
test('expired/stale plans and credential changes fail without registration writes',async()=>{
 const f=fixture();let p=await f.registry.preview(input);f.advance(300001);await assert.rejects(f.registry.apply(confirm(p)),/PLAN_EXPIRED/);assert.equal(f.writes(),0);
 await f.put();p=await f.registry.preview({...input,authentication:'managed'});await f.put(1);await assert.rejects(f.registry.apply(confirm(p)),/CREDENTIAL_CHANGED/);assert.equal((await f.registry.status({})).revision,0);
});
test('competing registrars use official-store CAS; failed apply consumes plan',async()=>{
 const f=fixture(),g=createOnboardingRepositories(f.deps),p=await f.registry.preview(input),q=await g.preview({...input,alias:'另一个名字'});await f.registry.apply(confirm(p));await assert.rejects(g.apply(confirm(q)),/REGISTRY_CONFLICT/);await assert.rejects(g.apply(confirm(q)),/PLAN_EXPIRED/);assert.equal(f.writes(),1);
});
test('lost write response is reconciled by durable status after restart; never resubmitted',async()=>{
 const f=fixture(),p=await f.registry.preview(input);f.lose();await assert.rejects(f.registry.apply(confirm(p)),/LOST/);const g=createOnboardingRepositories(f.deps),s=await g.status({});assert.equal(s.appliedOperation,p.id);assert.equal(s.appliedPlanHash,p.fingerprint);await assert.rejects(g.apply(confirm(p)),/PLAN_EXPIRED/);assert.equal(f.writes(),1);
});
test('foreign/corrupt records are not overwritten or used by runtime',async()=>{
 const f=fixture();f.records.set(key,{kind:'api-key',value:'USER_VALUE'});await assert.rejects(f.registry.preview(input),/REGISTRY_REVIEW/);await assert.rejects(f.adapter().inspect(url),/REGISTRY_UNAVAILABLE/);assert.equal(f.records.get(key).value,'USER_VALUE');assert.equal(f.writes(),0);
});
test('registry or credentials changing during I/O invalidates results; repository identity is pinned',async()=>{
 for(const kind of ['registry','credential','identity']){
  const f=fixture();await f.put();await register(f,{...input,authentication:'managed'});const get=f.runtime.repositoryFetch;let n=0;
  f.runtime.repositoryFetch=async(...a)=>{const r=await get(...a);if(++n===1){if(kind==='registry')f.records.get(key).payload.revision++;if(kind==='credential')await f.put(1);if(kind==='identity'){const body=await r.json();return Response.json({...body,id:99});}}return r;};
  await assert.rejects(f.adapter().inspect(url),new RegExp(kind==='registry'?'REGISTRY_CHANGED':kind==='credential'?'CREDENTIAL_CHANGED':'IDENTITY_MISMATCH'));
 }
});
test('registered file/commit validation checks registered identity before network',async()=>{
 const f=fixture();await register(f);f.calls.length=0;for(const method of ['file','commit'])await assert.rejects(f.adapter()[method]({url,repository_id:99,base_sha:sha},'x'),/IDENTITY_MISMATCH/);assert.equal(f.calls.length,0);
});
for(const patch of [{alias:''},{alias:'https://gitee.com/a/b'},{alias:'bad\nname'},{authentication:'auto'},{url:'https://example.com/a/b'},{token:secret},{branch:'main'}])test('registration rejects noncontract input '+Object.keys(patch),async()=>{const f=fixture();await assert.rejects(f.registry.preview({...input,...patch}),/REGISTRY_ARGUMENTS/);assert.equal(f.calls.length,0);assert.equal(f.writes(),0);});
test('public RPC exposes status/preview/confirm only; draft and task bindings remain separate',async()=>{
 const f=fixture(),s=createOnboardingService({},f.config,f.runtime);assert.equal((await s.call('repository_registry_status',{})).revision,0);
 const p=await s.call('repository_registry_preview',input);const r=await s.call('repository_registry_apply',confirm(p));assert.equal(r.revision,1);assert(!r.writeAuthorized&&!r.taskBound);
 for(const method of ['repository_registry_secret','repository_registry_execute','repository_registry_push'])await assert.rejects(s.call(method,{}),/METHOD_DENIED/);
});
test('native optional service scope is used only on explicit cloud opt-in',async()=>{
 const s=await readFile(new URL('../bundle/native-entry.js',import.meta.url),'utf8');assert(s.includes("config.role==='cloud'&&config.repositoryAccess?.managedOnboarding===true"));assert(s.includes("ctx.inject?.(['credentials']"));assert(s.includes('if(credentials===current)credentials=undefined'));
});
