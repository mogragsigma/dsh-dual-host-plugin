import {reclaimRecordKey} from '../bundle/onboarding-runtime-reclaim-client.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash,createHmac} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {RUNTIME_COMMAND_LIMIT,runtimeProgram,runtimeCommand} from '../bundle/onboarding-runtime-program.js';
import {remoteControl} from '../bundle/onboarding-remote-control.js';
import {runProcess} from '../bundle/onboarding-ssh.js';
import {renameExclusive} from '../bundle/onboarding-exclusive-rename.js';
import {createOnboardingInstaller} from '../bundle/onboarding-installer.js';
import {createCloudOperations} from '../bundle/onboarding-cloud-operation.js';
import {runtimeUninstallClient,uninstallRecordKey} from '../bundle/onboarding-runtime-uninstall-client.js';
import {runtimeArtifactsClient} from '../bundle/onboarding-runtime-artifacts-client.js';
import {runtimeRepairClient} from '../bundle/onboarding-runtime-repair-client.js';
import {runtimeVersionClient} from '../bundle/onboarding-runtime-version-client.js';
import {validateVersionCandidatePackage} from '../bundle/onboarding-version-candidate.js';
const hash=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
const controller=await fs.readFile(new URL('../bundle/onboarding-remote-control.js',import.meta.url),'utf8'),extension=await fs.readFile(new URL('../bundle/onboarding-runtime-extension.js',import.meta.url),'utf8');
const signed=(x,q)=>({...x,signature:createHmac('sha256',q.proof).update(JSON.stringify(x)).digest('hex')});
const file=(name,data)=>{const b=Buffer.from(typeof data==='string'?data:JSON.stringify(data));return {path:'plugin/'+name,bytes:b.length,sha256:hash(b),mode:0o600,data:b.toString('base64')};};
const mhash=files=>hash(files.map(({data,...x})=>x).sort((a,b)=>a.path<b.path?-1:1));
const reclaimOptions={uninstall:true,lifecycle:true,artifacts:true,reclaim:true};
async function reclaimable(t,options={}){
 const f=await fixture(t,{...reclaimOptions,...options}),p=await f.call('uninstall_preview',{});
 assert.equal((await f.call('uninstall_apply',{id:p.id,fingerprint:p.fingerprint,confirm:true})).state,'committed');
 return f;
}
const reclaimApproval=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true});

