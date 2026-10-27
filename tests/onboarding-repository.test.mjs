import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {createOnboardingRepository,createOnboardingCloudRepository,repositoryCheckResult} from '../bundle/onboarding-repository.js';
import {createOnboardingState} from '../bundle/onboarding-state.js';
import {createOnboardingService} from '../bundle/onboarding-host.js';
import {createOnboardingHandoff} from '../bundle/onboarding-handoff.js';
import {digest} from '../bundle/onboarding-ssh.js';
const url='https://gitee.com/fixture/task-results',sha='a'.repeat(40),secret='SYNTHETIC_GITEE_NOT_REAL_123456789',args={url,branch:'',authentication:'anonymous'};
function store(){const records=new Map();let writes=0;return {records,writes:()=>writes,readRecord:async k=>structuredClone(records.get(k)),describeRecord:async()=>({writable:true}),modifyRecord:async(k,fn)=>{const v=fn(structuredClone(records.get(k)));if(v!==undefined){records.set(k,structuredClone(v));writes++;}}};}
function fixture(){
 const credentials=store(),calls=[],runtime={credentials,home:'/isolated/home',env:{GITEE_TOKEN:'DO_NOT_READ_ENV'},platform:'linux'};
 runtime.repositoryFetch=async(u,options)=>{calls.push({u,options});assert(u.startsWith('https://gitee.com/api/v5/repos/fixture/task-results'));return Response.json(u.includes('/branches/')?{name:decodeURIComponent(u.split('/branches/')[1]),commit:{sha}}:{id:8,full_name:'fixture/task-results',private:false,default_branch:'main'});};
 const state=createOnboardingState({}, {},runtime),deps={state,config:{onboarding:{role:'cloud'}},runtime,now:()=>1000};
 return {credentials,calls,runtime,state,deps,repo:createOnboardingRepository(deps),put:(slot='gitee',revision=0,value=secret)=>state.put({slot,operation:randomUUID(),expectedRevision:revision,confirm:true,secret:value})};
}
test('manual anonymous metadata read uses fixed GET API only; no credentials, default task, workspace or authorization',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);const r=await f.repo.inspect(args);assert.equal(f.calls.length,2);assert.equal(f.credentials.writes(),0);assert.equal(r.repository.branch,'main');assert.equal(r.credentialRevision,0);assert.equal(r.taskBound,false);assert.equal(r.writeAuthorized,false);assert.equal(r.repository.workspace,null);assert.equal(r.target.role,'cloud');assert.equal(r.observedAt,1000);
 for(const c of f.calls){assert.equal(c.options.method,'GET');assert.equal(c.options.redirect,'error');assert(!c.options.headers.Authorization);assert(c.options.signal instanceof AbortSignal);}
});
test('managed mode only reads this Host dedicated Gitee slot, never model or staged credentials',async()=>{
 const f=fixture();for(const slot of ['deepseek-local','deepseek-cloud','gitee-cloud'])await f.put(slot);
 await assert.rejects(f.repo.inspect({...args,authentication:'managed'}),/CREDENTIAL_REQUIRED/);assert.equal(f.calls.length,0);await f.put();const writes=f.credentials.writes();const r=await f.repo.inspect({...args,branch:'feature/check',authentication:'managed'});assert.equal(r.credentialRevision,1);assert.equal(f.credentials.writes(),writes);assert(f.calls.every(c=>c.options.headers.Authorization==='Bearer '+secret&&!c.u.includes(secret)));assert(!JSON.stringify(r).includes(secret));
});
test('explicit anonymous mode does not use stored token; invalid managed token never reaches network',async()=>{const f=fixture();await f.put('gitee',0,'invalid.token!');await f.repo.inspect(args);assert(!f.calls.some(c=>c.options.headers.Authorization));f.calls.length=0;await assert.rejects(f.repo.inspect({...args,authentication:'managed'}),/CREDENTIAL_INVALID/);assert.equal(f.calls.length,0);});
for(const patch of [{url:'http://gitee.com/a/b'},{url:'https://user:pass@gitee.com/a/b'},{url:url+'?access_token=secret'},{url:'https://exfil.invalid/a/b'},{branch:'../bad'},{branch:42},{authentication:'auto'},{token:secret},{method:'POST'},{confirm:true}])test('invalid repository request rejected without I/O '+JSON.stringify(patch),async()=>{const f=fixture();await assert.rejects(f.repo.inspect({...args,...patch}),/ARGUMENTS/);assert.equal(f.calls.length,0);assert.equal(f.credentials.writes(),0);});
for(const [status,code] of [[401,'ACCESS_DENIED'],[403,'ACCESS_DENIED'],[404,'NOT_FOUND_OR_PRIVATE'],[429,'RATE_LIMIT'],[503,'PROVIDER_UNAVAILABLE']])test('provider status '+status+' classified without leaking body or retry',async()=>{const f=fixture();let n=0;f.runtime.repositoryFetch=async()=>{n++;return new Response(secret,{status});};await assert.rejects(f.repo.inspect(args),e=>e.message==='ONBOARDING_REPOSITORY_'+code&&!e.message.includes(secret));assert.equal(n,1);});
test('credential rotation during metadata request invalidates the observation',async()=>{const f=fixture();await f.put();const get=f.runtime.repositoryFetch;let n=0;f.runtime.repositoryFetch=async(...a)=>{const r=await get(...a);if(++n===2)await f.put('gitee',1,secret+'NEW');return r;};await assert.rejects(f.repo.inspect({...args,authentication:'managed'}),/CREDENTIAL_CHANGED/);});
test('duplicate clicks cannot start concurrent reads or authorize retries',async()=>{const f=fixture(),get=f.runtime.repositoryFetch;let release;f.runtime.repositoryFetch=async(...a)=>{await new Promise(r=>release=r);return get(...a);};const p=f.repo.inspect(args);await assert.rejects(f.repo.inspect(args),/BUSY/);release();await new Promise(r=>setImmediate(r));release();await p;});
test('malformed metadata is not converted to a successful read',async()=>{const f=fixture();f.runtime.repositoryFetch=async()=>Response.json({id:8,full_name:'other/wrong',private:true,default_branch:'main',token:secret});await assert.rejects(f.repo.inspect(args),/IDENTITY_MISMATCH/);});
test('cloud wrapper validates result and fixed target, never falls back to local',async()=>{
 const f=fixture(),target={operationId:randomUUID(),installationId:randomUUID(),runtimeId:randomUUID(),manifestHash:'a'.repeat(64),root:'/isolated/cloud',role:'cloud',hostVersion:'0.2.1-rc.2'};let calls=0,wrong=false,offline=false;
 const remote=async(m,a)=>{calls++;assert.equal(m,'repository_inspect');if(offline)throw Error('OFFLINE');const value=await f.repo.inspect(a);return {target,value:wrong?{...value,writeAuthorized:true}:value};},cloud=createOnboardingCloudRepository({remote,enabled:()=>true,now:()=>1100});
 assert(cloud.available());assert.equal(calls,0);const r=await cloud.inspect(args);assert.equal(r.scope,'managed_cloud_only');assert.equal(r.checkedAt,1100);wrong=true;await assert.rejects(cloud.inspect(args),/RESPONSE_REVIEW/);offline=true;await assert.rejects(cloud.inspect(args),/OFFLINE/);assert.equal(calls,3);
});
test('new native entry exposes only manual read contract and guarded dedicated credentials',async()=>{const f=fixture(),s=createOnboardingService({},f.deps.config,f.runtime),d=await s.call('describe',{});assert(d.capabilities.repositoryCheckContract===1&&d.capabilities.cloudRepositoryCheck&&d.capabilities.cloudGiteeHandoff);assert(!d.capabilities.write);assert.equal(f.calls.length,0);assert.equal((await s.call('repository_inspect',args)).repository.repository_id,8);for(const m of ['repository_clone','repository_push','repository_commit','repository_bind'])await assert.rejects(s.call(m,{}),/METHOD_DENIED/);});
test('Gitee handoff keeps separate ledgers, reconciles unknown outcome without resend, and fences delayed writes',async()=>{
 const local=fixture(),cloud=fixture(),target={operationId:randomUUID(),installationId:randomUUID(),runtimeId:randomUUID(),manifestHash:'a'.repeat(64),root:'/isolated/cloud',role:'cloud',hostVersion:'0.2.1-rc.2'};let lose=true,puts=0;
 const remote=async(method,a)=>{assert(method.startsWith('gitee_'));if(a.targetHash)assert.equal(a.targetHash,digest(target));const action=method.slice(6),q={slot:'gitee',operation:a.operation,expectedRevision:a.expectedRevision};if(action==='inspect'){const s=(await cloud.state.secrets()).slots.find(x=>x.slot==='gitee');return {target,slot:'gitee',revision:s.revision,configured:s.configured,fencingSupported:true};}if(action==='put'){puts++;await cloud.state.put({...q,secret:a.secret,confirm:true});if(lose)throw Error('LOST');}if(action==='fence')await cloud.state.fence({...q,confirm:true});const r=await cloud.state.secretReceipt(q);return {target,slot:'gitee',revision:r.revision,configured:r.configured,operationMatched:r.operationMatched,fencingSupported:true};};
 const deps={state:local.state,credentials:()=>local.credentials,remote,enabled:()=>true,service:'gitee'},h=createOnboardingHandoff(deps);await local.put('deepseek-cloud');await assert.rejects(h.preview({}),/SOURCE_REQUIRED/);await local.put('gitee-cloud');const p=await h.preview({}),confirm={id:p.id,fingerprint:p.fingerprint,confirm:true};assert.equal(p.destinationSlot,'gitee');assert.equal((await h.apply(confirm)).state,'needs_review');lose=false;const resumed=createOnboardingHandoff(deps);assert((await resumed.apply(confirm)).notResent);assert.equal((await resumed.status({refresh:true})).state,'delivered');assert.equal(puts,1);assert.equal((await cloud.state.readManagedSecret('deepseek-local')).value,null);assert.equal((await cloud.state.readManagedSecret('gitee')).value,secret);assert(!JSON.stringify([...local.credentials.records].filter(([k])=>k.includes('handoff'))).includes(secret));
 await cloud.state.fence({slot:'gitee',expectedRevision:1,operation:randomUUID(),confirm:true});await assert.rejects(cloud.state.put({slot:'gitee',expectedRevision:1,operation:randomUUID(),confirm:true,secret}),/SECRET_CONFLICT/);assert.equal((await cloud.state.readManagedSecret('gitee')).value,secret);
});
test('repository UI uses approved shared components, manual-only calls and separates model credential list',async()=>{const ui=(await fs.readFile(new URL('../ui-source/onboarding.generated.js',import.meta.url),'utf8')).replace(/\\u([a-f0-9]{4})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16)));for(const t of ['本端仓库只读核验','云端仓库只读核验','云端 Gitee 凭据交接','仓库核验身份','本次元数据读取通过'])assert(ui.includes(t));const source=await fs.readFile(new URL('../ui-source/onboarding/repository.jsx',import.meta.url),'utf8');assert(!source.includes('setInterval'));assert(source.includes('current.current===started'));assert(source.includes('setResult(null)'));const credentials=await fs.readFile(new URL('../ui-source/onboarding/credentials.jsx',import.meta.url),'utf8');assert(credentials.includes("!r.slot.startsWith('gitee')"));});


