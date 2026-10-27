import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash,createHmac} from 'node:crypto';
import {createRuntimeActivation} from '../bundle/onboarding-runtime-activation.js';
import {runtimeInventory} from '../bundle/onboarding-runtime-inventory.js';
import {observationServer} from './helpers/host-stop-fixture.mjs';
const hash=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'activation-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const q={root,operationId:randomUUID(),proof:'a'.repeat(64)},now=Date.now(),repair={id:randomUUID(),fingerprint:hash('repair'),updatedAt:now-2000,state:'committed'};
 const j={id:randomUUID(),revision:7,host:{pid:123,start:'current',boot:'own-test'},worker:null,child:null};
 const server=await observationServer(t,root,j),dir=path.join(root,'runtime/plugin');await fs.mkdir(dir,{recursive:true,mode:0o700});
 const entry=path.join(dir,'entry.js');await fs.writeFile(entry,'// own plugin',{mode:0o600});
 j.restart={id:randomUUID(),nonce:j.nativeNonce,nativeResumeAcknowledged:true,consentContract:1,createdAt:now-1000,completedAt:now-500,host:j.host,state:'ready',launcher:null};
 const control=path.join(root,'.control/runtime/restarts',j.restart.id);await fs.mkdir(control,{recursive:true,mode:0o700});await fs.rename(server.access,path.join(control,'native-access.json'));
 Object.assign(j.nativeReceipt,{hostVersion:'test-host',modelAttempts:0,modelAttemptScope:'inspection_agents_only',rows:['standard','ptc','cordis','minimal'].map(preset=>({preset,valid:true,catalogComplete:true,idle:true,globalRuleLoaded:preset!=='minimal',globalSkillPathsVerified:preset!=='minimal',globalSkillCount:preset==='minimal'?0:1,skillBodyLoaded:preset!=='minimal'}))});
 server.rows.install_status={id:randomUUID(),state:'committed',canRecover:false,review:[],files:[{path:path.join(root,'runtime/native-home/dsh/AGENTS.md')},{path:path.join(root,'runtime/native-home/dsh/skills/task-onboarding/SKILL.md')}]};
 const mac=(v,p)=>createHmac('sha256',p).update(JSON.stringify(v)).digest('hex'),signed=(v,p)=>({...v,signature:mac(v,p)});
 let current=j,writes=0;
 const api={fs,path,hash,fail:c=>{throw Error('ONBOARDING_CLOUD_'+c);},regular:async p=>{try{const s=await fs.lstat(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw Error('FILE_REVIEW');const data=await fs.readFile(p);return {data,sha256:hash(data),identity:{dev:s.dev,ino:s.ino,uid:s.uid,mode:s.mode&0o777}};}catch(e){if(e.code==='ENOENT')return null;throw e;}},signed,verified:(v,p)=>{const{signature,...body}=v;assert.equal(signature,mac(body,p));return body;},atomicJSON:async(p,v)=>{writes++;await fs.writeFile(p,JSON.stringify(v),{mode:0o600});},runtimeAlive:async p=>!!p&&hash(p)===hash(j.host),runtimeRecord:async()=>current,checkAncestors:async()=>{},runtimeSource:async()=>source};
 const source={owner:{manifest:[{path:'plugin/entry.js',mode:0o600,sha256:hash('// own plugin')}]}};
 const options={repair,source,inventory:await runtimeInventory(q),compat:{hostBaseline:'test-host',globalSkills:['task-onboarding']}};
 const make=()=>createRuntimeActivation(api,q,j,options);
 return {...server,root,q,j,repair,api,options,entry,make,file:path.join(root,'.control/runtime/plugin-activation.json'),get writes(){return writes;},setCurrent:v=>current=v};
}
test('activation requires a separate live check; subsequent status is historical and makes no RPC',async t=>{
 const f=await fixture(t);assert.equal((await f.make().status()).activationVerified,false);assert.equal(f.calls.length,0);
 const v=await f.make().verify(f.repair.id);assert(v.activationVerified&&!v.cached&&!v.liveStateVerified);assert.equal(f.writes,1);assert(f.calls.includes('install_status'));
 const count=f.calls.length,cached=await f.make().status();assert(cached.cached&&!cached.activationVerified&&cached.sameRecordedHost&&cached.sameRecordedRepair);assert.equal(f.calls.length,count);
 assert(!JSON.stringify(cached).includes('isolated-test-only'));assert(!JSON.stringify(cached).includes(f.q.proof));
});
test('missing post-repair restart cannot use an earlier successful Host receipt',async t=>{const f=await fixture(t);f.j.restart.createdAt=f.repair.updatedAt-1;await assert.rejects(f.make().verify(f.repair.id),/RESTART_REQUIRED/);assert.equal(f.writes,0);assert.equal(f.calls.length,0);});
for(const fault of ['unconfirmed','wrong_nonce','wrong_host','missing_completed','probe_invalid','minimal_changed','catalog_partial'])test('activation rejects '+fault,async t=>{
 const f=await fixture(t);if(fault==='unconfirmed')f.j.restart.nativeResumeAcknowledged=false;if(fault==='wrong_nonce')f.j.restart.nonce=randomUUID();if(fault==='wrong_host')f.j.restart.host={pid:456};if(fault==='missing_completed')delete f.j.restart.completedAt;if(fault==='probe_invalid')f.j.nativeReceipt.rows[0].valid=false;if(fault==='minimal_changed')f.j.nativeReceipt.rows[3].globalSkillCount=1;if(fault==='catalog_partial')f.j.nativeReceipt.rows[0].catalogComplete=false;
 await assert.rejects(f.make().verify(f.repair.id),/RESTART_REQUIRED|ADMISSION_REVIEW/);assert.equal(f.writes,0);
});
for(const fault of ['extra','same_bytes_replaced','changed','symlink'])test('current owned tree rejects '+fault+' without adopting it',async t=>{
 const f=await fixture(t);if(fault==='extra')await fs.writeFile(path.join(f.root,'runtime/plugin/user.txt'),'KEEP');if(fault==='same_bytes_replaced'){await fs.rename(f.entry,f.entry+'.backup');await fs.writeFile(f.entry,'// own plugin',{mode:0o600});await fs.rename(f.entry+'.backup',path.join(f.root,'KEEP'));}if(fault==='changed')await fs.appendFile(f.entry,'changed');if(fault==='symlink'){await fs.rename(f.entry,path.join(f.root,'KEEP'));await fs.symlink(path.join(f.root,'KEEP'),f.entry);}
 await assert.rejects(f.make().verify(f.repair.id),/OWNERSHIP_REVIEW|FILE_REVIEW/);assert.equal(f.writes,0);
});
test('installation changes fail separately; old successful diagnostic remains intact',async t=>{const f=await fixture(t);await f.make().verify(f.repair.id);const before=await fs.readFile(f.file);f.rows.install_status.state='needs_review';await assert.rejects(f.make().verify(f.repair.id),/INSTALLATION_REVIEW/);assert.deepEqual(await fs.readFile(f.file),before);});
test('an empty wrong global-rule path is not an installation proof',async t=>{const f=await fixture(t);f.rows.install_status.files=[];await assert.rejects(f.make().verify(f.repair.id),/INSTALLATION_REVIEW/);assert.equal(f.writes,0);});
test('a process/journal replacement during public observation cannot produce a receipt',async t=>{const f=await fixture(t);const base=f.api.runtimeRecord;let n=0;f.api.runtimeRecord=async()=>++n===1?base():{...f.j,revision:8};await assert.rejects(f.make().verify(f.repair.id),/HOST_CHANGED/);assert.equal(f.writes,0);});
test('busy native agents are not interrupted or required to be idle for read-only verification',async t=>{const f=await fixture(t);f.rows.agent_hold_status.counts.running=1;assert((await f.make().verify(f.repair.id)).activationVerified);assert(f.calls.every(c=>c.endsWith('_status')));});
test('failed auth or unexpected response does not create activation receipt',async t=>{const f=await fixture(t);f.settings.auth=false;await assert.rejects(f.make().verify(f.repair.id),/AUTH_FAILED/);assert.equal(f.writes,0);});
test('history after a later Host/repair is explicitly stale, never live proof',async t=>{const f=await fixture(t);await f.make().verify(f.repair.id);f.j.host={pid:789};f.repair.updatedAt++;const v=await f.make().status();assert(!v.sameRecordedHost&&!v.sameRecordedRepair&&!v.activationVerified);});
test('unknown or noncommitted repair cannot activate',async t=>{const f=await fixture(t);await assert.rejects(f.make().verify(randomUUID()),/REPAIR_CHANGED/);f.repair.state='needs_review';await assert.rejects(f.make().verify(f.repair.id),/RESTART_REQUIRED/);assert.equal(f.writes,0);});
test('damaged diagnostic ledger is preserved, not silently replaced',async t=>{const f=await fixture(t);await fs.writeFile(f.file,'{"unexpected":true}',{mode:0o600});await assert.rejects(f.make().verify(f.repair.id));assert.equal(await fs.readFile(f.file,'utf8'),'{"unexpected":true}');assert.equal(f.writes,0);});