test('reclamation requires original capability and completed three-artifact removal',async t=>{
 const legacy=await fixture(t,{uninstall:true,lifecycle:true,artifacts:true});await assert.rejects(legacy.call('reclaim_preview',{}),/RECLAIM_UNSUPPORTED/);
 const f=await fixture(t,reclaimOptions);await assert.rejects(f.call('reclaim_preview',{}),/UNINSTALL_NOT_COMPLETED/);assert(await fs.stat(path.join(f.root,'runtime/DEPENDENCY_KEEP')));
});
test('reclamation preview never adopts changed user data and apply removes only owned runtime files',async t=>{
 const f=await reclaimable(t),keep=path.join(f.root,'runtime/workspace/USER_KEEP');await fs.appendFile(keep,' changed by user');
 await fs.appendFile(path.join(f.root,'runtime/native-home/dsh/AGENTS.md'),'USER ADDED AFTER UNINSTALL\n');
 await fs.writeFile(path.join(f.root,'runtime/native-home/USER_SECRET'),'synthetic credential sentinel',{mode:0o600});
 const p=await f.call('reclaim_preview',{});assert(p.files>=41&&p.irreversible&&p.userDataPreserved);assert(!p.removeRoots.some(n=>n.includes('native-home')||n.includes('workspace')));
 assert(await fs.stat(path.join(f.root,'runtime/DEPENDENCY_KEEP')));const u=await f.call('reclaim_apply',reclaimApproval(p));assert.equal(u.state,'committed');assert(u.managedRestartBlocked&&!u.userDataDeleted&&u.runtimeFilesRemoved);
 await assert.rejects(fs.stat(path.join(f.root,'runtime/owned-dependencies')),{code:'ENOENT'});await assert.rejects(fs.stat(path.join(f.root,'runtime/DEPENDENCY_KEEP')),{code:'ENOENT'});
 assert.equal(await fs.readFile(keep,'utf8'),'user outcome changed by user');assert.equal(await fs.readFile(path.join(f.root,'runtime/native-home/USER_SECRET'),'utf8'),'synthetic credential sentinel');
 assert.match(await fs.readFile(path.join(f.root,'runtime/native-home/dsh/AGENTS.md'),'utf8'),/USER ADDED AFTER UNINSTALL/);
 assert(await fs.stat(path.join(f.root,'.control/runtime/retired-plugin/package.json')));assert.equal(await fs.readFile(path.join(f.root,'.control/runtime/inventory.json'),'utf8'),f.inv);
 assert.equal((await f.normal('runtime_status')).state,'runtime_reclaimed');assert((await f.call('reclaim_apply',reclaimApproval(p))).notResent);
 for(const action of ['runtime_restart_preview','runtime_rollback','runtime_stop_preview'])await assert.rejects(f.normal(action),/RECLAIM_RESTART_BLOCKED/);
 for(const [action,args] of [['uninstall_preview',{}],['rules_preview',{}],['receive',f.upload]])await assert.rejects(f.call(action,args),/RECLAIM_RESTART_BLOCKED/);
});
for(const fault of ['extra','hash','replacement','hardlink','retained_symlink'])test('reclamation preserves drift before deletion: '+fault,async t=>{
 const f=await reclaimable(t),root=f.root,leaf=path.join(root,'runtime/DEPENDENCY_KEEP');
 if(fault==='extra')await fs.mkdir(path.join(root,'runtime/UNKNOWN'),{mode:0o700});
 if(fault==='hash')await fs.appendFile(leaf,'change');
 if(fault==='replacement'){await fs.rename(leaf,path.join(f.dir,'keep'));await fs.writeFile(leaf,'native dependency sentinel',{mode:0o600});}
 if(fault==='hardlink')await fs.link(leaf,path.join(f.dir,'external'));
 if(fault==='retained_symlink'){await fs.rename(path.join(root,'runtime/workspace'),path.join(f.dir,'workspace'));await fs.symlink(path.join(f.dir,'workspace'),path.join(root,'runtime/workspace'));}
 await assert.rejects(f.call('reclaim_preview',{}));assert(await fs.stat(leaf));await assert.rejects(fs.stat(path.join(root,'.control/runtime/runtime-reclaim.json')),{code:'ENOENT'});
});
test('reclamation rechecks changes after preview; false consent and extra paths cannot execute',async t=>{
 const f=await reclaimable(t),p=await f.call('reclaim_preview',{});
 await assert.rejects(f.call('reclaim_apply',{...reclaimApproval(p),confirm:false}),/CONFIRMATION/);
 await assert.rejects(f.call('reclaim_apply',{...reclaimApproval(p),path:'/tmp'}),/ARGUMENTS/);
 await fs.appendFile(path.join(f.root,'runtime/DEPENDENCY_KEEP'),'drift');await assert.rejects(f.call('reclaim_apply',reclaimApproval(p)),/DRIFT/);
 await assert.rejects(fs.stat(path.join(f.root,'.control/runtime/runtime-reclaim.json')),{code:'ENOENT'});
});
test('expired reclamation preview and replaced retained root reject without file removal',async t=>{
 let clock=100000;const f=await reclaimable(t,{reclaimNow:()=>clock}),p=await f.call('reclaim_preview',{});clock+=300001;
 await assert.rejects(f.call('reclaim_apply',reclaimApproval(p)),/PLAN_EXPIRED/);assert(await fs.stat(path.join(f.root,'runtime/DEPENDENCY_KEEP')));
});
for(const phase of ['intent_saved','batch_intent','item_removed','batch_recorded','committed'])test('reclamation '+phase+' loss is durable, duplicate apply inert, recovery separately confirmed',async t=>{
 let injected=false;const f=await reclaimable(t,{reclaimHook:async name=>{if(name===phase&&!injected){injected=true;throw Error('test loss');}}}),p=await f.call('reclaim_preview',{});
 await assert.rejects(f.call('reclaim_apply',reclaimApproval(p)),/test loss/);const before=await f.api.runtimeInventory(f.q);
 assert((await f.call('reclaim_apply',reclaimApproval(p))).notResent);assert.deepEqual(await f.api.runtimeInventory(f.q),before);
 const s=await f.call('reclaim_status',{});
 if(s.state==='committed'){assert(!s.recoveryRequired);return;}
 await assert.rejects(f.call('reclaim_preview',{}),/ALREADY_REQUESTED/);const rp=await f.call('reclaim_recoveryPreview',{});
 await assert.rejects(f.call('reclaim_recover',{...reclaimApproval(rp),confirm:false}),/CONFIRMATION/);
 assert.equal((await f.call('reclaim_recover',reclaimApproval(rp))).state,'committed');
 await assert.rejects(f.call('reclaim_recover',reclaimApproval(rp)),/RECOVERY_CHANGED/);
 assert.equal(await fs.readFile(path.join(f.root,'runtime/workspace/USER_KEEP'),'utf8'),'user outcome');
});
test('partial reclamation rejects unknown new contents and never enlarges its original manifest',async t=>{
 const f=await reclaimable(t,{reclaimHook:async name=>{if(name==='item_removed')throw Error('loss');}}),p=await f.call('reclaim_preview',{});await assert.rejects(f.call('reclaim_apply',reclaimApproval(p)),/loss/);
 await fs.writeFile(path.join(f.root,'runtime/UNKNOWN'),'keep',{mode:0o600});await assert.rejects(f.call('reclaim_recoveryPreview',{}),/DRIFT/);assert.equal(await fs.readFile(path.join(f.root,'runtime/UNKNOWN'),'utf8'),'keep');
});
test('corrupt reclamation ledger remains a hard lifecycle fence',async t=>{
 const f=await reclaimable(t),file=path.join(f.root,'.control/runtime/runtime-reclaim.json');await fs.writeFile(file,'{}',{mode:0o600});
 await assert.rejects(f.call('reclaim_status',{}),/LEDGER_REVIEW/);await assert.rejects(f.normal('runtime_restart_preview'),/LEDGER_REVIEW/);assert(await fs.stat(path.join(f.root,'runtime/DEPENDENCY_KEEP')));
});
test('reclamation preserves all version history after completed version and rules maintenance',async t=>{
 const f=await fixture(t,reclaimOptions);await f.call('receive',f.upload);const v=await f.call('preview',{id:f.upload.id});assert.equal((await f.call('apply',reclaimApproval(v))).state,'committed');
 const a=await f.call('rules_preview',{});assert.equal((await f.call('rules_apply',reclaimApproval(a))).state,'committed');
 const u=await f.call('uninstall_preview',{});assert.equal((await f.call('uninstall_apply',reclaimApproval(u))).state,'committed');
 const before=await fs.readdir(path.join(f.root,'.control/runtime/plugin-versions'));const p=await f.call('reclaim_preview',{});assert.equal((await f.call('reclaim_apply',reclaimApproval(p))).state,'committed');
 assert.deepEqual(await fs.readdir(path.join(f.root,'.control/runtime/plugin-versions')),before);assert(await fs.stat(path.join(f.root,'.control/runtime/retired-plugin/new-module.js')));
});
test('reclamation target CLI recovery survives a new Node process',{skip:process.platform!=='linux'},async t=>{
 const f=await reclaimable(t,{reclaimHook:async name=>{if(name==='item_removed')throw Error('lost process response');}}),p=await f.call('reclaim_preview',{});await assert.rejects(f.call('reclaim_apply',reclaimApproval(p)),/lost process response/);
 const script=path.join(f.dir,'reclaim-cli.mjs');await fs.writeFile(script,runtimeProgram(controller,extension)+'\nawait runtimeVersionCLI();');
 const invoke=async(name,args)=>JSON.parse(await runProcess(process.execPath,[script],{input:JSON.stringify({...f.q,action:'runtime_version',versionAction:name,args}),env:{HOME:f.dir,PATH:process.env.PATH}}));
 const s=await invoke('reclaim_status',{});assert(s.ok&&s.value.recoveryRequired);const rp=await invoke('reclaim_recoveryPreview',{});assert(rp.ok,rp.error);const r=await invoke('reclaim_recover',reclaimApproval(rp.value));assert(r.ok,r.error);assert.equal(r.value.state,'committed');
});
for(const [original,next] of [[true,undefined],[true,2],[false,2],[false,false]])test('reclamation contract rejects removal or unsupported revision: '+original+'/'+next,async t=>{
 const f=await fixture(t,{...reclaimOptions,reclaim:original}),u=structuredClone(f.upload),n=u.files.findIndex(x=>x.path==='plugin/compatibility.json'),c=JSON.parse(Buffer.from(u.files[n].data,'base64'));
 if(next===undefined){delete c.onboardingRuntimeReclamation;delete c.onboardingRuntimeReclamationRequests;}else c.onboardingRuntimeReclamation=next;u.files[n]=file('compatibility.json',c);u.manifestHash=mhash(u.files);
 await assert.rejects(f.call('receive',u),/RECLAMATION_UNSUPPORTED/);await assert.rejects(fs.stat(path.join(f.root,'.control/runtime/plugin-candidates')),{code:'ENOENT'});
});
test('new image cannot grant original archive reclamation authority',async t=>{
 const f=await fixture(t,{...reclaimOptions,reclaim:false}),u=structuredClone(f.upload),i=u.files.findIndex(x=>x.path==='plugin/compatibility.json'),c=JSON.parse(Buffer.from(u.files[i].data,'base64'));
 c.onboardingRuntimeReclamation=1;u.files[i]=file('compatibility.json',c);u.manifestHash=mhash(u.files);
 await f.call('receive',u);const v=await f.call('preview',{id:u.id});await f.call('apply',reclaimApproval(v));
 await assert.rejects(f.call('reclaim_preview',{}),/RECLAIM_UNSUPPORTED/);assert.equal(await fs.readFile(path.join(f.root,'.control/runtime/inventory.json'),'utf8'),f.inv);
});
test('reclamation rejects retained root replacement after preview without adopting equal content',async t=>{
 const f=await reclaimable(t),p=await f.call('reclaim_preview',{}),root=path.join(f.root,'runtime/workspace');
 await fs.rename(root,path.join(f.dir,'original-workspace'));await fs.mkdir(root,{mode:0o700});await fs.writeFile(path.join(root,'USER_KEEP'),'user outcome',{mode:0o600});
 await assert.rejects(f.call('reclaim_apply',reclaimApproval(p)),/RETAINED_ROOT_DRIFT/);assert(await fs.stat(path.join(f.root,'runtime/DEPENDENCY_KEEP')));
 await assert.rejects(fs.stat(path.join(f.root,'.control/runtime/runtime-reclaim.json')),{code:'ENOENT'});
});
test('missing reclamation plan is not absence of intent and cannot unlock restart',async t=>{
 const f=await reclaimable(t,{reclaimHook:async name=>{if(name==='intent_saved')throw Error('intent persisted');}}),p=await f.call('reclaim_preview',{});
 await assert.rejects(f.call('reclaim_apply',reclaimApproval(p)),/intent persisted/);await fs.rename(path.join(f.root,'.control/runtime/runtime-reclaim-plan.json'),path.join(f.dir,'original-plan'));
 await assert.rejects(f.call('reclaim_status',{}),/PLAN_REVIEW/);await assert.rejects(f.normal('runtime_restart_preview'),/PLAN_REVIEW/);assert(await fs.stat(path.join(f.root,'runtime/DEPENDENCY_KEEP')));
});
test('reclamation recovery still requires intact completed uninstall proof',async t=>{
 const f=await reclaimable(t,{reclaimHook:async name=>{if(name==='intent_saved')throw Error('pending');}}),p=await f.call('reclaim_preview',{});
 await assert.rejects(f.call('reclaim_apply',reclaimApproval(p)),/pending/);
 await fs.appendFile(path.join(f.root,'.control/runtime/retired-plugin/package.json'),'changed');
 await assert.rejects(f.call('reclaim_recoveryPreview',{}),/IMAGE_DRIFT/);assert(await fs.stat(path.join(f.root,'runtime/DEPENDENCY_KEEP')));
});
test('a newly observed active member blocks reclamation without stopping it',async t=>{
 const f=await reclaimable(t),p=await f.call('reclaim_preview',{});let calls=0;f.io.runtimeAlive=async()=>{calls++;return true;};
 await assert.rejects(f.call('reclaim_apply',reclaimApproval(p)),/PROCESS_ACTIVE/);assert.equal(calls,1);assert(await fs.stat(path.join(f.root,'runtime/DEPENDENCY_KEEP')));
 await assert.rejects(fs.stat(path.join(f.root,'.control/runtime/runtime-reclaim.json')),{code:'ENOENT'});
});
test('unsupported oversized runtime file is rejected before a deletion intent',async t=>{
 const f=await reclaimable(t),original=JSON.parse(f.inv);
 // Simulate an original signed inventory describing a file beyond the existing
 // bounded reader. Do not allocate a large file or raise its product limit.
 f.io.runtimeBaseInventory=async()=>({...original,items:original.items.map(x=>x.path==='runtime/DEPENDENCY_KEEP'?{...x,bytes:268435457}:x)});
 await assert.rejects(f.call('reclaim_preview',{}),/PLAN_REVIEW/);assert(await fs.stat(path.join(f.root,'runtime/DEPENDENCY_KEEP')));
 await assert.rejects(fs.stat(path.join(f.root,'.control/runtime/runtime-reclaim.json')),{code:'ENOENT'});
});
test('separate recovery approval may create missing intent, late original apply remains inert',async t=>{
 const f=await reclaimable(t),p=await f.call('reclaim_preview',{}),r=await f.call('reclaim_recoveryPreview',{});
 assert.equal(r.action,'start_original_manifest_if_still_unobserved');assert.equal(r.state,'unobserved');assert(await fs.stat(path.join(f.root,'runtime/DEPENDENCY_KEEP')));
 await assert.rejects(f.call('reclaim_recover',{...reclaimApproval(r),confirm:false}),/CONFIRMATION/);
 assert.equal((await f.call('reclaim_recover',reclaimApproval(r))).state,'committed');assert((await f.call('reclaim_apply',reclaimApproval(p))).notResent);
});
test('late original execution invalidates an unobserved-intent recovery preview',async t=>{
 const f=await reclaimable(t),p=await f.call('reclaim_preview',{}),r=await f.call('reclaim_recoveryPreview',{});await f.call('reclaim_apply',reclaimApproval(p));
 await assert.rejects(f.call('reclaim_recover',reclaimApproval(r)),/RECOVERY_CHANGED/);assert.equal((await f.call('reclaim_status',{})).state,'committed');
});
test('unobserved-intent recovery never refreshes deletion ownership after drift',async t=>{
 const f=await reclaimable(t);await f.call('reclaim_preview',{});const r=await f.call('reclaim_recoveryPreview',{});await fs.appendFile(path.join(f.root,'runtime/DEPENDENCY_KEEP'),'changed');
 await assert.rejects(f.call('reclaim_recover',reclaimApproval(r)),/DRIFT/);await assert.rejects(fs.stat(path.join(f.root,'.control/runtime/runtime-reclaim.json')),{code:'ENOENT'});
});
async function fixture(t,{legacy=false,lifecycle=false,historyRepair=false,historyActivation=false,versionActivation=false,uninstall=false,uninstallHook,hook,artifacts=false,artifactsHook,reclaim=false,reclaimWorker=false,reclaimFiles=40,reclaimHook,reclaimNow,retainFixture=false}={}){
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'runtime-version-')));if(!retainFixture)t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const module=path.join(dir,'controller.mjs');await fs.writeFile(module,runtimeProgram(controller,extension)+'\nexport {runtimeInventory,runtimeEffectiveInventory,runtimeVerifyPlugin};');const api=await import(pathToFileURL(module));
 const installationId=randomUUID(),parent=path.join(dir,'remote'),root=path.join(parent,'host-'+installationId);
 const baseline=JSON.parse(await runProcess(process.execPath,[fileURLToPath(new URL('../bundle/onboarding-remote-probe.js',import.meta.url))],{input:JSON.stringify({parent,installationId}),env:{PATH:process.env.PATH}}));
 const pkg={name:'@mogragsigma/dsh-dual-host-plugin',version:'1.0.0',type:'module',private:true,dependencies:{koffi:'3.1.1'},files:['*.js','compatibility.json','package-lock.json','runtime-package.json','runtime-lock.json','runtime-im-package.json','runtime-im-lock.json',...(artifacts?['global-rules','skills']:[])]};
 const files=[file('package.json',pkg),file('package-lock.json',{name:pkg.name,version:pkg.version,lockfileVersion:3,packages:{'':{name:pkg.name,version:pkg.version,dependencies:pkg.dependencies}}}),file('compatibility.json',{version:pkg.version,hostBaseline:'0.2.1-rc.2',onboardingPluginRepair:1,...(legacy?{}:{onboardingPluginVersion:1,onboardingPluginVersionRequests:1}),...(lifecycle?{onboardingPluginVersionLifecycle:1,onboardingNativePluginIdentity:1}:{}),...(historyRepair?{onboardingVersionRepair:1}:{}),...(historyActivation?{onboardingVersionRepairActivation:1}:{}),...(versionActivation?{onboardingVersionActivation:1}:{}),...(uninstall?{onboardingPluginUninstall:1,onboardingPluginUninstallRequests:1}:{}),...(reclaim?{onboardingRuntimeReclamation:1,onboardingRuntimeReclamationRequests:1}:{}),...(reclaimWorker?{onboardingRuntimeReclamationWorker:1}:{}),...(artifacts?{onboardingPluginVersionArtifacts:1,globalSkills:['task-onboarding'],workerSkill:'worker'}:{})})];
 for(const n of ['runtime-package.json','runtime-lock.json','runtime-im-package.json','runtime-im-lock.json'])files.push(file(n,{private:true,name:n}));
 for(const n of [...(uninstall?['onboarding-runtime-uninstall.js']:[]),...(reclaim?['onboarding-runtime-reclaim.js','onboarding-runtime-reclaim-worker.js']:[]),...(artifacts?['onboarding-runtime-artifacts.js','onboarding-maintenance.js','onboarding-maintenance-plan.js','onboarding-package-source.js','onboarding-boundary.js','onboarding-paths.js','onboarding-identity.js']:[]),'onboarding-remote-control.js','onboarding-runtime-extension.js','onboarding-runtime-version.js','onboarding-version-candidate.js','onboarding-plugin-version.js','onboarding-version-repair.js','onboarding-exclusive-rename.js','onboarding-runtime-inventory.js','onboarding-runtime-repair.js','onboarding-runtime-activation.js','onboarding-plugin-repair.js','onboarding-install-fs.js','onboarding-maintenance-fs.js','onboarding-runtime-stop.js','onboarding-host-stop-observation.js'])files.push(file(n,await fs.readFile(new URL('../bundle/'+n,import.meta.url),'utf8')));
 if(artifacts)files.push(file('global-rules/AGENTS.md','# __HOST_NAME__ · __HOST_ROLE__\nOriginal managed rule.\n'),file('skills/task-onboarding/SKILL.md','---\nname: task-onboarding\ndescription: 配置导览\n---\nOriginal skill.\n'));
 files.sort((a,b)=>a.path<b.path?-1:1);const q={root,installationId,operationId:randomUUID(),proof:'a'.repeat(64),planHash:hash('plan')};
 await remoteControl({...q,action:'prepare',baseline,files,manifestHash:mhash(files)});
 for(const name of ['runtime','.control/runtime','runtime/plugin','runtime/workspace','runtime/native-home'])await fs.mkdir(path.join(root,name),{mode:0o700});
 for(const f of files){const name=path.join(root,'runtime',f.path);await fs.mkdir(path.dirname(name),{recursive:true,mode:0o700});await fs.writeFile(name,Buffer.from(f.data,'base64'),{mode:0o600});}
 await fs.writeFile(path.join(root,'runtime/DEPENDENCY_KEEP'),'native dependency sentinel',{mode:0o600});await fs.writeFile(path.join(root,'runtime/workspace/USER_KEEP'),'user outcome',{mode:0o600});
 if(reclaim){await fs.mkdir(path.join(root,'runtime/owned-dependencies'),{mode:0o700});for(let i=0;i<reclaimFiles;i++)await fs.writeFile(path.join(root,'runtime/owned-dependencies',String(i).padStart(3,'0')+'.js'),'dependency '+i,{mode:0o600});}
 const j={schema:1,operationId:q.operationId,planHash:q.planHash,root,id:randomUUID(),fingerprint:hash('runtime'),revision:1,state:'host_ready',worker:null,child:null,host:null,nativeReceipt:{ok:true},workerHash:hash('worker')};
 if(artifacts){const home=path.join(root,'runtime/native-home'),dsh=path.join(home,'dsh'),agents=path.join(home,'agents');for(const p of [dsh,agents])await fs.mkdir(p,{mode:0o700});await fs.writeFile(path.join(dsh,'AGENTS.md'),'\ufeffUSER PREFIX\r\n',{mode:0o640});const svc=createOnboardingInstaller({onboarding:{role:'cloud',installation:{enabled:true,isolatedRoot:path.join(root,'runtime')}}},{source:path.join(root,'runtime/plugin'),home,env:{HOME:home,DSH_HOME:dsh,DSH_AGENTS_HOME:agents,DSH_ONBOARDING_ISOLATED_ROOT:path.join(root,'runtime')}}),p=await svc.preview(),r=await svc.apply({id:p.id,fingerprint:p.fingerprint,confirm:true});assert.equal(r.state,'committed');j.rules={transactionId:r.id};j.nativeReceipt={ok:true,dshHome:dsh,agentsHome:agents,workspace:path.join(root,'runtime/workspace')};}
 if(reclaimWorker){const worker=controller+'\n'+extension+'\nawait runtimeWorkerCLI();';j.workerHash=hash(worker);await fs.writeFile(path.join(root,'.control/runtime/worker.mjs'),worker,{mode:0o600});}
 const inv=JSON.stringify(signed({schema:1,operationId:q.operationId,runtimeId:j.id,items:await api.runtimeInventory(q)},q));j.inventoryHash=hash(inv);
 const save=()=>fs.writeFile(path.join(root,'.control/runtime/journal.json'),JSON.stringify(signed(j,q)),{mode:0o600});await fs.writeFile(path.join(root,'.control/runtime/inventory.json'),inv,{mode:0o600});await save();
 const io={lock:async(q,fn)=>fn(),versionMove:renameExclusive,versionHook:hook,artifactsHook,uninstallHook,reclaimHook,reclaimNow};
 const call=(name,args)=>api.runtimeVersionControl({...q,action:'runtime_version',versionAction:name,args},io);
 const next=files.map(f=>{if(artifacts&&f.path==='plugin/global-rules/AGENTS.md')return file(f.path.slice(7),'# __HOST_NAME__ · __HOST_ROLE__\nNew managed rule.\n');if(artifacts&&f.path==='plugin/skills/task-onboarding/SKILL.md')return file(f.path.slice(7),'---\nname: task-onboarding\ndescription: 配置导览\n---\nNew skill.\n');if(['plugin/package.json','plugin/package-lock.json','plugin/compatibility.json'].includes(f.path)){const p=JSON.parse(Buffer.from(f.data,'base64'));p.version='1.0.1';if(p.packages)p.packages[''].version='1.0.1';return file(f.path.slice(7),p);}return f;});next.push(file('new-module.js','// newly added'));next.sort((a,b)=>a.path<b.path?-1:1);
 const upload={id:randomUUID(),manifestHash:mhash(next),files:next,confirm:true};
 return {dir,root,q,j,api,call,files,upload,inv,save,io,normal:(action,args={})=>api.runtimeControl({...q,action,...args},io)};
}
test('runtime package channel and all normal commands remain below fixed SSH limit',()=>{const p=runtimeProgram(controller,extension);for(const entry of ['runtimeCLI','runtimeVersionCLI'])assert(Buffer.byteLength(runtimeCommand('/usr/local/bin/node',p,entry))<=RUNTIME_COMMAND_LIMIT);});
test('candidate receive is inert; switch and rollback use original signed runtime, not a refreshed inventory',async t=>{
 const f=await fixture(t),before=await f.api.runtimeInventory(f.q),r=await f.call('receive',f.upload);assert.equal(r.state,'ready');assert(!r.runtimeChanged&&!r.hostStarted);
 assert.deepEqual(await f.api.runtimeInventory(f.q),before);assert((await f.call('receive',f.upload)).notResent);
 const p=await f.call('preview',{id:f.upload.id});assert.equal(p.toVersion,'1.0.1');
 const a={id:p.id,fingerprint:p.fingerprint,confirm:true},v=await f.call('apply',a);assert.equal(v.state,'committed');assert(!v.activationVerified&&v.threeArtifactMaintenancePending);assert((await f.call('apply',a)).notResent);
 assert.equal(await fs.readFile(path.join(f.root,'.control/runtime/inventory.json'),'utf8'),f.inv);
 assert.deepEqual((await f.api.runtimeEffectiveInventory(f.q,f.j)).items,await f.api.runtimeInventory(f.q));
 const rp=await f.call('previewRollback',{id:p.id});assert.equal((await f.call('rollback',{id:p.id,planId:rp.id,fingerprint:rp.fingerprint,confirm:true})).state,'rolled_back');
 assert.deepEqual(await f.api.runtimeInventory(f.q),before);assert.deepEqual((await f.api.runtimeEffectiveInventory(f.q,f.j)).items,before);
});
test('original archive without capability cannot be taken over by newer caller',async t=>{const f=await fixture(t,{legacy:true});await assert.rejects(f.call('receive',f.upload),/VERSION_UNSUPPORTED/);await assert.rejects(fs.stat(path.join(f.root,'.control/runtime/plugin-candidates')),{code:'ENOENT'});});
for(const fault of ['hash','traversal','case_collision','file_directory','noncanonical_base64','dependency','runtime_lock','script','host','lock_version'])test('candidate preflight rejects '+fault+' before directory creation',async t=>{
 const f=await fixture(t),u=structuredClone(f.upload),replace=(name,fn)=>{const i=u.files.findIndex(x=>x.path==='plugin/'+name),p=JSON.parse(Buffer.from(u.files[i].data,'base64'));fn(p);u.files[i]=file(name,p);};
 if(fault==='traversal')u.files.push(file('../USER_KEEP','bad'));if(fault==='case_collision')u.files.push(file('PACKAGE.json','bad'));if(fault==='file_directory')u.files.push(file('new-module.js/child','bad'));
 if(fault==='noncanonical_base64')u.files[0].data+='\n';if(fault==='dependency')replace('package.json',p=>p.dependencies.koffi='9.0.0');if(fault==='runtime_lock')replace('runtime-lock.json',p=>p.changed=true);if(fault==='script')replace('package.json',p=>p.scripts={preinstall:'not allowed'});if(fault==='host')replace('compatibility.json',p=>p.hostBaseline='9.0.0');if(fault==='lock_version')replace('package-lock.json',p=>p.version='wrong');
 u.manifestHash=fault==='hash'?'b'.repeat(64):mhash(u.files);await assert.rejects(f.call('receive',u),/CANDIDATE_/);await assert.rejects(fs.stat(path.join(f.root,'.control/runtime/plugin-candidates')),{code:'ENOENT'});
});
test('runtime record change and unresolved stop prohibit receipt and writes',async t=>{
 const f=await fixture(t);f.j.state='restarting';await f.save();await assert.rejects(f.call('receive',f.upload),/PREFLIGHT_REFUSED/);
 f.j.state='host_ready';await f.save();await fs.writeFile(path.join(f.root,'.control/runtime/stop.json'),'{}',{mode:0o600});await assert.rejects(f.call('receive',f.upload),/PREFLIGHT_REFUSED/);
});
test('dependency drift is never adopted while mutable user outputs remain allowed',async t=>{const f=await fixture(t);await fs.appendFile(path.join(f.root,'runtime/workspace/USER_KEEP'),' changed');await fs.appendFile(path.join(f.root,'runtime/DEPENDENCY_KEEP'),' changed');await assert.rejects(f.call('receive',f.upload),/PREFLIGHT_REFUSED/);assert.match(await fs.readFile(path.join(f.root,'runtime/workspace/USER_KEEP'),'utf8'),/changed/);});
for(const fault of ['extra','replace_equal','symlink','hardlink','receipt'])test('ready candidate '+fault+' blocks selection without overwriting it',async t=>{
 const f=await fixture(t);await f.call('receive',f.upload);const dir=path.join(f.root,'.control/runtime/plugin-candidates',f.upload.id),p=path.join(dir,'plugin/new-module.js');
 if(fault==='extra')await fs.mkdir(path.join(dir,'plugin/unknown-empty'),{mode:0o700});if(fault==='replace_equal'){await fs.rename(p,p+'.old');await fs.writeFile(p,'// newly added',{mode:0o600});await fs.rename(p+'.old',path.join(f.dir,'KEEP'));}if(fault==='symlink'){await fs.rename(p,path.join(f.dir,'KEEP'));await fs.symlink(path.join(f.dir,'KEEP'),p);}if(fault==='hardlink')await fs.link(p,path.join(f.dir,'KEEP'));if(fault==='receipt')await fs.appendFile(path.join(dir,'receipt.json'),'bad');
 await assert.rejects(f.call('preview',{id:f.upload.id}));assert(await fs.lstat(p));assert.equal((await fs.readFile(path.join(f.root,'runtime/plugin/package.json'),'utf8')).includes('1.0.0'),true);
});
test('interrupted receiver cannot automatically resend; own partial files are retained',async t=>{
 const f=await fixture(t,{hook:async phase=>{if(phase==='candidate_created')throw Error('injected loss');}});await assert.rejects(f.call('receive',f.upload),/injected loss/);
 const r=await f.call('candidate_status',{id:f.upload.id});assert.equal(r.state,'needs_review');assert(r.recoveryRequired);assert((await f.call('receive',f.upload)).notResent);await assert.rejects(f.call('preview',{id:f.upload.id}),/RECOVERY_REQUIRED/);
});
test('unknown empty directory during receiving is preserved, not sealed as own',async t=>{
 let f;f=await fixture(t,{hook:async phase=>{if(phase==='candidate_created')await fs.mkdir(path.join(f.root,'.control/runtime/plugin-candidates',f.upload.id,'plugin/FOREIGN'),{mode:0o700});}});await assert.rejects(f.call('receive',f.upload),/DRIFT/);assert.equal((await f.call('candidate_status',{id:f.upload.id})).state,'needs_review');
});
test('pending version blocks repair and effective ownership, recovery does not resend switch',async t=>{
 const f=await fixture(t,{hook:async phase=>{if(phase==='after_capture')throw Error('injected loss');}});await f.call('receive',f.upload);const p=await f.call('preview',{id:f.upload.id});assert.equal((await f.call('apply',{id:p.id,fingerprint:p.fingerprint,confirm:true})).state,'needs_review');
 await assert.rejects(f.normal('runtime_repair_preview'),/REPAIR_INTERLOCK/);await assert.rejects(f.api.runtimeEffectiveInventory(f.q,f.j),/RECOVERY_REQUIRED/);
 assert.equal((await f.call('recover',{id:p.id,confirm:true})).state,'rolled_back');assert((await f.call('status',{id:p.id})).historical);
});
test('candidate and version controls prohibit generic cleanup; no broad adoption/deletion',async t=>{const f=await fixture(t);await f.call('receive',f.upload);await assert.rejects(f.normal('runtime_rollback'),/VERSION_HISTORY_PRESERVED/);assert(await fs.stat(path.join(f.root,'runtime/workspace/USER_KEEP')));});
test('forged confirmation, unknown args and candidate ID reuse are rejected',async t=>{const f=await fixture(t);await assert.rejects(f.call('receive',{...f.upload,confirm:false}),/CONFIRMATION_REQUIRED/);await assert.rejects(f.call('preview',{id:f.upload.id,command:'anything'}),/ARGUMENTS/);await f.call('receive',f.upload);const next=structuredClone(f.upload);next.files.push(file('extra.js','different'));next.manifestHash=mhash(next.files);await assert.rejects(f.call('receive',next),/ID_REUSED/);});
test('real CLI can receive a bounded package then query it from another process without replay',{skip:process.platform!=='linux'},async t=>{
 const f=await fixture(t),script=path.join(f.dir,'version-cli.mjs');await fs.writeFile(script,runtimeProgram(controller,extension)+'\nawait runtimeVersionCLI();');
 const invoke=async(name,args)=>JSON.parse(await runProcess(process.execPath,[script],{input:JSON.stringify({...f.q,action:'runtime_version',versionAction:name,args}),env:{HOME:f.dir,PATH:process.env.PATH}}));
 const r=await invoke('receive',f.upload);assert(r.ok,r.error);assert.equal(r.value.state,'ready');const q=await invoke('candidate_status',{id:f.upload.id});assert(q.ok&&q.value.historical&&q.value.state==='ready');
});
test('live original Host rejects candidate writes without sending any signal',{skip:process.platform!=='linux'},async t=>{
 const f=await fixture(t),stat=await fs.readFile('/proc/'+process.pid+'/stat','utf8');f.j.host={pid:process.pid,platform:'linux',start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19],boot:(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim()};await f.save();await assert.rejects(f.call('receive',f.upload),/PREFLIGHT_REFUSED/);await assert.rejects(fs.stat(path.join(f.root,'.control/runtime/plugin-candidates')),{code:'ENOENT'});
});
test('new plugin image alone cannot restart before protected rules/Skills coordination',{skip:process.platform!=='linux'},async t=>{
 const f=await fixture(t);f.j.host={pid:999999999,platform:'linux',start:'0',boot:'ended-test'};f.j.defaultConfig={path:path.join(f.root,'runtime/native-home/dsh/profiles/web/cordis.patch.yml')};await f.save();
 await f.call('receive',f.upload);const p=await f.call('preview',{id:f.upload.id});assert.equal((await f.call('apply',{id:p.id,fingerprint:p.fingerprint,confirm:true})).state,'committed');await assert.rejects(f.normal('runtime_restart_preview'),/ARTIFACT_MAINTENANCE_REQUIRED/);
});
test('local client and original controller exchange actual package/files; lost apply is queried then separately rolled back',async t=>{
 const f=await fixture(t),source=path.join(f.dir,'candidate-source');await fs.mkdir(source,{mode:0o700});for(const x of f.upload.files)await fs.writeFile(path.join(source,x.path.slice(7)),Buffer.from(x.data,'base64'),{mode:0o600});
 const records=new Map(),credentials=()=>({readRecord:async k=>structuredClone(records.get(k)),modifyRecord:async(k,fn)=>records.set(k,structuredClone(fn(structuredClone(records.get(k)))))});
 const a={files:f.files,baseline:{node:{path:process.execPath}}},p={...f.q,id:f.q.operationId,archiveHash:hash(a),bindingFingerprint:hash('own-test-binding')},before=await f.api.runtimeInventory(f.q);let sends=0,dropApply=true;
 const options={p,a,b:{fixture:true},runtimeId:f.j.id,credentials,source,localState:path.join(f.dir,'local'),ssh:{execute:async(b,cmd,input)=>{sends++;const q=JSON.parse(input);const value=await f.api.runtimeVersionControl(q,f.io);if(q.versionAction==='apply'&&dropApply){dropApply=false;throw Error('lost after real file transaction');}return JSON.stringify({ok:true,value});}}};
 const call=(action,x={})=>runtimeVersionClient({...options,args:{action,operationId:p.id,...x}}),confirm=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true});
 const c=await call('candidate_preview');await call('receive',confirm(c));const plan=await call('preview',{candidateId:c.id});await assert.rejects(call('apply',confirm(plan)),/OUTCOME_UNKNOWN/);
 const sent=sends;assert((await call('apply',confirm(plan))).notResent);assert.equal(sends,sent);assert.equal((await call('status',{id:plan.id})).state,'committed');
 const rollback=await call('rollback_preview',{id:plan.id});assert.equal((await call('rollback',confirm(rollback))).state,'rolled_back');assert.deepEqual(await f.api.runtimeInventory(f.q),before);
 assert.equal(await fs.readFile(path.join(f.root,'.control/runtime/inventory.json'),'utf8'),f.inv);assert.equal((await call('record')).pending,false);
});
test('a failure before acquiring the original owner lock is explicitly no-effect',async t=>{const f=await fixture(t);await assert.rejects(f.api.runtimeVersionControl({...f.q,action:'runtime_version',versionAction:'receive',args:f.upload},{lock:async()=>{throw Error('lock busy');}}),/PREFLIGHT_REFUSED/);await assert.rejects(fs.stat(path.join(f.root,'.control/runtime/plugin-candidates')),{code:'ENOENT'});});