test('new repository controls opt into approved connection panel spacing, not a new style override',async()=>{const s=await fs.readFile(new URL('../ui-source/onboarding/repository.jsx',import.meta.url),'utf8');assert(s.includes('<Panel className="connection-panel"'));assert(s.includes("busy?'spinner':'git'"));assert(!s.includes('<style'));});

test('branch provider cannot coerce a JSON array into a commit hash',async()=>{
 const f=fixture(),get=f.runtime.repositoryFetch;
 f.runtime.repositoryFetch=async(u,o)=>u.includes('/branches/')?Response.json({name:'main',commit:{sha:[sha]}}):get(u,o);
 await assert.rejects(f.repo.inspect(args),/BRANCH_RESPONSE_INVALID/);
});
test('cloud read contract rejects non-string commit hashes even when coercion matches',async()=>{
 const f=fixture(),r=await f.repo.inspect(args);
 assert.throws(()=>repositoryCheckResult({...r,repository:{...r.repository,base_sha:[sha]}},args),/RESPONSE_REVIEW/);
});
test('missing default branch stops after metadata; explicit branch still reads without initializing repository',async()=>{
 for(const missing of [null,'',undefined]){
  const f=fixture(),get=f.runtime.repositoryFetch;
  f.runtime.repositoryFetch=async(u,o)=>{const r=await get(u,o);if(u.includes('/branches/'))return r;return Response.json({...await r.json(),default_branch:missing});};
  await assert.rejects(f.repo.inspect(args),e=>e.message==='ONBOARDING_REPOSITORY_DEFAULT_BRANCH_REQUIRED');
  assert.equal(f.calls.length,1);assert.equal(f.credentials.writes(),0);
  assert.equal((await f.repo.inspect({...args,branch:'main'})).repository.branch,'main');
 }
});