async function versioned(t){
 const f=await fixture(t);let artifactsReady=true,artifactChecks=0;
 const context={version:'2.0.0',transactionId:randomUUID(),imageHash:hash('signed-effective-version'),artifactsReady:async()=>{artifactChecks++;return artifactsReady;}};
 f.options.versionContext=context;f.j.nativeReceipt.pluginVersion=context.version;f.rows.describe={pluginVersion:context.version};
 const prior=f.rows.install_status;f.rows.install_status={contract:2,action:'inspect',state:'inspected',installationId:prior.id,installedVersion:context.version,targetVersion:context.version,planReady:true,canApply:false,conflicts:[],changes:[],files:prior.files.map(x=>({...x,state:'unchanged'})),lastReceipt:{id:prior.id,state:'committed',canRecover:false,review:[],version:context.version}};
 return {...f,context,versionFile:path.join(f.root,'.control/runtime/plugin-version-activation.json'),setArtifacts:x=>artifactsReady=x,checks:()=>artifactChecks};
}
test('history repair activation binds actual live module, signed image and paired maintained rules',async t=>{
 const f=await versioned(t),r=await f.make().verify(f.repair.id);assert(r.activationVerified&&r.sameRecordedRelease&&!r.cached);assert.equal(r.pluginVersion,'2.0.0');assert(f.calls.includes('describe'));assert.equal(f.checks(),2);
 const ledger=JSON.parse(await fs.readFile(f.versionFile));assert.equal(ledger.schema,2);assert.equal(ledger.records[0].imageHash,f.context.imageHash);assert.equal(ledger.records[0].versionTransactionId,f.context.transactionId);
 const calls=f.calls.length,status=await f.make().status();assert(!status.activationVerified&&status.cached&&status.sameRecordedRepair&&status.sameRecordedRelease);assert.equal(calls,f.calls.length);await assert.rejects(fs.stat(f.file),{code:'ENOENT'});
});
for(const fault of ['startup_version','live_version','missing_live_version','unpaired','wrong_installed_version','wrong_target_version','unknown_file','missing_path','pending_changes','conflict','wrong_receipt_id','recoverable_receipt','changed_rule'])test('version-aware activation rejects '+fault,async t=>{
 const f=await versioned(t),s=f.rows.install_status;
 if(fault==='startup_version')f.j.nativeReceipt.pluginVersion='1.0.0';if(fault==='live_version')f.rows.describe.pluginVersion='1.0.0';if(fault==='missing_live_version')delete f.rows.describe.pluginVersion;if(fault==='unpaired')f.setArtifacts(false);
 if(fault==='wrong_installed_version')s.installedVersion='1.0.0';if(fault==='wrong_target_version')s.targetVersion='1.0.0';if(fault==='unknown_file')s.files.push({path:'/elsewhere',state:'unchanged'});if(fault==='missing_path')s.files.pop();if(fault==='pending_changes')s.changes.push({path:'unknown'});if(fault==='conflict')s.conflicts.push({reason:'changed'});if(fault==='wrong_receipt_id')s.lastReceipt.id=randomUUID();if(fault==='recoverable_receipt')s.lastReceipt.canRecover=true;if(fault==='changed_rule')s.files[0].state='changed';
 await assert.rejects(f.make().verify(f.repair.id),/VERSION_REVIEW|ARTIFACTS_REVIEW|INSTALLATION_REVIEW/);await assert.rejects(fs.stat(f.versionFile),{code:'ENOENT'});
});
test('version diagnostic never converts old receipt to current proof after image or epoch changes',async t=>{
 const f=await versioned(t);await f.make().verify(f.repair.id);f.context.imageHash=hash('other signed image');let r=await f.make().status();assert(!r.sameRecordedRelease&&!r.sameRecordedRepair&&!r.activationVerified);
 f.context.transactionId=randomUUID();r=await f.make().status();assert(!r.sameRecordedRelease&&!r.sameRecordedRepair);
});
test('pairing changes during live observation cannot replace prior success',async t=>{
 const f=await versioned(t);await f.make().verify(f.repair.id);const before=await fs.readFile(f.versionFile);let n=0;f.context.artifactsReady=async()=>++n===1;
 await assert.rejects(f.make().verify(f.repair.id),/ARTIFACTS_REVIEW/);assert.deepEqual(await fs.readFile(f.versionFile),before);
});
test('rollback-to-initial repair may use original install receipt only after signed pairing proof',async t=>{
 const f=await versioned(t),s=f.rows.install_status;f.rows.install_status={id:s.installationId,state:'committed',canRecover:false,review:[],files:s.files};
 assert((await f.make().verify(f.repair.id)).activationVerified);
});