async function switched(t,options={}){
 const f=await fixture(t,{artifacts:true,...options});await f.call('receive',f.upload);const p=await f.call('preview',{id:f.upload.id});await f.call('apply',{id:p.id,fingerprint:p.fingerprint,confirm:true});
 return {...f,versionPlan:p,dsh:path.join(f.root,'runtime/native-home/dsh')};
}
const approve=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true});
const rulesLedger=f=>path.join(f.root,'.control/runtime/plugin-artifacts.json');
test('original runtime coordinates rules/Skills in actual native HOME, preserving user prefix and suffix',async t=>{
 const f=await switched(t),rule=path.join(f.dsh,'AGENTS.md');await fs.appendFile(rule,'USER LATER SUFFIX\r\n');
 const p=await f.call('rules_preview',{});assert(p.canApply,p.conflicts);assert.equal(p.targetVersion,'1.0.1');assert.equal(p.changes.length,2);assert(!JSON.stringify(p).includes('USER PREFIX'));
 const beforeInventory=await fs.readFile(path.join(f.root,'.control/runtime/inventory.json'));
 const r=await f.call('rules_apply',approve(p));assert.equal(r.state,'committed');assert(!r.hostStarted&&!r.activationVerified);assert((await f.call('rules_apply',approve(p))).notResent);
 const text=await fs.readFile(rule,'utf8');assert(text.startsWith('\ufeffUSER PREFIX\r\n'));assert(text.endsWith('USER LATER SUFFIX\r\n'));assert(text.includes('New managed rule.'));assert.equal((await fs.stat(rule)).mode&0o777,0o640);
 assert.match(await fs.readFile(path.join(f.dsh,'skills/task-onboarding/SKILL.md'),'utf8'),/New skill/);
 assert.deepEqual(await fs.readFile(path.join(f.root,'.control/runtime/inventory.json')),beforeInventory);
 assert((await f.call('rules_status',{id:p.id})).historical);assert((await f.call('rules_preview',{})).artifactsMatched);
});
test('image rollback requires a separately confirmed reverse rules update, not blind restoration of user text',async t=>{
 const f=await switched(t),p=await f.call('rules_preview',{});await f.call('rules_apply',approve(p));const rule=path.join(f.dsh,'AGENTS.md');await fs.appendFile(rule,'NEW USER TEXT');
 const back=await f.call('previewRollback',{id:f.versionPlan.id});await f.call('rollback',{id:f.versionPlan.id,planId:back.id,fingerprint:back.fingerprint,confirm:true});
 const rp=await f.call('rules_preview',{});assert.equal(rp.installedVersion,'1.0.1');assert.equal(rp.targetVersion,'1.0.0');assert(rp.canApply);await f.call('rules_apply',approve(rp));
 const s=await fs.readFile(rule,'utf8');assert(s.includes('Original managed rule.')&&s.endsWith('NEW USER TEXT'));assert((await f.call('rules_preview',{})).artifactsMatched);
});
for(const fault of ['owned_rule','skill','shared_skill','path','manifest','initial_journal'])test('rules coordinator refuses '+fault+' without adopting or overwriting',async t=>{
 const f=await switched(t),state=path.join(f.dsh,'dual-host-onboarding');
 if(fault==='owned_rule')await fs.appendFile(path.join(f.dsh,'AGENTS.md'),'<!-- dsh-dual-host:begin -->');
 if(fault==='skill')await fs.appendFile(path.join(f.dsh,'skills/task-onboarding/SKILL.md'),'USER EDIT');
 if(fault==='shared_skill')await fs.mkdir(path.join(f.root,'runtime/native-home/agents/skills/task-onboarding'),{recursive:true});
 if(fault==='path'){f.j.nativeReceipt.dshHome=f.dir;await f.save();}
 if(fault==='manifest')await fs.appendFile(path.join(state,'installed.json'),' ');
 if(fault==='initial_journal')await fs.appendFile(path.join(state,'transactions',f.j.rules.transactionId,'journal.json'),' ');
 try{const p=await f.call('rules_preview',{});assert.equal(p.canApply,false);assert(p.conflicts.length);}catch(e){assert.match(e.message,/ARTIFACTS_(PATH|OWNERSHIP)_REVIEW/);}
 await assert.rejects(fs.stat(rulesLedger(f)),{code:'ENOENT'});
});
test('rules confirmation and plan drift reject before intent or target mutation',async t=>{
 const f=await switched(t),p=await f.call('rules_preview',{});await assert.rejects(f.call('rules_apply',{...approve(p),confirm:false}),/CONFIRMATION_REQUIRED/);
 await fs.appendFile(path.join(f.dsh,'AGENTS.md'),'USER AFTER PREVIEW');await assert.rejects(f.call('rules_apply',approve(p)),/PLAN_DRIFT/);await assert.rejects(fs.stat(rulesLedger(f)),{code:'ENOENT'});
 await assert.rejects(f.call('rules_preview',{path:f.dir}),/ARGUMENTS/);
});
test('failed rules publication rolls back through original protective engine',async t=>{
 const f=await switched(t,{artifactsHook:async phase=>{if(phase==='after_capture')throw Error('controlled failure');}}),p=await f.call('rules_preview',{});
 const r=await f.call('rules_apply',approve(p));assert.equal(r.state,'rolled_back');assert.match(await fs.readFile(path.join(f.dsh,'AGENTS.md'),'utf8'),/Original managed rule/);
 const again=await f.call('rules_preview',{});assert(again.canApply);
});
test('lock created but absent inner journal stays needs-review, never blindly unlocked',async t=>{
 let lost=true;const f=await switched(t,{artifactsHook:async phase=>{if(phase==='after_lock'&&lost){lost=false;throw Error('loss before inner journal');}}}),p=await f.call('rules_preview',{});
 await assert.rejects(f.call('rules_apply',approve(p)),/loss before/);assert((await f.call('rules_apply',approve(p))).notResent);
 await assert.rejects(f.call('previewRollback',{id:f.versionPlan.id}),/ARTIFACTS_RECOVERY_REQUIRED/);
 await assert.rejects(f.call('rules_recoveryPreview',{id:p.id}),/JOURNAL_REVIEW/);
 assert(await fs.stat(path.join(f.dsh,'dual-host-onboarding/lock.json')));
});
test('rules request intent loss cannot be silently retried or erased by a later image rollback',async t=>{
 const f=await switched(t,{artifactsHook:async phase=>{if(phase==='intent_saved')throw Error('intent loss');}}),p=await f.call('rules_preview',{});
 await assert.rejects(f.call('rules_apply',approve(p)),/intent loss/);const r=await f.call('rules_apply',approve(p));assert(r.notResent&&r.recoveryRequired);
 await assert.rejects(f.call('rules_preview',{}),/ARTIFACTS_RECOVERY_REQUIRED/);await assert.rejects(f.call('previewRollback',{id:f.versionPlan.id}),/ARTIFACTS_RECOVERY_REQUIRED/);
 await assert.rejects(f.call('rules_status',{id:p.id}),/ARTIFACTS_JOURNAL_REVIEW/);
});
test('rules contract is explicit; older originals are not silently expanded',async t=>{const f=await fixture(t);await assert.rejects(f.call('rules_preview',{}),/ARTIFACTS_UNSUPPORTED/);});
test('committed maintenance lost outer receipt is queried once without replacing already published files',async t=>{
 const f=await switched(t,{artifactsHook:async phase=>{if(phase==='maintenance_returned')throw Error('lost outer receipt');}}),p=await f.call('rules_preview',{});
 await assert.rejects(f.call('rules_apply',approve(p)),/lost outer receipt/);const before=await fs.stat(path.join(f.dsh,'AGENTS.md'));
 assert((await f.call('rules_apply',approve(p))).notResent);assert.equal((await f.call('rules_status',{id:p.id})).state,'committed');
 assert.equal((await fs.stat(path.join(f.dsh,'AGENTS.md'))).ino,before.ino);assert((await f.call('rules_preview',{})).artifactsMatched);
});
for(const phase of ['after_capture','after_commit'])test('actual rules controller process exit '+phase+' is recovered through a fresh explicit plan',async t=>{
 const f=await switched(t),p=await f.call('rules_preview',{}),runner=path.join(f.dir,'crash-rules.mjs');
 await fs.writeFile(runner,`import {runtimeVersionControl} from ${JSON.stringify(pathToFileURL(path.join(f.dir,'controller.mjs')).href)};let raw='';for await(const c of process.stdin)raw+=c;await runtimeVersionControl(JSON.parse(raw),{lock:async(q,fn)=>fn(),artifactsHook:async phase=>{if(phase===${JSON.stringify(phase)})process.exit(73);}});`);
 const {spawn}=await import('node:child_process');const child=spawn(process.execPath,[runner],{env:{HOME:f.dir,PATH:process.env.PATH,TMPDIR:f.dir},stdio:['pipe','ignore','pipe']});let err='';child.stderr.on('data',b=>err+=b);
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});child.stdin.end(JSON.stringify({...f.q,action:'runtime_version',versionAction:'rules_apply',args:approve(p)}));assert.equal(await done,73,err);
 assert((await f.call('rules_apply',approve(p))).notResent);await assert.rejects(f.call('previewRollback',{id:f.versionPlan.id}),/ARTIFACTS_RECOVERY_REQUIRED/);
 const rp=await f.call('rules_recoveryPreview',{id:p.id});assert.notEqual(rp.id,p.id);await assert.rejects(f.call('rules_recover',{...approve(rp),fingerprint:p.fingerprint}),/PLAN_DRIFT/);
 const r=await f.call('rules_recover',approve(rp));assert.equal(r.state,phase==='after_commit'?'committed':'rolled_back');
 assert.equal((await f.call('rules_preview',{})).artifactsMatched??false,phase==='after_commit');
});
test('rules plans expire and a new preview never renews an old confirmation',async t=>{
 const f=await switched(t);let time=Date.now();f.io.versionNow=()=>time;const p=await f.call('rules_preview',{});time+=300001;
 await assert.rejects(f.call('rules_apply',approve(p)),/PLAN_DRIFT/);const next=await f.call('rules_preview',{});assert.notEqual(next.id,p.id);await assert.rejects(f.call('rules_apply',approve(p)),/PLAN_DRIFT/);assert.equal((await f.call('rules_apply',approve(next))).state,'committed');
});
test('matching rules lift only the artifact barrier, never grant restart or erase user configuration checks',{skip:process.platform!=='linux'},async t=>{
 const f=await switched(t);f.j.host={pid:999999999,platform:'linux',start:'0',boot:'ended-test'};f.j.defaultConfig={path:path.join(f.root,'runtime/native-home/dsh/profiles/web/cordis.patch.yml')};await f.save();
 await assert.rejects(f.normal('runtime_restart_preview'),/ARTIFACT_MAINTENANCE_REQUIRED/);const p=await f.call('rules_preview',{});await f.call('rules_apply',approve(p));
 // This synthetic fixture intentionally has no native profile. The independent
 // profile gate must still reject: readiness is not authority to start a Host.
 await assert.rejects(f.normal('runtime_restart_preview'),/RESTART_PROFILE_REVIEW/);
 const back=await f.call('previewRollback',{id:f.versionPlan.id});await f.call('rollback',{id:f.versionPlan.id,planId:back.id,fingerprint:back.fingerprint,confirm:true});await assert.rejects(f.normal('runtime_restart_preview'),/ARTIFACT_MAINTENANCE_REQUIRED/);
});
test('artifact receipts never grant ownership after metadata or source image drift',async t=>{
 const f=await switched(t),p=await f.call('rules_preview',{});await f.call('rules_apply',approve(p));await fs.appendFile(path.join(f.dsh,'dual-host-onboarding/installed.json'),' ');
 await assert.rejects(f.call('rules_preview',{}),/OWNERSHIP_REVIEW/);assert.equal((await f.call('rules_status',{id:p.id})).historical,true);
});
test('pending wrapper is bound to the exact inner maintenance plan and original metadata',async t=>{
 const f=await switched(t,{artifactsHook:async phase=>{if(phase==='maintenance_returned')throw Error('lost outer receipt');}}),p=await f.call('rules_preview',{});
 await assert.rejects(f.call('rules_apply',approve(p)),/lost outer receipt/);
 const records=JSON.parse(await fs.readFile(rulesLedger(f))),r=records.records.at(-1),file=path.join(f.dsh,'dual-host-onboarding/maintenance-transactions',r.maintenanceId,'journal.json'),j=JSON.parse(await fs.readFile(file));
 j.fingerprint='b'.repeat(64);await fs.writeFile(file,JSON.stringify(j));await assert.rejects(f.call('rules_status',{id:p.id}),/ARTIFACTS_JOURNAL_REVIEW/);
 assert.equal(JSON.parse(await fs.readFile(rulesLedger(f))).records.at(-1).state,'requested');
});

