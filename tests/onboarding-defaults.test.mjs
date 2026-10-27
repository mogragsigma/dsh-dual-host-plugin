import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {onboardingBoundary} from '../bundle/onboarding-boundary.js';
import {createOnboardingService} from '../bundle/onboarding-host.js';
import {defaults} from '../bundle/onboarding-schema.js';
async function fixture(t,external=false){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'s55-default-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const home=root+'/home';await fs.mkdir(home);const env={HOME:home,PATH:''};
 if(external){env.DSH_HOME=root+'/external-dsh';env.DSH_AGENTS_HOME=root+'/external-agents';}
 const rows=new Map([['other/keep',{kind:'api-key',key:'SYNTHETIC_OTHER'}]]);let writes=0,network=0;
 const credentials={readRecord:async k=>structuredClone(rows.get(k)),describeRecord:async()=>({writable:true}),modifyRecord:async(k,fn)=>{const v=fn(structuredClone(rows.get(k)));if(v!==undefined){rows.set(k,structuredClone(v));writes++;}}};
 const runtime={home,env,credentials,ssh:{scan:async()=>{network++;throw Error('NO_NETWORK');},execute:async()=>{network++;throw Error('NO_NETWORK');}}};
 const service=createOnboardingService({}, {},runtime);
 return {root,home,env,runtime,service,rows,get writes(){return writes;},get network(){return network;},dsh:env.DSH_HOME??home+'/.dsh',agents:env.DSH_AGENTS_HOME??home+'/.agents'};
}
test('empty plugin config exposes gated setup without flags, provider discovery is read-only',async t=>{
 const f=await fixture(t),d=await f.service.call('describe',{});
 for(const k of ['draftPersistence','credentialStorage','rulesInstall','remoteDetection','sourcePreparation','nativeHostInstallation'])assert.equal(d.capabilities[k],true,k);
 assert.equal(d.consent,'per_action_explicit');assert.equal(d.configured,false);assert(!d.capabilities.initialization&&!d.capabilities.write);
 assert.equal((await f.service.call('draft_load',{})).revision,0);await f.service.call('secret_status',{});assert(!(await f.service.call('ssh_status',{})).configured);
 assert.equal((await f.service.call('cloud_operation_status',{refresh:false})).state,'not_started');
 assert.equal(f.writes,0);assert.equal(f.network,0);assert.deepEqual(await fs.readdir(f.home),[]);
});
test('default setup persists explicit draft, but never credentials or approvals in it',async t=>{
 const f=await fixture(t),args={expectedRevision:0,operation:randomUUID(),content:{draft:defaults(),page:0,handled:[],skipped:[]}};
 const saved=await f.service.call('draft_save',args);assert.equal(saved.revision,1);
 const reboot=createOnboardingService({}, {},f.runtime);assert.deepEqual(await reboot.call('draft_load',{}),saved);assert.equal(saved.notAuthorization,true);
 assert.equal(f.writes,1);assert.equal(f.network,0);assert.deepEqual(f.rows.get('other/keep'),{kind:'api-key',key:'SYNTHETIC_OTHER'});
});
for(const external of [false,true])test('default rules protected append and fresh skill install '+(external?'environment roots outside HOME':'platform home defaults'),async t=>{
 const f=await fixture(t,external);await fs.mkdir(f.agents);const bytes=Buffer.from('\ufeff# USER\r\nKEEP_MY_RULES\r\n');await fs.writeFile(f.agents+'/AGENTS.md',bytes,{mode:0o640});
 const p=await f.service.call('install_preview',{});assert(p.canApply);assert.equal(p.target,f.agents+'/AGENTS.md');assert.equal(p.scope,'current_host_global_rules_and_skills_only');assert.equal(p.changes.length,20);
 assert.deepEqual(await fs.readdir(f.agents),['AGENTS.md']);await assert.rejects(f.service.call('install_apply',{id:p.id,fingerprint:p.fingerprint,confirm:false}),/INVALID_ARGUMENTS/);
 assert((await fs.readFile(p.target)).equals(bytes));const r=await f.service.call('install_apply',{id:p.id,fingerprint:p.fingerprint,confirm:true});assert.equal(r.state,'committed');
 assert((await fs.readFile(p.target)).subarray(0,bytes.length).equals(bytes));assert.equal((await fs.stat(p.target)).mode&0o777,0o640);
 assert.equal((await fs.readdir(f.dsh+'/skills')).length,19);assert.equal((await f.service.call('install_preview',{})).alreadyInstalled,true);
 assert.equal(f.network,0);assert(!r.initialization&&!r.activationVerified);
});
test('default apply failure rolls back user bytes and only owned directories',async t=>{
 const f=await fixture(t,true);await fs.mkdir(f.agents);await fs.writeFile(f.agents+'/AGENTS.md','KEEP');
 f.runtime.afterWrite=()=>{throw Error('INJECTED');};const s=createOnboardingService({}, {},f.runtime),p=await s.call('install_preview',{});
 assert.equal((await s.call('install_apply',{id:p.id,fingerprint:p.fingerprint,confirm:true})).state,'rolled_back');assert.equal(await fs.readFile(p.target,'utf8'),'KEEP');
 assert.deepEqual(await fs.readdir(f.agents),['AGENTS.md']);
});
test('invalid and unapproved cloud writes denied even though capability available',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.service.call('cloud_stage',{}),/CONFIRMATION|ARGUMENTS/);
 await assert.rejects(f.service.call('cloud_runtime',{action:'runtime_start',confirm:false}),/CONFIRMATION|ARGUMENTS|OPERATION/);
 await assert.rejects(f.service.call('ssh_trust',{confirm:false}),/ARGUMENTS/);
 assert.equal(f.network,0);assert.equal(f.writes,0);
});
for(const kind of ['persistence','installation','cloud'])test('explicit disable remains effective: '+kind,async t=>{
 const f=await fixture(t),s=createOnboardingService({}, {onboarding:{[kind]:{enabled:false}}},f.runtime),d=await s.call('describe',{});
 assert.equal(d.capabilities[kind==='persistence'?'draftPersistence':kind==='installation'?'rulesInstall':'remoteDetection'],false);
 assert.equal(f.writes,0);assert.equal(f.network,0);
});
for(const flag of ['preparation','runtime'])test('cloud stage disable remains effective: '+flag,async t=>{
 const f=await fixture(t),d=await createOnboardingService({}, {onboarding:{cloud:{[flag]:false}}},f.runtime).call('describe',{});
 assert.equal(d.capabilities.nativeHostInstallation,false);if(flag==='preparation')assert.equal(d.capabilities.sourcePreparation,false);
});
for(const platform of ['darwin','linux','win32'])test('default boundary follows host OS without baked-in user paths: '+platform,()=>{
 const home=platform==='win32'?'C:\\Users\\Fixture':'/home/fixture';const p=onboardingBoundary({}, {home,platform,env:{}},'installation');
 assert.equal(p.isolated,false);assert(p.roots.every(x=>x.startsWith(home)));assert(p.roots.every(x=>x===home||x.startsWith(home+(platform==='win32'?path.win32.sep:path.posix.sep))));
});
test('legacy isolation constraints cannot silently fall back to default mode',()=>{
 for(const [config,env] of [[{}, {DSH_ONBOARDING_ISOLATED_ROOT:'/isolated'}],[{onboarding:{persistence:{isolatedRoot:'/isolated'}}},{}],[{onboarding:{persistence:{isolatedRoot:'/isolated'}}},{DSH_ONBOARDING_ISOLATED_ROOT:'/other'}]])assert.throws(()=>onboardingBoundary(config,{home:'/isolated/home',env},'persistence'),/DISABLED/);
});
for(const env of [{DSH_HOME:'/'},{DSH_HOME:'/home/user'},{DSH_HOME:'/outside',DSH_AGENTS_HOME:'/outside/child'},{DSH_HOME:'/same',DSH_AGENTS_HOME:'/same'}])test('invalid default root never broadens managed write boundary '+JSON.stringify(env),()=>{
 assert.throws(()=>onboardingBoundary({}, {home:'/home/user',env},'installation'),/DISABLED/);
});
test('missing parent outside selected root is not implicitly created',async t=>{
 const f=await fixture(t);f.env.DSH_AGENTS_HOME=f.root+'/missing/deep/agents';await assert.rejects(f.service.call('install_preview',{}),/INSTALL_PARENT_REVIEW/);
 assert.deepEqual(await fs.readdir(f.root),['home']);
});

test('format validation exposes storage secret heuristic before Continue, does not falsely promise save',async()=>{
 const {validateDraft}=await import('../bundle/onboarding-schema.js');
 const r=validateDraft({...defaults(),deepseekReference:'s55-unconfigured-model-reference',model:'ds flash'});
 assert.equal(r.pageValid[1],false);assert(r.errors.some(x=>x.field==='deepseekReference'&&x.message.includes('过长标识')));
 assert.equal(validateDraft({...defaults(),deepseekReference:'unconfigured-test-ref',model:'ds flash'}).pageValid[1],true);
});

test('candidate package, lock, compatibility and link version labels agree',async()=>{
 const dir=new URL('../bundle/',import.meta.url),pkg=JSON.parse(await fs.readFile(new URL('package.json',dir))),lock=JSON.parse(await fs.readFile(new URL('package-lock.json',dir))),compat=JSON.parse(await fs.readFile(new URL('compatibility.json',dir))),link=await import('../bundle/link-contract.js');
 assert.equal(pkg.version,compat.version);assert.equal(pkg.version,lock.version);assert.equal(pkg.version,lock.packages[''].version);assert.equal(pkg.version,link.VERSION);
});