async function normalVersion(t){
 const f=await versioned(t);delete f.options.repair;let current=true;
 f.options.versionSubject={state:'committed',historyHash:hash('settled-version-history'),stillCurrent:async()=>current};
 return {...f,releaseFile:path.join(f.root,'.control/runtime/plugin-release-activation.json'),setCurrentVersion:v=>current=v};
}
test('normal upgrade has independent activation without manufacturing a repair',async t=>{
 const f=await normalVersion(t);const r=await f.make().verify(f.context.transactionId);
 assert.equal(r.scope,'maintained_plugin_version_observed');assert(r.activationVerified&&r.versionMaintenance&&r.sameRecordedRelease);assert(!Object.hasOwn(r,'repairId'));
 const d=JSON.parse(await fs.readFile(f.releaseFile));assert.equal(d.schema,3);assert.equal(d.records[0].historyHash,f.options.versionSubject.historyHash);assert(!Object.hasOwn(d.records[0],'repairId'));
 await assert.rejects(fs.stat(f.versionFile),{code:'ENOENT'});await assert.rejects(fs.stat(f.file),{code:'ENOENT'});
 const calls=f.calls.length,cached=await f.make().status();assert(cached.cached&&!cached.activationVerified&&cached.sameRecordedRelease);assert.equal(calls,f.calls.length);
});
test('normal rollback observes restored version but never promotes a prior diagnostic',async t=>{const f=await normalVersion(t);await f.make().verify(f.context.transactionId);f.options.versionSubject.state='rolled_back';f.options.versionSubject.historyHash=hash('rolled-back');assert(!(await f.make().status()).sameRecordedRelease);assert.equal((await f.make().verify(f.context.transactionId)).transactionState,'rolled_back');assert.equal(JSON.parse(await fs.readFile(f.releaseFile)).records.length,2);});
for(const fault of ['wrong_transaction','no_restart','unconfirmed_restart','startup_version','live_version','unpaired','image_drift','history_changed','late_history_change','launch_pending'])test('normal version observation refuses '+fault,async t=>{
 const f=await normalVersion(t);let id=f.context.transactionId;
 if(fault==='wrong_transaction')id=randomUUID();if(fault==='no_restart')delete f.j.restart;if(fault==='unconfirmed_restart')f.j.restart.nativeResumeAcknowledged=false;if(fault==='startup_version')f.j.nativeReceipt.pluginVersion='1.0.0';if(fault==='live_version')f.rows.describe.pluginVersion='1.0.0';if(fault==='unpaired')f.setArtifacts(false);if(fault==='image_drift')await fs.appendFile(f.entry,'unexpected');if(fault==='history_changed')f.setCurrentVersion(false);if(fault==='late_history_change'){let n=0;f.options.versionSubject.stillCurrent=async()=>++n===1;}if(fault==='launch_pending')f.j.worker=f.j.host;
 await assert.rejects(f.make().verify(id),/ONBOARDING_CLOUD_RUNTIME_ACTIVATION_/);await assert.rejects(fs.stat(f.releaseFile),{code:'ENOENT'});
});
test('normal diagnostic remains historical after next image or host, and preserves its ledger on failure',async t=>{const f=await normalVersion(t);await f.make().verify(f.context.transactionId);const before=await fs.readFile(f.releaseFile);f.context.imageHash=hash('next-image');f.j.host={pid:789};const r=await f.make().status();assert(!r.sameRecordedRelease&&!r.sameRecordedHost&&!r.activationVerified);f.setCurrentVersion(false);await assert.rejects(f.make().verify(f.context.transactionId));assert.deepEqual(await fs.readFile(f.releaseFile),before);});
test('normal receipt does not accept a legacy repair ledger or invalid subject',async t=>{const f=await normalVersion(t);await fs.writeFile(f.releaseFile,JSON.stringify(f.api.signed({schema:2,operationId:f.q.operationId,runtimeId:f.j.id,records:[]},f.q.proof)),{mode:0o600});await assert.rejects(f.make().status(),/LEDGER_REVIEW/);f.options.repair=f.repair;assert.throws(()=>f.make(),/CONTRACT_REVIEW/);});