// Actual filesystem + original controller; SSH and native Host identity remain test seams.
test('rules client crosses original controller, loses reply after real update and queries without replay',async t=>{
 const f=await switched(t),records=new Map(),a={files:f.files,baseline:{node:{path:process.execPath}}};
 const p={...f.q,id:f.q.operationId,archiveHash:hash(a),bindingFingerprint:hash('artifacts-test-binding')};let sent=0,drop=true;
 const c={readRecord:async k=>structuredClone(records.get(k)),modifyRecord:async(k,fn)=>records.set(k,structuredClone(fn(structuredClone(records.get(k)))))};
 const options={p,a,b:{fixture:true},runtimeId:f.j.id,credentials:()=>c,ssh:{execute:async(b,cmd,input)=>{sent++;const q=JSON.parse(input),value=await f.api.runtimeVersionControl(q,f.io);if(q.versionAction==='rules_apply'&&drop){drop=false;throw Error('lost after actual protected update');}return JSON.stringify({ok:true,value});}}};
 const call=(action,args={})=>runtimeArtifactsClient({...options,args:{action,operationId:p.id,...args}}),plan=await call('rules_preview');
 await assert.rejects(call('rules_apply',approve(plan)),/OUTCOME_UNKNOWN/);const before=await fs.stat(path.join(f.dsh,'AGENTS.md')),n=sent;
 assert((await call('rules_apply',approve(plan))).notResent);assert.equal(sent,n);assert((await call('rules_record')).pending);
 assert.equal((await call('rules_status',{id:plan.id})).state,'committed');assert(!(await call('rules_record')).pending);assert.equal((await fs.stat(path.join(f.dsh,'AGENTS.md'))).ino,before.ino);
 assert((await call('rules_preview')).artifactsMatched);assert.match(await fs.readFile(path.join(f.dsh,'AGENTS.md'),'utf8'),/New managed rule/);assert.equal(await fs.readFile(path.join(f.root,'.control/runtime/inventory.json'),'utf8'),f.inv);
});

test('current lifecycle verifies signed switched image and rollback without rewriting original ownership',async t=>{const f=await fixture(t,{lifecycle:true});await f.api.runtimeVerifyPlugin(f.q,f.j);await f.call('receive',f.upload);const p=await f.call('preview',{id:f.upload.id});await f.call('apply',approve(p));await f.api.runtimeVerifyPlugin(f.q,f.j);await fs.writeFile(path.join(f.root,'runtime/plugin/unknown'),'unowned');await assert.rejects(f.api.runtimeVerifyPlugin(f.q,f.j));await fs.unlink(path.join(f.root,'runtime/plugin/unknown'));const rp=await f.call('previewRollback',{id:p.id});await f.call('rollback',{id:p.id,planId:rp.id,fingerprint:rp.fingerprint,confirm:true});await f.api.runtimeVerifyPlugin(f.q,f.j);assert.equal(await fs.readFile(path.join(f.root,'.control/runtime/inventory.json'),'utf8'),f.inv);});
for(const base of [false,true])test('candidate lifecycle capability cannot silently change original controller contract: '+base,async t=>{const f=await fixture(t,{lifecycle:base}),u=structuredClone(f.upload),i=u.files.findIndex(x=>x.path==='plugin/compatibility.json'),c=JSON.parse(Buffer.from(u.files[i].data,'base64'));if(base)delete c.onboardingNativePluginIdentity;else {c.onboardingPluginVersionLifecycle=1;c.onboardingNativePluginIdentity=1;}u.files[i]=file('compatibility.json',c);u.manifestHash=mhash(u.files);await assert.rejects(f.call('receive',u),/LIFECYCLE_UNSUPPORTED/);await assert.rejects(fs.stat(path.join(f.root,'.control/runtime/plugin-candidates')),{code:'ENOENT'});});

test('public repair route follows current signed version and leaves original ownership ledger unchanged',async t=>{
 const f=await fixture(t,{lifecycle:true,historyRepair:true});await f.call('receive',f.upload);const v=await f.call('preview',{id:f.upload.id});await f.call('apply',approve(v));
 const name=path.join(f.root,'runtime/plugin/new-module.js');await fs.writeFile(name,'DAMAGED');
 const p=await f.normal('runtime_repair_preview');assert.equal(p.version,'1.0.1');assert(p.canApply&&p.historyAware);assert.equal(p.activationSupported,false);
 const r=await f.normal('runtime_repair_apply',{repairId:p.id,fingerprint:p.fingerprint});assert.equal(r.repair.state,'committed');assert.equal(r.repair.version,'1.0.1');assert(!r.hostStarted&&!r.repair.activationVerified);
 await f.api.runtimeVerifyPlugin(f.q,f.j);assert.equal(await fs.readFile(path.join(f.root,'.control/runtime/inventory.json'),'utf8'),f.inv);
 assert.equal((await f.normal('runtime_repair_status')).repair.id,p.id);await assert.rejects(f.normal('runtime_repair_verify',{repairId:p.id}),/ACTIVATION_UNSUPPORTED/);
 const back=await f.call('previewRollback',{id:v.id});await f.call('rollback',{id:v.id,planId:back.id,fingerprint:back.fingerprint,confirm:true});await f.api.runtimeVerifyPlugin(f.q,f.j);
 await assert.rejects(f.normal('runtime_rollback'),/VERSION_HISTORY_PRESERVED/);
});
test('local durable repair client can query a lost actual upgraded-file publication without replay',async t=>{
 const f=await fixture(t,{lifecycle:true,historyRepair:true});await f.call('receive',f.upload);const v=await f.call('preview',{id:f.upload.id});await f.call('apply',approve(v));await fs.writeFile(path.join(f.root,'runtime/plugin/new-module.js'),'BROKEN');
 const records=new Map(),credentials=()=>({readRecord:async k=>structuredClone(records.get(k)),modifyRecord:async(k,fn)=>records.set(k,structuredClone(fn(structuredClone(records.get(k)))))});
 let sends=0,drop=true;const p={...f.q,id:f.q.operationId},a={files:f.files,baseline:{node:{path:process.execPath}}};
 const call=(action,x={})=>runtimeRepairClient({p,a,b:{fixture:true},credentials,args:{action,operationId:p.id,...x},ssh:{execute:async(b,cmd,input)=>{sends++;const q=JSON.parse(input),value=await f.api.runtimeControl(q,f.io);if(q.action==='runtime_repair_apply'&&drop){drop=false;throw Error('lost reply');}return JSON.stringify({ok:true,value});}}});
 const plan=await call('runtime_repair_preview'),args={repairId:plan.id,fingerprint:plan.fingerprint,confirm:true};await assert.rejects(call('runtime_repair_apply',args),/OUTCOME_UNKNOWN/);
 const n=sends;assert((await call('runtime_repair_apply',args)).notResent);assert.equal(sends,n);assert.equal((await call('runtime_repair_status')).repair.state,'committed');await f.api.runtimeVerifyPlugin(f.q,f.j);
});
test('version-aware repair still refuses dependency drift',async t=>{
 const f=await switched(t,{lifecycle:true,historyRepair:true});await fs.writeFile(path.join(f.root,'runtime/plugin/new-module.js'),'BROKEN');await fs.appendFile(path.join(f.root,'runtime/DEPENDENCY_KEEP'),'USER');
 await assert.rejects(f.normal('runtime_repair_preview'),/OUTSIDE_DRIFT/);assert.equal(await fs.readFile(path.join(f.root,'runtime/plugin/new-module.js'),'utf8'),'BROKEN');
});
for(const original of [false,true])test('version repair lifecycle capability cannot be silently changed: '+original,async t=>{
 const f=await fixture(t,{lifecycle:true,historyRepair:original}),u=structuredClone(f.upload),n=u.files.findIndex(x=>x.path==='plugin/compatibility.json'),c=JSON.parse(Buffer.from(u.files[n].data,'base64'));if(original)delete c.onboardingVersionRepair;else c.onboardingVersionRepair=1;u.files[n]=file('compatibility.json',c);u.manifestHash=mhash(u.files);
 await assert.rejects(f.call('receive',u),/REPAIR_LIFECYCLE_UNSUPPORTED/);
});

test('unresolved rules intent prevents history repair without touching damaged files',async t=>{
 const f=await switched(t,{lifecycle:true,historyRepair:true,artifactsHook:async phase=>{if(phase==='intent_saved')throw Error('lost rules intent');}}),p=await f.call('rules_preview',{});
 await assert.rejects(f.call('rules_apply',approve(p)),/lost rules intent/);await fs.writeFile(path.join(f.root,'runtime/plugin/new-module.js'),'BROKEN');
 await assert.rejects(f.normal('runtime_repair_preview'),/ARTIFACTS_RECOVERY_REQUIRED/);assert.equal(await fs.readFile(path.join(f.root,'runtime/plugin/new-module.js'),'utf8'),'BROKEN');
});
test('history repair cannot consume a tampered retained candidate receipt',async t=>{
 const f=await fixture(t,{lifecycle:true,historyRepair:true});await f.call('receive',f.upload);const v=await f.call('preview',{id:f.upload.id});await f.call('apply',approve(v));
 await fs.writeFile(path.join(f.root,'runtime/plugin/new-module.js'),'BROKEN');await fs.appendFile(path.join(f.root,'.control/runtime/plugin-candidates',f.upload.id,'receipt.json'),'invalid');
 await assert.rejects(f.normal('runtime_repair_preview'));assert.equal(await fs.readFile(path.join(f.root,'runtime/plugin/new-module.js'),'utf8'),'BROKEN');
});

for(const [original,next] of [[true,undefined],[true,2],[false,2],[false,false]])test('activation contract rejects removal or unsupported revision: '+original+'/'+next,async t=>{
 const f=await fixture(t,{lifecycle:true,historyRepair:true,historyActivation:original}),u=structuredClone(f.upload),n=u.files.findIndex(x=>x.path==='plugin/compatibility.json'),c=JSON.parse(Buffer.from(u.files[n].data,'base64'));if(next===undefined)delete c.onboardingVersionRepairActivation;else c.onboardingVersionRepairActivation=next;u.files[n]=file('compatibility.json',c);u.manifestHash=mhash(u.files);
 await assert.rejects(f.call('receive',u),/REPAIR_ACTIVATION_UNSUPPORTED/);await assert.rejects(fs.stat(path.join(f.root,'.control/runtime/plugin-candidates')),{code:'ENOENT'});
});
test('version-aware repair status enables separate activation but stopped or old Host cannot pass',async t=>{
 const f=await switched(t,{lifecycle:true,historyRepair:true,historyActivation:true});await fs.writeFile(path.join(f.root,'runtime/plugin/new-module.js'),'DAMAGED');const p=await f.normal('runtime_repair_preview');assert(p.activationSupported);
 const r=await f.normal('runtime_repair_apply',{repairId:p.id,fingerprint:p.fingerprint});assert(r.repair.activationSupported&&r.repair.activeVersionRepair);assert(!r.repair.activationVerified);
 const s=await f.normal('runtime_repair_status');assert(s.repair.activationSupported&&!s.activation.activationVerified);await assert.rejects(f.normal('runtime_repair_verify',{repairId:p.id}),/RESTART_REQUIRED/);
 const back=await f.call('previewRollback',{id:f.versionPlan.id});await f.call('rollback',{id:f.versionPlan.id,planId:back.id,fingerprint:back.fingerprint,confirm:true});const stale=await f.normal('runtime_repair_status');assert(!stale.repair.activationSupported&&!stale.repair.activeVersionRepair);assert(!stale.activation.sameRecordedRepair);
});

test('adding read-only activation accepts an image but does not grant the original archive a new contract',async t=>{
 const f=await fixture(t,{lifecycle:true,historyRepair:true}),u=structuredClone(f.upload),i=u.files.findIndex(x=>x.path==='plugin/compatibility.json'),compat=JSON.parse(Buffer.from(u.files[i].data,'base64'));
 compat.onboardingVersionRepairActivation=1;u.files[i]=file('compatibility.json',compat);u.manifestHash=mhash(u.files);
 const original=new Map(f.files.map(x=>[x.path,x])),json=name=>JSON.parse(Buffer.from(original.get('plugin/'+name).data,'base64'));
 assert.equal(validateVersionCandidatePackage(u.files,u.manifestHash,{package:json('package.json'),compatibility:json('compatibility.json'),lock:json('package-lock.json'),files:original}).version,'1.0.1');
 await f.call('receive',u);const v=await f.call('preview',{id:u.id});await f.call('apply',approve(v));
 await fs.writeFile(path.join(f.root,'runtime/plugin/new-module.js'),'DAMAGED');const p=await f.normal('runtime_repair_preview');assert.equal(p.activationSupported,false);
 await f.normal('runtime_repair_apply',{repairId:p.id,fingerprint:p.fingerprint});await f.api.runtimeVerifyPlugin(f.q,f.j);
 const s=await f.normal('runtime_repair_status');assert.equal(s.repair.activationSupported,false);assert.equal(s.activation,null);
 await assert.rejects(f.normal('runtime_repair_verify',{repairId:p.id}),/ACTIVATION_UNSUPPORTED/);
 await assert.rejects(fs.stat(path.join(f.root,'.control/runtime/plugin-version-activation.json')),{code:'ENOENT'});
 assert.equal(await fs.readFile(path.join(f.root,'.control/runtime/inventory.json'),'utf8'),f.inv);
});

for(const fault of ['changed','missing','unknown','replaced'])test('signed image diagnostic is classified before lifecycle action: '+fault,async t=>{
 const f=await fixture(t,{lifecycle:true,historyRepair:true});await f.call('receive',f.upload);const p=await f.call('preview',{id:f.upload.id});await f.call('apply',approve(p));
 const name=path.join(f.root,'runtime/plugin/new-module.js');
 if(fault==='changed')await fs.writeFile(name,'DAMAGED');
 if(fault==='missing')await fs.unlink(name);
 if(fault==='unknown')await fs.writeFile(path.join(f.root,'runtime/plugin/USER_KEEP'),'unknown');
 if(fault==='replaced'){await fs.rename(name,path.join(f.dir,'retained-original'));await fs.writeFile(name,'// newly added',{mode:0o600});}
 const before=await f.api.runtimeInventory(f.q);
 await assert.rejects(f.api.runtimeVerifyPlugin(f.q,f.j),{message:'ONBOARDING_CLOUD_RUNTIME_VERSION_IMAGE_DRIFT'});
 await assert.rejects(f.api.runtimeEffectiveInventory(f.q,f.j),{message:'ONBOARDING_CLOUD_RUNTIME_VERSION_IMAGE_DRIFT'});
 assert.deepEqual(await f.api.runtimeInventory(f.q),before);assert.equal(await fs.readFile(path.join(f.root,'.control/runtime/inventory.json'),'utf8'),f.inv);
});

test('restart CLI preserves specific image-drift code without starting or exposing input',{skip:process.platform!=='linux'},async t=>{
 const f=await fixture(t,{lifecycle:true,historyRepair:true,artifacts:true});await f.call('receive',f.upload);const p=await f.call('preview',{id:f.upload.id});await f.call('apply',approve(p));
 const dir=path.join(f.root,'runtime/native-home/dsh/profiles/web');await fs.mkdir(dir,{recursive:true,mode:0o700});const patch=path.join(dir,'cordis.patch.yml');await fs.writeFile(patch,'KEEP_PRIVATE_PROFILE',{mode:0o600});
 f.j.defaultConfig={path:patch};f.j.host={pid:999999999,platform:'linux',start:'0',boot:randomUUID()};await f.save();
 await fs.writeFile(path.join(f.root,'runtime/plugin/new-module.js'),'DAMAGED');
 const before=await f.api.runtimeInventory(f.q),script=path.join(f.dir,'cli.mjs');await fs.writeFile(script,runtimeProgram(controller,extension)+'\nawait runtimeCLI();');
 const result=JSON.parse(await runProcess(process.execPath,[script],{input:JSON.stringify({...f.q,action:'runtime_restart_preview'}),env:{PATH:process.env.PATH}}));
 assert.deepEqual(result,{ok:false,error:'ONBOARDING_CLOUD_RUNTIME_VERSION_IMAGE_DRIFT'});
 assert.deepEqual(await f.api.runtimeInventory(f.q),before);assert.equal(await fs.readFile(path.join(f.root,'.control/runtime/inventory.json'),'utf8'),f.inv);
 await assert.rejects(fs.stat(path.join(f.root,'.control/runtime/restarts')),{code:'ENOENT'});
});

for(const kind of ['version','runtime'])test('private '+kind+' journal failure exposes only a classified or generic code',{skip:process.platform!=='linux'},async t=>{
 const f=await fixture(t,{lifecycle:true,historyRepair:true});await f.call('receive',f.upload);const p=await f.call('preview',{id:f.upload.id});await f.call('apply',approve(p));
 const dir=path.join(f.root,'runtime/native-home/dsh/profiles/web');await fs.mkdir(dir,{recursive:true,mode:0o700});const patch=path.join(dir,'cordis.patch.yml');await fs.writeFile(patch,'PRIVATE_PROFILE',{mode:0o600});
 f.j.defaultConfig={path:patch};f.j.host={pid:999999999,platform:'linux',start:'0',boot:randomUUID()};await f.save();
 const journal=kind==='version'?path.join(f.root,'.control/runtime/plugin-versions',p.id,'journal.json'):path.join(f.root,'.control/runtime/journal.json');
 await fs.writeFile(journal,'PRIVATE_MALFORMED_JOURNAL',{mode:0o600});
 const script=path.join(f.dir,'cli.mjs');await fs.writeFile(script,runtimeProgram(controller,extension)+'\nawait runtimeCLI();');
 const output=await runProcess(process.execPath,[script],{input:JSON.stringify({...f.q,action:'runtime_restart_preview'}),env:{PATH:process.env.PATH}});
 assert.deepEqual(JSON.parse(output),{ok:false,error:kind==='version'?'ONBOARDING_CLOUD_RUNTIME_VERSION_JOURNAL_REVIEW':'ONBOARDING_CLOUD_RUNTIME_FAILED'});assert(!output.includes('PRIVATE')&&!output.includes(f.root));
 await assert.rejects(fs.stat(path.join(f.root,'.control/runtime/restarts')),{code:'ENOENT'});
});

test('runtime diagnostic guidance and original-capability boundary reach the built UI and Skill',async()=>{
 const ui=await fs.readFile(new URL('../ui-source/onboarding/cloud-installation.jsx',import.meta.url),'utf8'),built=await fs.readFile(new URL('../bundle/workbench-client.js',import.meta.url),'utf8');
 for(const code of ['ONBOARDING_CLOUD_RUNTIME_VERSION_IMAGE_DRIFT','ONBOARDING_CLOUD_RUNTIME_REPAIR_ACTIVATION_UNSUPPORTED','ONBOARDING_CLOUD_RUNTIME_VERSION_HISTORY_PRESERVED']){assert(ui.includes(code));assert(built.includes(code));}
 assert(ui.includes('不要重试启动或重建归属'));assert(ui.includes('不会回收整个 Host'));
 const skill=await fs.readFile(new URL('../bundle/skills/task-onboarding/SKILL.md',import.meta.url),'utf8');assert(skill.includes('禁止改写旧归档补能力'));assert(skill.includes('不回显私密异常原文'));
});

async function removable(t,options={}){
 const f=await fixture(t,{lifecycle:true,historyRepair:true,artifacts:true,uninstall:true,...options});
 const dsh=path.join(f.root,'runtime/native-home/dsh');await fs.appendFile(path.join(dsh,'AGENTS.md'),'LATER USER SUFFIX\r\n');
 await fs.writeFile(path.join(dsh,'KEEP_CREDENTIAL_FIXTURE'),'SYNTHETIC_CREDENTIAL_NOT_REAL',{mode:0o600});
 await fs.writeFile(path.join(dsh,'skills/task-onboarding/KEEP_SIDEFILE'),'USER SIDEFILE',{mode:0o600});
 return {...f,dsh};
}
for(const phase of ['initial','upgrade','repair','rollback-repair'])test('three-artifact uninstall retains user data and history after '+phase,async t=>{
 const f=await removable(t);let v;
 if(phase!=='initial'){
  await f.call('receive',f.upload);v=await f.call('preview',{id:f.upload.id});await f.call('apply',approve(v));const rules=await f.call('rules_preview',{});await f.call('rules_apply',approve(rules));
  if(phase==='rollback-repair'){const b=await f.call('previewRollback',{id:v.id});await f.call('rollback',{id:v.id,planId:b.id,fingerprint:b.fingerprint,confirm:true});const rp=await f.call('rules_preview',{});await f.call('rules_apply',approve(rp));}
  if(phase.includes('repair')){await fs.writeFile(path.join(f.root,'runtime/plugin/onboarding-runtime-version.js'),'DAMAGED');const p=await f.normal('runtime_repair_preview');await f.normal('runtime_repair_apply',{repairId:p.id,fingerprint:p.fingerprint});}
 }
 const owner=await fs.readFile(path.join(f.root,'.dsh-onboarding-owner.json')),image=await fs.stat(path.join(f.root,'runtime/plugin'));
 const p=await f.call('uninstall_preview',{});assert(p.canApply&&p.userDataPreserved&&p.backupsRetained&&!p.dependenciesRemoved);assert.equal(p.version,phase==='initial'||phase==='rollback-repair'?'1.0.0':'1.0.1');
 assert(await fs.stat(path.join(f.root,'runtime/plugin')));const a=approve(p),r=await f.call('uninstall_apply',a);assert.equal(r.state,'committed');assert.equal(r.pluginInstalled,false);
 assert.equal((await f.call('uninstall_apply',a)).notResent,true);await assert.rejects(fs.stat(path.join(f.root,'runtime/plugin')),{code:'ENOENT'});
 assert.equal((await fs.stat(path.join(f.root,'.control/runtime/retired-plugin'))).ino,image.ino);
 assert.equal(await fs.readFile(path.join(f.dsh,'AGENTS.md'),'utf8'),'\ufeffUSER PREFIX\r\nLATER USER SUFFIX\r\n');assert.equal((await fs.stat(path.join(f.dsh,'AGENTS.md'))).mode&0o777,0o640);
 assert.equal(await fs.readFile(path.join(f.dsh,'KEEP_CREDENTIAL_FIXTURE'),'utf8'),'SYNTHETIC_CREDENTIAL_NOT_REAL');assert.equal(await fs.readFile(path.join(f.root,'runtime/workspace/USER_KEEP'),'utf8'),'user outcome');
 assert.equal(await fs.readFile(path.join(f.dsh,'skills/task-onboarding/KEEP_SIDEFILE'),'utf8'),'USER SIDEFILE');await assert.rejects(fs.stat(path.join(f.dsh,'skills/task-onboarding/SKILL.md')),{code:'ENOENT'});
 assert.equal(await fs.readFile(path.join(f.root,'runtime/DEPENDENCY_KEEP'),'utf8'),'native dependency sentinel');assert.equal(await fs.readFile(path.join(f.root,'.control/runtime/inventory.json'),'utf8'),f.inv);assert.deepEqual(await fs.readFile(path.join(f.root,'.dsh-onboarding-owner.json')),owner);
 if(v){assert(await fs.stat(path.join(f.root,'.control/runtime/plugin-versions',v.id)));assert.equal((await f.call('status',{id:v.id})).historical,true);}
 assert.equal((await f.call('uninstall_status',{id:p.id})).state,'committed');assert.equal((await f.normal('runtime_status')).state,'plugin_uninstalled');
 for(const action of ['runtime_restart_preview','runtime_repair_preview','runtime_rollback'])await assert.rejects(f.normal(action),/UNINSTALL_ALREADY_UNINSTALLED/);
 await assert.rejects(f.call('rules_preview',{}),/UNINSTALL_ALREADY_UNINSTALLED/);await assert.rejects(f.call('receive',{...f.upload,id:randomUUID()}),/UNINSTALL_ALREADY_UNINSTALLED/);
});

for(const fault of ['user_rule','user_skill','shared_skill'])test('uninstall conflict '+fault+' preserves all three artifacts',async t=>{
 const f=await removable(t);
 if(fault==='user_rule')await fs.appendFile(path.join(f.dsh,'AGENTS.md'),'<!-- dsh-dual-host:begin -->');
 if(fault==='user_skill')await fs.appendFile(path.join(f.dsh,'skills/task-onboarding/SKILL.md'),'USER EDIT');
 if(fault==='shared_skill')await fs.mkdir(path.join(f.root,'runtime/native-home/agents/skills/task-onboarding'),{recursive:true});
 const before=await f.api.runtimeInventory(f.q),p=await f.call('uninstall_preview',{});assert.equal(p.canApply,false);assert(p.conflicts.length);assert.deepEqual(await f.api.runtimeInventory(f.q),before);
 await assert.rejects(fs.stat(path.join(f.root,'.control/runtime/plugin-uninstall.json')),{code:'ENOENT'});
});
test('uninstall contract is required on original archive, not granted by caller',async t=>{const f=await fixture(t,{lifecycle:true,artifacts:true});await assert.rejects(f.call('uninstall_preview',{}),/UNINSTALL_UNSUPPORTED/);assert(await fs.stat(path.join(f.root,'runtime/plugin')));});
test('uninstall requires fresh confirmation and refuses file drift before intent',async t=>{
 const f=await removable(t),p=await f.call('uninstall_preview',{});await assert.rejects(f.call('uninstall_apply',{...approve(p),confirm:false}),/CONFIRMATION_REQUIRED/);
 await fs.appendFile(path.join(f.dsh,'AGENTS.md'),'AFTER PREVIEW');await assert.rejects(f.call('uninstall_apply',approve(p)),/PLAN_DRIFT/);await assert.rejects(fs.stat(path.join(f.root,'.control/runtime/plugin-uninstall.json')),{code:'ENOENT'});
 assert((await fs.readFile(path.join(f.dsh,'AGENTS.md'),'utf8')).endsWith('AFTER PREVIEW'));
});
for(const fault of ['unknown_image','changed_dependency','busy_state'])test('uninstall refuses '+fault+' without weakening existing gates',async t=>{
 const f=await removable(t);
 if(fault==='unknown_image')await fs.writeFile(path.join(f.root,'runtime/plugin/USER_KEEP'),'unknown');
 if(fault==='changed_dependency')await fs.appendFile(path.join(f.root,'runtime/DEPENDENCY_KEEP'),'CHANGED');
 if(fault==='busy_state'){f.j.state='restarting';await f.save();}
 await assert.rejects(f.call('uninstall_preview',{}));assert(await fs.stat(path.join(f.root,'runtime/plugin')));assert(await fs.stat(path.join(f.dsh,'skills/task-onboarding/SKILL.md')));
 await assert.rejects(fs.stat(path.join(f.root,'.control/runtime/plugin-uninstall.json')),{code:'ENOENT'});
});

for(const fault of ['rules_returned','rules_removed','before_capture','after_capture','after_commit'])test('uninstall lost result at '+fault+' is queried then explicitly recovered, not replayed',async t=>{
 let once=true;const f=await removable(t,{uninstallHook:async name=>{if(name===fault&&once){once=false;throw Error('controlled lost result');}}}),p=await f.call('uninstall_preview',{});
 await assert.rejects(f.call('uninstall_apply',approve(p)),/controlled lost result/);const s=await f.call('uninstall_status',{id:p.id});
 assert((await f.call('uninstall_apply',approve(p))).notResent);
 if(fault==='after_commit')assert.equal(s.state,'committed');
 else {assert(s.recoveryRequired);await assert.rejects(f.normal('runtime_restart_preview'),/UNINSTALL_RECOVERY_REQUIRED/);const r=await f.call('uninstall_recoveryPreview',{id:p.id});assert.equal((await f.call('uninstall_recover',approve(r))).state,'committed');}
 assert.equal((await f.call('uninstall_status',{})).state,'committed');assert.equal(await fs.readFile(path.join(f.dsh,'AGENTS.md'),'utf8'),'\ufeffUSER PREFIX\r\nLATER USER SUFFIX\r\n');
 await assert.rejects(fs.stat(path.join(f.root,'runtime/plugin')),{code:'ENOENT'});assert(await fs.stat(path.join(f.root,'.control/runtime/retired-plugin')));
});
test('uninstall finalizes a committed inner rules transaction only after separate recovery confirmation',async t=>{
 let once=true;const f=await removable(t,{artifactsHook:async name=>{if(name==='after_commit'&&once){once=false;throw Error('lost cleanup');}}}),p=await f.call('uninstall_preview',{});
 await assert.rejects(f.call('uninstall_apply',approve(p)),/INNER_RECOVERY_REQUIRED/);assert(await fs.stat(path.join(f.root,'runtime/plugin')));
 const r=await f.call('uninstall_recoveryPreview',{id:p.id});assert.equal(r.action,'finalize_receipt');assert.equal((await f.call('uninstall_recover',approve(r))).state,'committed');
});
test('rolled-back rules removal restores trusted metadata binding and allows a new separately confirmed attempt',async t=>{
 let once=true;const f=await removable(t,{artifactsHook:async name=>{if(name==='after_capture'&&once){once=false;throw Error('rollback fixture');}}}),p=await f.call('uninstall_preview',{});
 assert.equal((await f.call('uninstall_apply',approve(p))).state,'rolled_back');assert(await fs.stat(path.join(f.root,'runtime/plugin')));
 assert((await fs.readFile(path.join(f.dsh,'AGENTS.md'),'utf8')).includes('Original managed rule.'));assert((await f.call('rules_preview',{})).artifactsMatched);
 const next=await f.call('uninstall_preview',{});assert.notEqual(next.id,p.id);assert.equal((await f.call('uninstall_apply',approve(next))).state,'committed');
});
test('proven unstarted uninstall requires explicit cancellation, never blind replay',async t=>{
 let once=true;const f=await removable(t,{uninstallHook:async name=>{if(name==='intent_saved'&&once){once=false;throw Error('gap');}}}),p=await f.call('uninstall_preview',{}),before=await f.api.runtimeInventory(f.q);
 await assert.rejects(f.call('uninstall_apply',approve(p)),/gap/);assert.equal((await f.call('uninstall_status',{})).state,'intent');
 await assert.rejects(f.call('rules_preview',{}),/UNINSTALL_RECOVERY_REQUIRED/);assert.deepEqual(await f.api.runtimeInventory(f.q),before);
 const r=await f.call('uninstall_recoveryPreview',{id:p.id});assert.equal(r.action,'cancel_proven_unstarted_uninstall');assert.equal((await f.call('uninstall_status',{})).state,'intent');
 const done=await f.call('uninstall_recover',approve(r));assert.equal(done.state,'rolled_back');assert(done.cancelledBeforeInnerAction);assert.deepEqual(await f.api.runtimeInventory(f.q),before);
 const next=await f.call('uninstall_preview',{});assert.notEqual(next.id,p.id);assert.equal((await f.call('uninstall_apply',approve(next))).state,'committed');
});
for(const fault of ['inner_directory','inner_lock','changed_file','equal_replacement'])test('missing inner journal with '+fault+' remains unresolved',async t=>{
 const f=await removable(t,{uninstallHook:async name=>{if(name==='intent_saved')throw Error('gap');}}),p=await f.call('uninstall_preview',{});await assert.rejects(f.call('uninstall_apply',approve(p)),/gap/);
 const d=JSON.parse(await fs.readFile(path.join(f.root,'.control/runtime/plugin-uninstall.json'),'utf8')),id=d.records[0].innerId,state=path.join(f.dsh,'dual-host-onboarding');
 if(fault==='inner_directory')await fs.mkdir(path.join(state,'maintenance-transactions',id),{recursive:true,mode:0o700});
 if(fault==='inner_lock')await fs.writeFile(path.join(state,'lock.json'),JSON.stringify({id,pid:process.pid,kind:'maintenance'}),{mode:0o600});
 if(fault==='changed_file')await fs.appendFile(path.join(f.dsh,'AGENTS.md'),'USER');
 if(fault==='equal_replacement'){const name=path.join(f.dsh,'AGENTS.md'),data=await fs.readFile(name);await fs.rename(name,path.join(f.dir,'KEEP_RULE'));await fs.writeFile(name,data,{mode:0o640});}
 await assert.rejects(f.call('uninstall_recoveryPreview',{id:p.id}),/INNER_JOURNAL_REQUIRED/);assert.equal((await f.call('uninstall_status',{})).state,'intent');assert(await fs.stat(path.join(f.root,'runtime/plugin')));
});
test('an arriving retired-image destination is never overwritten or adopted',async t=>{
 let root;const f=await removable(t,{uninstallHook:async name=>{if(name==='before_capture')await fs.mkdir(path.join(root,'.control/runtime/retired-plugin'),{mode:0o700});}});root=f.root;
 const p=await f.call('uninstall_preview',{});await assert.rejects(f.call('uninstall_apply',approve(p)),/MOVE_REFUSED/);assert(await fs.stat(path.join(f.root,'runtime/plugin')));assert.deepEqual(await fs.readdir(path.join(f.root,'.control/runtime/retired-plugin')),[]);
 await assert.rejects(f.call('uninstall_recoveryPreview',{id:p.id}),/IMAGE_DRIFT/);
});
test('tampered uninstall ledger blocks restart and does not delete any retained image',async t=>{
 const f=await removable(t),p=await f.call('uninstall_preview',{});await f.call('uninstall_apply',approve(p));await fs.appendFile(path.join(f.root,'.control/runtime/plugin-uninstall.json'),'bad');
 await assert.rejects(f.normal('runtime_restart_preview'),/LEDGER_REVIEW/);assert(await fs.stat(path.join(f.root,'.control/runtime/retired-plugin')));
});

test('uninstall plans expire; re-preview cannot renew an old confirmation',async t=>{
 const f=await removable(t);let time=Date.now();f.io.versionNow=()=>time;
 const p=await f.call('uninstall_preview',{});time+=300001;await assert.rejects(f.call('uninstall_apply',approve(p)),/PLAN_DRIFT/);
 const next=await f.call('uninstall_preview',{});await assert.rejects(f.call('uninstall_apply',approve(p)),/PLAN_DRIFT/);
 assert.notEqual(next.id,p.id);assert.equal((await f.call('uninstall_apply',approve(next))).state,'committed');
});
test('uninstall recovery rejects stale observations and missing explicit confirmation',async t=>{
 const f=await removable(t,{uninstallHook:async name=>{if(name==='rules_removed')throw Error('lost result');}}),p=await f.call('uninstall_preview',{});
 await assert.rejects(f.call('uninstall_apply',approve(p)),/lost result/);const r=await f.call('uninstall_recoveryPreview',{id:p.id});
 await assert.rejects(f.call('uninstall_recover',{...approve(r),confirm:false}),/CONFIRMATION_REQUIRED/);
 await fs.appendFile(path.join(f.dsh,'AGENTS.md'),'USER AFTER PLAN');await assert.rejects(f.call('uninstall_recover',approve(r)),/RULES_DRIFT/);
 assert((await fs.readFile(path.join(f.dsh,'AGENTS.md'),'utf8')).endsWith('USER AFTER PLAN'));assert(await fs.stat(path.join(f.root,'runtime/plugin')));
 assert.equal((await f.call('uninstall_status',{})).state,'rules_removed');
});
for(const kind of ['version','rules'])test('uninstall refuses unresolved '+kind+' history',async t=>{
 let once=true;const f=await removable(t,{artifactsHook:kind==='rules'?async phase=>{if(phase==='maintenance_returned'&&once){once=false;throw Error('rules gap');}}:undefined});
 await f.call('receive',f.upload);const p=await f.call('preview',{id:f.upload.id});
 if(kind==='version'){
  // Preserve a real uncompleted version journal instead of fabricating a ledger.
  f.io.versionHook=async phase=>{if(phase==='after_capture')throw Error('version gap');};
  assert.equal((await f.call('apply',approve(p))).state,'needs_review');
 }else{await f.call('apply',approve(p));const r=await f.call('rules_preview',{});await assert.rejects(f.call('rules_apply',approve(r)),/rules gap/);}
 await assert.rejects(f.call('uninstall_preview',{}),/RECOVERY_REQUIRED/);
 await assert.rejects(fs.stat(path.join(f.root,'.control/runtime/plugin-uninstall.json')),{code:'ENOENT'});
});
for(const [channel,phase,expected] of [['uninstallHook','intent_saved','rolled_back'],['artifactsHook','after_capture','rolled_back'],['artifactsHook','after_commit','committed'],['uninstallHook','after_capture','committed'],['uninstallHook','after_commit','committed']])test('actual uninstall controller SIGKILL '+channel+'/'+phase+' recovers without replay',{timeout:45000},async t=>{
 const f=await removable(t),p=await f.call('uninstall_preview',{}),runner=path.join(f.dir,'crash-uninstall.mjs');
 // Linux exercises the real archive owner flock. Mac only exercises the file
 // coordinator through a lock seam; neither fixture starts a native DSH Host.
 const lock=process.platform==='linux'?'':'lock:async(q,fn)=>fn(),';if(process.platform==='linux')delete f.io.lock;
 await fs.writeFile(runner,`import {runtimeVersionControl} from ${JSON.stringify(pathToFileURL(path.join(f.dir,'controller.mjs')).href)};import {renameExclusive} from ${JSON.stringify(new URL('../bundle/onboarding-exclusive-rename.js',import.meta.url).href)};let raw='';for await(const c of process.stdin)raw+=c;await runtimeVersionControl(JSON.parse(raw),{${lock}versionMove:renameExclusive,${channel}:async phase=>{if(phase===${JSON.stringify(phase)})process.kill(process.pid,'SIGKILL');}});`);
 const {spawn}=await import('node:child_process'),child=spawn(process.execPath,[runner],{env:{HOME:f.dir,PATH:process.env.PATH,TMPDIR:f.dir},stdio:['pipe','ignore','pipe'],timeout:30000,killSignal:'SIGKILL'});let err='';child.stderr.on('data',b=>err+=b);
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 child.stdin.end(JSON.stringify({...f.q,action:'runtime_version',versionAction:'uninstall_apply',args:approve(p)}));assert.deepEqual(await done,{code:null,signal:'SIGKILL'},err);
 const s=await f.call('uninstall_status',{id:p.id});assert.notEqual(s.state,'not_requested');assert((await f.call('uninstall_apply',approve(p))).notResent);
 if(s.recoveryRequired){const r=await f.call('uninstall_recoveryPreview',{id:p.id});assert.notEqual(r.id,p.id);assert.equal((await f.call('uninstall_recover',approve(r))).state,expected);}else assert.equal(s.state,expected);
 assert.equal(await fs.readFile(path.join(f.root,'runtime/workspace/USER_KEEP'),'utf8'),'user outcome');assert.equal(await fs.readFile(path.join(f.dsh,'KEEP_CREDENTIAL_FIXTURE'),'utf8'),'SYNTHETIC_CREDENTIAL_NOT_REAL');
 if(expected==='committed'){await assert.rejects(fs.stat(path.join(f.root,'runtime/plugin')),{code:'ENOENT'});await assert.rejects(f.normal('runtime_restart_preview'),/UNINSTALL_ALREADY_UNINSTALLED/);}
 else{assert(await fs.stat(path.join(f.root,'runtime/plugin')));assert((await f.call('rules_preview',{})).artifactsMatched);}
});

test('public cloud version route persists real uninstall intent and blocks local lifecycle after lost response',async t=>{
 const f=await removable(t),a={files:f.files,manifestHash:mhash(f.files),baseline:{node:{path:process.execPath}}},data=JSON.stringify(a),binding={revision:1,fixture:true};
 const p={owner:'dsh-dual-host-onboarding',schema:1,id:f.q.operationId,revision:1,planId:randomUUID(),planHash:f.q.planHash,installationId:f.q.installationId,root:f.q.root,proof:f.q.proof,bindingFingerprint:hash(binding),bindingRevision:1,manifestHash:a.manifestHash,archiveHash:hash(data),createdAt:Date.now(),updatedAt:Date.now(),phase:'prepared',error:null,remote:null};
 const localState=path.join(f.dir,'local'),dir=path.join(localState,'cloud',p.id);await fs.mkdir(dir,{recursive:true,mode:0o700});await fs.writeFile(path.join(dir,'package.json'),data,{mode:0o600});
 const records=new Map([['dsh-task-gateway/onboarding-cloud-operation-v1',{kind:'grant',payload:p}],['dsh-task-gateway/onboarding-runtime-v1-'+p.id,{kind:'grant',payload:{owner:p.owner,schema:1,operationId:p.id,fingerprint:hash('launch'),state:'observed',remote:{operationId:p.id,runtimeId:f.j.id,state:'host_stopped'}}}]]);
 const c={readRecord:async k=>structuredClone(records.get(k)),modifyRecord:async(k,fn)=>records.set(k,structuredClone(fn(structuredClone(records.get(k)))))};let sends=0,drop=true;
 const options={credentials:()=>c,readBinding:async()=>binding,localState,source:path.join(f.root,'plugin'),enabled:()=>true,runtimeEnabled:()=>true,ssh:{execute:async(b,command,input)=>{sends++;const q=JSON.parse(input);assert.equal(q.root,f.root);assert(!command.includes(p.proof));if(q.versionAction==='uninstall_apply')assert.equal(records.get(uninstallRecordKey(p.id)).payload.requests.at(-1).state,'requested');const value=await f.api.runtimeVersionControl(q,f.io);if(q.versionAction==='uninstall_apply'&&drop){drop=false;throw Error('lost after actual uninstall');}return JSON.stringify({ok:true,value});}}};
 let svc=createCloudOperations(options);const call=(action,x={})=>svc.versionAction({action,operationId:p.id,...x});
 assert((await call('uninstall_record')).supported);assert.equal(sends,0);const plan=await call('uninstall_preview');await assert.rejects(call('uninstall_apply',approve(plan)),/OUTCOME_UNKNOWN/);
 await assert.rejects(fs.stat(path.join(f.root,'runtime/plugin')),{code:'ENOENT'});assert.equal(records.get(uninstallRecordKey(p.id)).payload.requests.at(-1).state,'requested');
 svc=createCloudOperations(options);const before=sends;assert((await call('uninstall_record')).pending);assert((await call('uninstall_apply',approve(plan))).notResent);assert.equal(sends,before);
 for(const action of ['candidate_preview','rules_preview'])await assert.rejects(call(action),/UNINSTALL_RECOVERY_REQUIRED/);
 await assert.rejects(svc.runtimeAction({action:'runtime_restart_preview',operationId:p.id}),/UNINSTALL_RECOVERY_REQUIRED/);assert.equal(sends,before);
 assert.equal((await call('uninstall_status',{id:plan.id})).state,'committed');assert((await call('uninstall_record')).blocked);assert(!(await call('uninstall_record')).pending);
 await assert.rejects(svc.runtimeAction({action:'runtime_preview',operationId:p.id}),/UNINSTALL_RECOVERY_REQUIRED/);
 assert.equal(await fs.readFile(path.join(f.dsh,'AGENTS.md'),'utf8'),'\ufeffUSER PREFIX\r\nLATER USER SUFFIX\r\n');assert.equal(await fs.readFile(path.join(f.root,'.control/runtime/inventory.json'),'utf8'),f.inv);
});

test('public cloud reclamation request uses actual target code and recovers a dropped before-send without replay',async t=>{
 const f=await removable(t,{reclaim:true}),a={files:f.files,manifestHash:mhash(f.files),baseline:{node:{path:process.execPath}}},data=JSON.stringify(a),binding={revision:1,fixture:true};
 const p={owner:'dsh-dual-host-onboarding',schema:1,id:f.q.operationId,revision:1,planId:randomUUID(),planHash:f.q.planHash,installationId:f.q.installationId,root:f.q.root,proof:f.q.proof,bindingFingerprint:hash(binding),bindingRevision:1,manifestHash:a.manifestHash,archiveHash:hash(data),createdAt:Date.now(),updatedAt:Date.now(),phase:'prepared',error:null,remote:null};
 const localState=path.join(f.dir,'local'),dir=path.join(localState,'cloud',p.id);await fs.mkdir(dir,{recursive:true,mode:0o700});await fs.writeFile(path.join(dir,'package.json'),data,{mode:0o600});
 const records=new Map([['dsh-task-gateway/onboarding-cloud-operation-v1',{kind:'grant',payload:p}],['dsh-task-gateway/onboarding-runtime-v1-'+p.id,{kind:'grant',payload:{owner:p.owner,schema:1,operationId:p.id,fingerprint:hash('launch'),state:'observed',remote:{operationId:p.id,runtimeId:f.j.id,state:'host_stopped'}}}]]);
 const c={readRecord:async k=>structuredClone(records.get(k)),modifyRecord:async(k,fn)=>records.set(k,structuredClone(fn(structuredClone(records.get(k)))))};let sends=0,drop=true;
 const options={credentials:()=>c,readBinding:async()=>binding,localState,source:path.join(f.root,'plugin'),enabled:()=>true,runtimeEnabled:()=>true,ssh:{execute:async(b,command,input)=>{sends++;const q=JSON.parse(input);assert.equal(q.root,f.root);assert(!command.includes(p.proof));if(q.versionAction==='uninstall_apply')assert.equal(records.get(uninstallRecordKey(p.id)).payload.requests.at(-1).state,'requested');const value=await f.api.runtimeVersionControl(q,f.io);if(q.versionAction==='uninstall_apply'&&drop){drop=false;throw Error('lost after actual uninstall');}return JSON.stringify({ok:true,value});}}};
 let svc=createCloudOperations(options);const call=(action,x={})=>svc.versionAction({action,operationId:p.id,...x});
 assert((await call('uninstall_record')).supported);assert.equal(sends,0);const plan=await call('uninstall_preview');await assert.rejects(call('uninstall_apply',approve(plan)),/OUTCOME_UNKNOWN/);
 await assert.rejects(fs.stat(path.join(f.root,'runtime/plugin')),{code:'ENOENT'});assert.equal(records.get(uninstallRecordKey(p.id)).payload.requests.at(-1).state,'requested');
 svc=createCloudOperations(options);const before=sends;assert((await call('uninstall_record')).pending);assert((await call('uninstall_apply',approve(plan))).notResent);assert.equal(sends,before);
 for(const action of ['candidate_preview','rules_preview'])await assert.rejects(call(action),/UNINSTALL_RECOVERY_REQUIRED/);
 await assert.rejects(svc.runtimeAction({action:'runtime_restart_preview',operationId:p.id}),/UNINSTALL_RECOVERY_REQUIRED/);assert.equal(sends,before);
 assert.equal((await call('uninstall_status',{id:plan.id})).state,'committed');assert((await call('uninstall_record')).blocked);assert(!(await call('uninstall_record')).pending);
 await assert.rejects(svc.runtimeAction({action:'runtime_preview',operationId:p.id}),/UNINSTALL_RECOVERY_REQUIRED/);
 assert.equal(await fs.readFile(path.join(f.dsh,'AGENTS.md'),'utf8'),'\ufeffUSER PREFIX\r\nLATER USER SUFFIX\r\n');assert.equal(await fs.readFile(path.join(f.root,'.control/runtime/inventory.json'),'utf8'),f.inv);
 const rec=await call('reclaim_record');assert(rec.supported);
 const targetSend=options.ssh.execute;options.ssh.execute=async(...params)=>{try{return await targetSend(...params);}catch(e){if(/^ONBOARDING_CLOUD_[A-Z_]+$/.test(e.message))return JSON.stringify({ok:false,error:e.message});throw e;}};
 const stale=await call('reclaim_preview'),rp=await call('reclaim_preview');await assert.rejects(call('reclaim_apply',approve(stale)),/PLAN_EXPIRED/);assert(!(await call('reclaim_record')).blocked);

 const originalSend=options.ssh.execute;let lost=true;options.ssh.execute=async(...params)=>{const q=JSON.parse(params[2]);if(q.versionAction==='reclaim_apply'&&lost){lost=false;assert.equal(records.get(reclaimRecordKey(p.id)).payload.requests.at(-1).state,'requested');throw Error('before send');}return originalSend(...params);};
 svc=createCloudOperations(options);await assert.rejects(call('reclaim_apply',approve(rp)),/OUTCOME_UNKNOWN/);assert(await fs.stat(path.join(f.root,'runtime/DEPENDENCY_KEEP')));
 const n=sends;assert((await call('reclaim_apply',approve(rp))).notResent);assert.equal(sends,n);
 await assert.rejects(call('candidate_preview'),/RECLAIM_RECOVERY_REQUIRED/);await assert.rejects(svc.runtimeAction({action:'runtime_restart_preview',operationId:p.id}),/RECLAIM_RECOVERY_REQUIRED/);assert.equal(sends,n);
 const observation=await call('reclaim_status',{id:rp.id});assert(observation.outcomeUnknown);const recover=await call('reclaim_recover_preview',{id:rp.id});assert.equal(recover.action,'start_original_manifest_if_still_unobserved');
 assert.equal((await call('reclaim_recover',approve(recover))).state,'committed');await assert.rejects(fs.stat(path.join(f.root,'runtime/DEPENDENCY_KEEP')),{code:'ENOENT'});
 assert((await call('reclaim_record')).blocked);assert(!(await call('reclaim_record')).pending);assert.equal(await fs.readFile(path.join(f.root,'runtime/workspace/USER_KEEP'),'utf8'),'user outcome');
});

// Background worker authority tests use the same public dispatcher. Fake birth
// identities below are unit seams only; the Linux CLI test uses kernel identities.
async function backgroundFixture(t){
 const f=await reclaimable(t,{reclaimWorker:true});let live=false,starts=0,cancels=0,args;
 const birth={platform:'linux',pid:999999999,start:'123',boot:randomUUID()};
 f.io.runtimeAlive=async p=>p?.pid===birth.pid&&live;f.io.runtimeProcessInfo=async()=>birth;
 f.io.runtimeReclaimLaunch=async(q,j,a,persist)=>{args=a;await persist(birth);live=true;return {start:()=>starts++,cancel:()=>{cancels++;live=false;}};};
 return {...f,get starts(){return starts;},get cancels(){return cancels;},get args(){return args;},die:()=>{live=false;}};
}
test('background reclamation returns running before deletion and manual query bypasses exclusive writer',async t=>{
 const f=await backgroundFixture(t),p=await f.call('reclaim_preview',{});const v=await f.call('reclaim_apply',reclaimApproval(p));
 assert.equal(v.executionState,'running');assert(v.workerActive&&!v.recoveryRequired);assert.equal(f.starts,1);assert(await fs.stat(path.join(f.root,'runtime/DEPENDENCY_KEEP')));
 const lock=f.io.lock;f.io.lock=async()=>{throw Error('writer holds original lock');};
 const q=await f.call('reclaim_status',{});assert.equal(q.executionState,'running');assert(q.historical);f.io.lock=lock;
 assert((await f.call('reclaim_apply',reclaimApproval(p))).notResent);assert.equal(f.starts,1);await assert.rejects(f.call('reclaim_recoveryPreview',{}),/WORKER_ACTIVE/);
 f.die();assert.equal((await f.call('reclaim_status',{})).executionState,'interrupted');
 const rp=await f.call('reclaim_recoveryPreview',{});assert.equal((await f.call('reclaim_recover',reclaimApproval(rp))).executionState,'running');assert.equal(f.starts,2);
});
test('worker only executes its persisted current birth identity and completed work stays fenced',async t=>{
 const f=await backgroundFixture(t),p=await f.call('reclaim_preview',{});await f.call('reclaim_apply',reclaimApproval(p));const self=f.io.runtimeProcessInfo;
 f.io.runtimeProcessInfo=async()=>({...await self(),start:'other'});await assert.rejects(f.call('reclaim_worker',f.args),/NOT_AUTHORIZED/);assert(await fs.stat(path.join(f.root,'runtime/DEPENDENCY_KEEP')));
 f.io.runtimeProcessInfo=self;await f.call('reclaim_worker',f.args);f.die();const s=await f.call('reclaim_status',{});assert.equal(s.state,'committed');assert.equal(s.executionState,'completed');assert(!s.recoveryRequired&&!s.workerActive);
 await assert.rejects(f.call('reclaim_worker',f.args),/NOT_AUTHORIZED/);assert.equal(await fs.readFile(path.join(f.root,'runtime/workspace/USER_KEEP'),'utf8'),'user outcome');
});
test('a failed launch remains interrupted and cannot reuse stale recovery approval or late worker authority',async t=>{
 const f=await backgroundFixture(t),p=await f.call('reclaim_preview',{});await f.call('reclaim_apply',reclaimApproval(p));const old=f.args;f.die();const rp=await f.call('reclaim_recoveryPreview',{});
 await f.call('reclaim_recover',reclaimApproval(rp));f.die();await assert.rejects(f.call('reclaim_recover',reclaimApproval(rp)),/RECOVERY_CHANGED/);await assert.rejects(f.call('reclaim_worker',old),/NOT_AUTHORIZED/);assert.equal(f.starts,2);
});
test('missing launch identity never authorizes a worker, separate recovery records a new generation',async t=>{
 const f=await backgroundFixture(t),original=f.io.runtimeReclaimLaunch,p=await f.call('reclaim_preview',{});f.io.runtimeReclaimLaunch=async()=>{throw Error('lost before spawn');};
 await assert.rejects(f.call('reclaim_apply',reclaimApproval(p)),/lost before spawn/);assert.equal((await f.call('reclaim_status',{})).executionState,'interrupted');assert.equal(f.starts,0);
 const rp=await f.call('reclaim_recoveryPreview',{});f.io.runtimeReclaimLaunch=original;await f.call('reclaim_recover',reclaimApproval(rp));assert.equal(f.starts,1);
});
test('worker observes per-item drift, records failure and preserves unknown files',async t=>{
 const f=await backgroundFixture(t),p=await f.call('reclaim_preview',{});await f.call('reclaim_apply',reclaimApproval(p));await fs.writeFile(path.join(f.root,'runtime/UNKNOWN'),'preserve',{mode:0o600});
 await assert.rejects(f.call('reclaim_worker',f.args),/DRIFT/);f.die();assert.equal((await f.call('reclaim_status',{})).executionState,'interrupted');await assert.rejects(f.call('reclaim_recoveryPreview',{}),/DRIFT/);assert.equal(await fs.readFile(path.join(f.root,'runtime/UNKNOWN'),'utf8'),'preserve');
});
test('invalid sidecar cannot clear a deletion intent or launch another worker',async t=>{
 const f=await backgroundFixture(t),p=await f.call('reclaim_preview',{});await f.call('reclaim_apply',reclaimApproval(p));f.die();await fs.writeFile(path.join(f.root,'.control/runtime/reclaim-worker.json'),'{}',{mode:0o600});
 await assert.rejects(f.call('reclaim_status',{}),/WORKER_REVIEW/);await assert.rejects(f.call('reclaim_recoveryPreview',{}),/WORKER_REVIEW/);assert.equal(f.starts,1);
});
test('real Linux background CLI is authorized after owner unlock and query observes completion',{skip:process.platform!=='linux'},async t=>{
 // A failed real worker must retain its files/logs, never remove its scope while
 // it could still be active. Successful cleanup follows a terminal observation.
 const f=await reclaimable(t,{reclaimWorker:true,retainFixture:true}),script=path.join(f.dir,'version-worker-cli.mjs');await fs.writeFile(script,runtimeProgram(controller,extension)+'\nawait runtimeVersionCLI();');
 const invoke=async(name,args)=>JSON.parse(await runProcess(process.execPath,[script],{input:JSON.stringify({...f.q,action:'runtime_version',versionAction:name,args}),env:{HOME:f.dir,PATH:process.env.PATH}}));
 const p=await invoke('reclaim_preview',{});assert(p.ok,p.error);const a=await invoke('reclaim_apply',reclaimApproval(p.value));assert(a.ok,a.error);assert.equal(a.value.executionState,'running');
 let s;for(let i=0;i<40;i++){s=await invoke('reclaim_status',{});assert(s.ok,s.error);if(!s.value.workerActive)break;await new Promise(r=>setTimeout(r,50));}
 assert.equal(s.value.state,'committed');assert(!s.value.workerActive);assert.equal(await fs.readFile(path.join(f.root,'runtime/workspace/USER_KEEP'),'utf8'),'user outcome');
 await fs.rm(f.dir,{recursive:true});
});

test('bound worker ledger disappearance is unknown, never a new launch permission',async t=>{
 const f=await backgroundFixture(t),p=await f.call('reclaim_preview',{});await f.call('reclaim_apply',reclaimApproval(p));f.die();await fs.rename(path.join(f.root,'.control/runtime/reclaim-worker.json'),path.join(f.dir,'retained-worker-record'));
 await assert.rejects(f.call('reclaim_status',{}),/WORKER_REVIEW/);await assert.rejects(f.call('reclaim_recoveryPreview',{}),/WORKER_REVIEW/);assert.equal(f.starts,1);
});
test('unknown worker birth observation cannot claim interruption or authorize recovery',async t=>{
 const f=await backgroundFixture(t),p=await f.call('reclaim_preview',{});await f.call('reclaim_apply',reclaimApproval(p));f.io.runtimeAlive=async()=>{throw Error('process identity unreadable');};
 await assert.rejects(f.call('reclaim_status',{}),/identity unreadable/);await assert.rejects(f.call('reclaim_recoveryPreview',{}),/identity unreadable/);assert.equal(f.starts,1);
});
test('new image worker metadata cannot grant old original archive background execution',async t=>{
 const f=await fixture(t,reclaimOptions),u=structuredClone(f.upload),i=u.files.findIndex(x=>x.path==='plugin/compatibility.json'),c=JSON.parse(Buffer.from(u.files[i].data,'base64'));c.onboardingRuntimeReclamationWorker=1;u.files[i]=file('compatibility.json',c);u.manifestHash=mhash(u.files);
 await f.call('receive',u);const vp=await f.call('preview',{id:u.id});await f.call('apply',reclaimApproval(vp));const ap=await f.call('rules_preview',{});await f.call('rules_apply',reclaimApproval(ap));const up=await f.call('uninstall_preview',{});await f.call('uninstall_apply',reclaimApproval(up));
 const p=await f.call('reclaim_preview',{}),r=await f.call('reclaim_apply',reclaimApproval(p));assert.equal(r.state,'committed');assert(!r.backgroundSupported);
});

for(const [original,next] of [[true,undefined],[true,2],[false,2]])test('normal version activation contract rejects removal or revision '+original+'/'+next,async t=>{
 const f=await fixture(t,{lifecycle:true,artifacts:true,versionActivation:original}),u=structuredClone(f.upload),i=u.files.findIndex(x=>x.path==='plugin/compatibility.json'),c=JSON.parse(Buffer.from(u.files[i].data,'base64'));
 if(next===undefined)delete c.onboardingVersionActivation;else c.onboardingVersionActivation=next;u.files[i]=file('compatibility.json',c);u.manifestHash=mhash(u.files);
 await assert.rejects(f.call('receive',u),/VERSION_ACTIVATION_UNSUPPORTED/);await assert.rejects(fs.stat(path.join(f.root,'.control/runtime/plugin-candidates')),{code:'ENOENT'});
});
test('normal version activation requires original authority, not new image claim',async t=>{
 const f=await fixture(t,{lifecycle:true,artifacts:true}),u=structuredClone(f.upload),i=u.files.findIndex(x=>x.path==='plugin/compatibility.json'),c=JSON.parse(Buffer.from(u.files[i].data,'base64'));c.onboardingVersionActivation=1;u.files[i]=file('compatibility.json',c);u.manifestHash=mhash(u.files);
 await f.call('receive',u);const p=await f.call('preview',{id:u.id});await f.call('apply',approve(p));await assert.rejects(f.call('activation_status',{id:p.id}),/ACTIVATION_UNSUPPORTED/);
});
test('normal switched files have an independent historical observation without any repair record',async t=>{
 const f=await fixture(t,{lifecycle:true,artifacts:true,versionActivation:true});await f.call('receive',f.upload);const p=await f.call('preview',{id:f.upload.id});await f.call('apply',approve(p));
 const s=await f.call('activation_status',{id:p.id});assert.equal(s.scope,'maintained_plugin_version_observed');assert.equal(s.observedAt,null);assert(!s.activationVerified&&s.cached&&!s.sameRecordedRelease);assert.equal(s.requestedTransactionId,p.id);
 await assert.rejects(f.call('activation_verify',{id:p.id}),/RESTART_REQUIRED/);await assert.rejects(f.call('activation_status',{id:randomUUID()}),/VERSION_CHANGED/);
 const journal=JSON.parse(await fs.readFile(path.join(f.root,'.control/runtime/plugin-versions',p.id,'journal.json')));assert(!journal.repairs?.length);assert.equal(await fs.readFile(path.join(f.root,'.control/runtime/inventory.json'),'utf8'),f.inv);
});
test('normal activation refuses unresolved version history without fabricating a repair',async t=>{
 const f=await fixture(t,{lifecycle:true,artifacts:true,versionActivation:true,hook:async phase=>{if(phase==='after_capture')throw Error('loss');}});await f.call('receive',f.upload);const p=await f.call('preview',{id:f.upload.id});await f.call('apply',approve(p));
 await assert.rejects(f.call('activation_status',{id:p.id}),/RECOVERY_REQUIRED/);await assert.rejects(fs.stat(path.join(f.root,'.control/runtime/plugin-release-activation.json')),{code:'ENOENT'});
});
