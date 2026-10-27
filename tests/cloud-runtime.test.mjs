import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,randomBytes,createHash,createHmac} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {runtimeProgram,runtimeAbsenceProgram} from '../bundle/onboarding-runtime-program.js';
import {runtimeAdmissionDelta} from '../bundle/onboarding-runtime-inventory.js';
import {remoteControl} from '../bundle/onboarding-remote-control.js';
import {runProcess} from '../bundle/onboarding-ssh.js';
const hash=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
const controller=await fs.readFile(new URL('../bundle/onboarding-remote-control.js',import.meta.url),'utf8'),extension=await fs.readFile(new URL('../bundle/onboarding-runtime-extension.js',import.meta.url),'utf8');
const signed=(x,q)=>({...x,signature:createHmac('sha256',q.proof).update(JSON.stringify(x)).digest('hex')});
const file=(name,b)=>({path:'plugin/'+name,bytes:b.length,sha256:hash(b),mode:0o600,data:b.toString('base64')});
async function fixture(t){
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'s55-runtime-')));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const module=dir+'/extension.mjs';await fs.writeFile(module,runtimeProgram(controller,extension)+'\nexport {runtimeInventory,runtimeEnv,runtimeRestartPlan,runtimeRegisterAdmission,cleanupRead,runtimeLock,runtimeView};');const api=await import(pathToFileURL(module));
 const installationId=randomUUID(),parent=dir+'/remote',root=parent+'/host-'+installationId;
 const baseline=JSON.parse(await runProcess(process.execPath,[fileURLToPath(new URL('../bundle/onboarding-remote-probe.js',import.meta.url))],{input:JSON.stringify({parent,installationId}),env:{PATH:process.env.PATH}}));
 const files=[];for(const name of ['package.json','compatibility.json','runtime-package.json','runtime-lock.json','runtime-im-package.json','runtime-im-lock.json','onboarding-runtime-stop.js','onboarding-host-stop-observation.js','onboarding-runtime-inventory.js','onboarding-runtime-repair.js','onboarding-runtime-activation.js','onboarding-plugin-repair.js','onboarding-install-fs.js','onboarding-maintenance-fs.js'])files.push(file(name,await fs.readFile(new URL('../bundle/'+name,import.meta.url))));files.push(file('onboarding-native-host.js',Buffer.from("export async function restartNativeHost(){throw Error('ONBOARDING_CLOUD_NATIVE_ADMISSION_FAILED');}")));files.sort((a,b)=>a.path<b.path?-1:1);
 const q={root,installationId,operationId:randomUUID(),proof:randomBytes(32).toString('hex'),planHash:hash('plan')};
 await remoteControl({...q,action:'prepare',baseline,files,manifestHash:hash(files.map(({data,...f})=>f))});await fs.writeFile(dir+'/USER_KEEP','preserved');
 return {dir,root,q,api,call:(action,io={})=>api.runtimeControl({...q,action},{...(process.platform==='linux'?{}:{lock:async(q,fn)=>fn()}),...io})};
}
async function installed(f){
 const d=f.root+'/.control/runtime';await fs.mkdir(d,{mode:0o700});await fs.mkdir(f.root+'/runtime',{mode:0o700});await fs.writeFile(f.root+'/runtime/example.txt','owned',{mode:0o600});
 const j={schema:1,operationId:f.q.operationId,planHash:f.q.planHash,root:f.root,id:randomUUID(),fingerprint:hash('runtime-plan'),revision:1,state:'runtime_ready',worker:null,child:null,error:null,workerHash:hash('// worker')};
 await fs.writeFile(d+'/worker.mjs','// worker',{mode:0o600});
 const inventory=JSON.stringify(signed({schema:1,operationId:f.q.operationId,runtimeId:j.id,items:await f.api.runtimeInventory(f.q)},f.q));j.inventoryHash=hash(inventory);j.inventoryCount=2;
 await fs.writeFile(d+'/inventory.json',inventory,{mode:0o600});await fs.writeFile(d+'/journal.json',JSON.stringify(signed(j,f.q)),{mode:0o600});return j;
}
test('runtime program pins original owner-controller semantics',()=>{assert.throws(()=>runtimeProgram(controller+' ',extension),/PROGRAM_REVIEW/);assert.throws(()=>runtimeProgram(controller,'x'.repeat(50001)),/PROGRAM_REVIEW/);});
test('readonly status creates no runtime directory or initialization claim',async t=>{const f=await fixture(t),v=await f.call('runtime_status');assert.equal(v.state,'not_started');assert(!v.initialization&&!v.hostStarted);await assert.rejects(fs.stat(f.root+'/runtime'),{code:'ENOENT'});await assert.rejects(fs.stat(f.root+'/.control/runtime'),{code:'ENOENT'});});
test('arbitrary command and package parameters rejected',async t=>{const f=await fixture(t);await assert.rejects(f.api.runtimeControl({...f.q,action:'runtime_start',fingerprint:hash('plan'),command:'touch user'}),/ARGUMENTS/);await assert.rejects(f.call('npm_install'),/ARGUMENTS/);});
test('wrong source proof cannot read runtime state',async t=>{const f=await fixture(t);await assert.rejects(f.api.runtimeControl({...f.q,proof:'0'.repeat(64),action:'runtime_status'}),/OWNER_REVIEW/);});
test('source drift rejects even a signed runtime',async t=>{const f=await fixture(t);await installed(f);await fs.appendFile(f.root+'/plugin/package.json',' ');await assert.rejects(f.call('runtime_status'),/RUNTIME_SOURCE_CHANGED/);});
test('non-Linux runtime plans are blocked rather than using daily state', {skip:process.platform==='linux'},async t=>{const f=await fixture(t);await assert.rejects(f.call('runtime_preview'),/RUNTIME_PLATFORM_UNSUPPORTED/);});
test('npm environment is complete and excludes inherited credential/config',async t=>{const f=await fixture(t);process.env.TEST_SECRET='DO_NOT_FORWARD';const e=f.api.runtimeEnv(f.q);assert(!('TEST_SECRET' in e));assert(e.HOME.startsWith(f.root+'/runtime/'));assert(e.NPM_CONFIG_CACHE.startsWith(f.root+'/runtime/'));assert.notEqual(e.NPM_CONFIG_USERCONFIG,e.NPM_CONFIG_GLOBALCONFIG);assert(!e.NODE_OPTIONS&&!e.SSH_AUTH_SOCK);delete process.env.TEST_SECRET;});
test('runtime receipt survives module reload without claiming Host activation',async t=>{const f=await fixture(t);await installed(f);const v=await f.call('runtime_status');assert.equal(v.state,'runtime_ready');assert(v.runtimeInstalled&&!v.initialization&&!v.hostStarted&&!v.workerActive);assert(!JSON.stringify(v).includes(f.q.proof));});
test('a departed native Host is not reported ready and private access URL is omitted',async t=>{const f=await fixture(t),j=await installed(f);j.state='host_ready';j.nativeReceipt={url:'PRIVATE_ACCESS_SENTINEL',rows:[],modelAttempts:0};await fs.writeFile(f.root+'/.control/runtime/journal.json',JSON.stringify(signed(j,f.q)));const v=await f.call('runtime_status');assert.equal(v.state,'host_stopped');assert(!v.nativeHostReady&&!v.hostStarted&&v.runtimeInstalled);assert(!JSON.stringify(v).includes('PRIVATE_ACCESS_SENTINEL'));});
test('live native Host kernel identity blocks rollback even after worker ended',{skip:process.platform!=='linux'},async t=>{const f=await fixture(t),j=await installed(f);j.host=await stamp(process.pid);j.state='host_ready';await fs.writeFile(f.root+'/.control/runtime/journal.json',JSON.stringify(signed(j,f.q)));const v=await f.call('runtime_status');assert(v.hostStarted&&v.hostActive&&!v.nativeHostReady);await assert.rejects(f.call('runtime_rollback'),/RUNTIME_PROCESS_ACTIVE/);assert(await fs.stat(f.root+'/runtime/example.txt'));});
test('rollback deletes exact manifest and preserves prepared source and siblings',async t=>{const f=await fixture(t);await installed(f);assert.equal((await f.call('runtime_rollback')).state,'rolled_back');assert(await fs.stat(f.root+'/plugin/package.json'));await assert.rejects(fs.stat(f.root+'/runtime'),{code:'ENOENT'});assert.equal(await fs.readFile(f.dir+'/USER_KEEP','utf8'),'preserved');assert.equal((await remoteControl({...f.q,action:'rollback'})).state,'rolled_back');});
for(const kind of ['extra-file','edit','mode','symlink'])test('rollback fails before deletion for '+kind,async t=>{const f=await fixture(t);await installed(f);const p=f.root+'/runtime/example.txt';if(kind==='extra-file')await fs.writeFile(f.root+'/runtime/user.txt','KEEP');if(kind==='edit')await fs.appendFile(p,'USER');if(kind==='mode')await fs.chmod(p,0o640);if(kind==='symlink'){await fs.unlink(p);await fs.symlink(f.dir+'/USER_KEEP',p);}await assert.rejects(f.call('runtime_rollback'),/RUNTIME_ROLLBACK_DRIFT|RUNTIME_LINK_REVIEW/);assert(await fs.lstat(p));assert.equal(await fs.readFile(f.dir+'/USER_KEEP','utf8'),'preserved');});
test('runtime control-directory symlink is not followed',async t=>{const f=await fixture(t);await fs.mkdir(f.dir+'/outside');await fs.symlink(f.dir+'/outside',f.root+'/.control/runtime');await assert.rejects(f.call('runtime_status'),/UNSAFE_PATH/);assert.deepEqual(await fs.readdir(f.dir+'/outside'),[]);});
test('unknown remote outcome is not mistaken for completed rollback',async t=>{const f=await fixture(t);await assert.rejects(f.call('runtime_rollback'),/RUNTIME_STATE_UNKNOWN/);});
test('Linux readonly runtime plan pins public lock without creating cache or HOME',{skip:process.platform!=='linux'},async t=>{const f=await fixture(t),p=await f.call('runtime_preview');assert.equal(p.registry,'https://registry.npmjs.org');assert.equal(p.hostVersion,'0.2.1-rc.2');assert(!p.lifecycleScripts&&!p.modelEnabled&&!p.imEnabled&&!p.hostStarted);assert.match(p.fingerprint,/^[a-f0-9]{64}$/);await assert.rejects(fs.stat(f.root+'/runtime'),{code:'ENOENT'});});
test('unregistered worker cannot mark an existing runtime failed',async t=>{const f=await fixture(t);await installed(f);const before=await fs.readFile(f.root+'/.control/runtime/journal.json'),script=f.dir+'/unauthorized-worker.mjs';await fs.writeFile(script,runtimeProgram(controller,extension)+'\nawait runtimeWorkerCLI();');await runProcess(process.execPath,[script],{input:JSON.stringify({...f.q,action:'runtime_start',fingerprint:hash('runtime-plan')}),env:{PATH:process.env.PATH}});assert.deepEqual(await fs.readFile(f.root+'/.control/runtime/journal.json'),before);});
async function absent(f,member){const script=f.dir+'/absence.mjs';await fs.writeFile(script,runtimeAbsenceProgram(controller)+'\nawait runtimeAbsenceCLI();');const prior={operationId:f.q.operationId,runtimeId:randomUUID(),state:'runtime_ready',workerActive:false,childActive:false,inventoryCount:2,worker:member,child:member};return JSON.parse(await runProcess(process.execPath,[script],{input:JSON.stringify({...f.q,prior}),env:{PATH:process.env.PATH}}));}
async function stamp(pid){const stat=await fs.readFile('/proc/'+pid+'/stat','utf8');return {pid,platform:'linux',start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19],boot:(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim()};}
test('absence reconciliation checks live process identity, not old receipt flags',{skip:process.platform!=='linux'},async t=>{const f=await fixture(t),r=await absent(f,await stamp(process.pid));assert(!r.ok);assert.match(r.error,/RUNTIME_PROCESS_ACTIVE/);});
test('absence reconciliation proves ended worker identity and never removes source',{skip:process.platform!=='linux'},async t=>{const f=await fixture(t),child=spawn(process.execPath,['-e',"process.send('ready');setTimeout(()=>{},30000)"],{stdio:['ignore','ignore','ignore','ipc'],env:{PATH:process.env.PATH}});t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();});await new Promise(r=>child.once('message',r));const member=await stamp(child.pid),exit=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exit;const r=await absent(f,member);assert(r.ok&&r.value.reconciledAfterLostReceipt&&r.value.installerProcessesEnded);assert.equal(r.value.state,'rolled_back');assert(await fs.stat(f.root+'/plugin/package.json'));});

async function restartable(f){
 const j=await installed(f),dir=f.root+'/.control/runtime';
 await fs.mkdir(f.root+'/runtime/native-home/dsh/profiles/web',{recursive:true});await fs.mkdir(f.root+'/runtime/workspace');
 const patch=f.root+'/runtime/native-home/dsh/profiles/web/cordis.patch.yml';await fs.writeFile(patch,'KEEP_DEFAULT_PROFILE',{mode:0o600});
 j.defaultConfig={path:patch,sha256:hash('KEEP_DEFAULT_PROFILE'),preserved:true};j.host={pid:999999999,platform:'linux',start:'0',boot:randomUUID()};j.state='host_ready';j.nativeReceipt={ok:true,hostVersion:'0.2.1-rc.2',rows:[],modelAttempts:0};
 const inv=JSON.stringify(signed({schema:1,operationId:f.q.operationId,runtimeId:j.id,items:await f.api.runtimeInventory(f.q)},f.q));await fs.writeFile(dir+'/inventory.json',inv);j.inventoryHash=hash(inv);j.inventoryCount=JSON.parse(inv).items.length;
 const worker=runtimeProgram(controller,extension)+'\nawait runtimeWorkerCLI();';await fs.writeFile(dir+'/worker.mjs',worker);j.workerHash=hash(worker);
 await fs.writeFile(dir+'/journal.json',JSON.stringify(signed(j,f.q)));return j;
}
const linux={skip:process.platform!=='linux'};
test('Host restart preview is read-only, preserves user data and never adopts deletion ownership',linux,async t=>{
 const f=await fixture(t),j=await restartable(f);await fs.writeFile(f.root+'/runtime/workspace/user.txt','KEEP_USER');
 const before=await fs.readFile(f.root+'/.control/runtime/inventory.json'),p=await f.call('runtime_restart_preview');assert(p.fingerprint&&p.defaultConfigPreserved&&!p.reinstall&&!p.hostStarted);assert.equal(p.preservedMutableChanges,1);assert(!JSON.stringify(p).includes('KEEP_DEFAULT_PROFILE'));
 await assert.rejects(fs.stat(f.root+'/.control/runtime/restarts'),{code:'ENOENT'});assert.deepEqual(await fs.readFile(f.root+'/.control/runtime/inventory.json'),before);await assert.rejects(f.call('runtime_rollback'),/ROLLBACK_DRIFT/);assert.equal(await fs.readFile(f.root+'/runtime/workspace/user.txt','utf8'),'KEEP_USER');
});
test('Host restart cannot reuse an installation with immutable drift',linux,async t=>{const f=await fixture(t);await restartable(f);await fs.appendFile(f.root+'/runtime/example.txt','ALTERED');await assert.rejects(f.call('runtime_restart_preview'),/RESTART_IMMUTABLE_DRIFT/);});
test('Host restart requires a proven prior installation and stopped birth identities',linux,async t=>{const f=await fixture(t);await installed(f);await assert.rejects(f.call('runtime_restart_preview'),/RESTART_NOT_READY/);assert.equal((await f.call('runtime_status')).state,'runtime_ready');});
test('live Host and active launch controller each reject restart',linux,async t=>{for(const key of ['host','launcher']){const f=await fixture(t),j=await restartable(f),me=await stamp(process.pid);if(key==='host')j.host=me;else j.restart={id:randomUUID(),launcher:me};await fs.writeFile(f.root+'/.control/runtime/journal.json',JSON.stringify(signed(j,f.q)));await assert.rejects(f.call('runtime_restart_preview'),/PROCESS_ACTIVE/);}});
test('plan drift blocks relaunch before any control-directory creation',linux,async t=>{const f=await fixture(t),j=await restartable(f),p=await f.call('runtime_restart_preview');await fs.appendFile(j.defaultConfig.path,'USER_EDIT');await assert.rejects(f.api.runtimeControl({...f.q,action:'runtime_restart',acknowledgeNativeResume:true,fingerprint:p.fingerprint}),/PLAN_DRIFT/);await assert.rejects(fs.stat(f.root+'/.control/runtime/restarts'),{code:'ENOENT'});});
test('detached restart worker is birth-authorized, failures durable, duplicate request not resent',linux,async t=>{
 const f=await fixture(t);await restartable(f);const p=await f.call('runtime_restart_preview'),request={...f.q,action:'runtime_restart',acknowledgeNativeResume:true,fingerprint:p.fingerprint};let v=await f.api.runtimeControl(request);
 assert(v.restartId&&v.restartFingerprint===p.fingerprint);const id=v.restartId;
 try{for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,50));v=await f.call('runtime_status');if(!v.workerActive)break;}
 assert(!v.workerActive);assert.equal(v.state,'failed');assert.equal(v.error,'ONBOARDING_CLOUD_NATIVE_ADMISSION_FAILED');assert.equal(v.restartState,'failed');const duplicate=await f.api.runtimeControl(request);assert(duplicate.notResent&&duplicate.restartId===id);assert.equal((await fs.readdir(f.root+'/.control/runtime/restarts')).length,1);
 assert.equal((await f.call('runtime_rollback')).state,'rolled_back');
 }finally{if(v.workerActive){const p=await f.call('runtime_stop_preview');await f.api.runtimeControl({...f.q,action:'runtime_stop',stopPlan:p.stopPlan});for(let i=0;i<100;i++){if(!(await f.call('runtime_status')).workerActive)break;await new Promise(r=>setTimeout(r,50));}}}
});
test('unknown restart control file preserves all payload before rollback',async t=>{const f=await fixture(t),j=await installed(f),id=randomUUID();j.restart={id};await fs.writeFile(f.root+'/.control/runtime/journal.json',JSON.stringify(signed(j,f.q)));await fs.mkdir(f.root+'/.control/runtime/restarts',{mode:0o700});await fs.mkdir(f.root+'/.control/runtime/restarts/'+id,{mode:0o700});await fs.writeFile(f.root+'/.control/runtime/restarts/'+id+'/USER.txt','KEEP',{mode:0o600});await assert.rejects(f.call('runtime_rollback'),/RESTART_CONTROL_REVIEW/);assert.equal(await fs.readFile(f.root+'/runtime/example.txt','utf8'),'owned');});

test('abrupt restart interruption is visible and needs explicit quiescent reconciliation',linux,async t=>{const f=await fixture(t),j=await restartable(f),id=randomUUID();j.state='restarting';j.restart={id,fingerprint:hash('interrupted'),state:'requested',launcher:null};await fs.mkdir(f.root+'/.control/runtime/restarts',{mode:0o700});await fs.mkdir(f.root+'/.control/runtime/restarts/'+id,{mode:0o700});for(const [key,p] of [['parentIdentity',f.root+'/.control/runtime/restarts'],['controlIdentity',f.root+'/.control/runtime/restarts/'+id]]){const st=await fs.lstat(p);j.restart[key]={dev:st.dev,ino:st.ino,uid:st.uid,mode:st.mode&0o777};}await fs.writeFile(f.root+'/.control/runtime/journal.json',JSON.stringify(signed(j,f.q)));assert.equal((await f.call('runtime_status')).state,'restart_needs_review');await assert.rejects(f.call('runtime_restart_preview'),/RESTART_REVIEW/);await assert.rejects(f.api.runtimeControl({...f.q,action:'runtime_reconcile_restart',fingerprint:hash('wrong')}),/RESTART_REVIEW/);const before=await fs.readFile(f.root+'/.control/runtime/inventory.json'),v=await f.api.runtimeControl({...f.q,action:'runtime_reconcile_restart',fingerprint:j.restart.fingerprint});assert.equal(v.state,'failed');assert.equal(v.restartState,'interrupted');assert.deepEqual(await fs.readFile(f.root+'/.control/runtime/inventory.json'),before);assert((await f.call('runtime_restart_preview')).fingerprint);});

test('an unrecorded empty restart directory is not adopted or removed',async t=>{const f=await fixture(t);await installed(f);await fs.mkdir(f.root+'/.control/runtime/restarts',{mode:0o700});await assert.rejects(f.call('runtime_rollback'),/RESTART_CONTROL_REVIEW/);assert(await fs.stat(f.root+'/runtime/example.txt'));assert(await fs.stat(f.root+'/.control/runtime/restarts'));});

async function admissionFixture(t){
 const f=await fixture(t),j=await installed(f);
 for(const p of ['runtime/native-home/dsh/sessions/project','runtime/native-home/dsh/storages/session_projcache/sessions'])await fs.mkdir(path.join(f.root,p),{recursive:true,mode:0o700});
 const data=JSON.stringify(signed({schema:1,operationId:f.q.operationId,runtimeId:j.id,items:await f.api.runtimeInventory(f.q)},f.q));j.inventoryHash=hash(data);await fs.writeFile(f.root+'/.control/runtime/inventory.json',data);await fs.writeFile(f.root+'/.control/runtime/journal.json',JSON.stringify(signed(j,f.q)));return {...f,j};
}
async function admissionFiles(f,nonce){
 for(const preset of ['standard','ptc','cordis','minimal']){
  const id='onboarding-check-'+nonce+'-'+preset,dir=f.root+'/runtime/native-home/dsh/sessions/project/'+id;await fs.mkdir(dir,{mode:0o700});
  for(const name of ['session.lock','session.v4.jsonl.zstd'])await fs.writeFile(dir+'/'+name,'own zero-model fixture',{mode:0o600});
  await fs.writeFile(f.root+'/runtime/native-home/dsh/storages/session_projcache/sessions/'+id+'.json','{}',{mode:0o600});
 }
}
async function registerAdmission(f){
 const {j}=f,before=await f.api.runtimeInventory(f.q),nonce=randomUUID(),id=randomUUID(),parent=f.root+'/.control/runtime/restarts',dir=parent+'/'+id;
 if(j.restart)(j.restartHistory??=[]).push(j.restart);
 await fs.mkdir(parent,{recursive:true,mode:0o700});await fs.mkdir(dir,{mode:0o700});const identity=p=>fs.lstat(p).then(s=>({dev:s.dev,ino:s.ino,uid:s.uid,mode:s.mode&0o777}));
 j.restart={id,nonce,parentIdentity:await identity(parent),controlIdentity:await identity(dir)};j.host=null;j.nativeReceipt={ok:true,nonce,rows:Array.from({length:4},()=>({valid:true,idle:true})),modelAttempts:0};
 await admissionFiles(f,nonce);await f.api.runtimeRegisterAdmission(f.q,j,before);return {id,nonce,before};
}
test('registered native admission delta allows exact rollback without changing original inventory',async t=>{
 const f=await admissionFixture(t),original=await fs.readFile(f.root+'/.control/runtime/inventory.json');await registerAdmission(f);
 assert.equal(f.j.restart.admissionInventoryCount,16);assert.deepEqual(await fs.readFile(f.root+'/.control/runtime/inventory.json'),original);
 assert.equal((await f.call('runtime_rollback')).state,'rolled_back');assert.equal(await fs.readFile(f.dir+'/USER_KEEP','utf8'),'preserved');
});
test('successive admission generations each retain independent signed ownership',async t=>{const f=await admissionFixture(t);await registerAdmission(f);await registerAdmission(f);assert.equal(f.j.restartHistory.length,1);assert.equal((await f.call('runtime_rollback')).state,'rolled_back');});
test('a lookalike session without a recorded launch delta is never adopted',async t=>{const f=await admissionFixture(t);await admissionFiles(f,randomUUID());await assert.rejects(f.call('runtime_rollback'),/ROLLBACK_DRIFT/);assert(await fs.stat(f.root+'/runtime/example.txt'));});
for(const change of ['user-file','edited-admission','ledger-edit','unknown-admission-child'])test('admission cleanup preserves changes: '+change,async t=>{
 const f=await admissionFixture(t),{id,nonce}=await registerAdmission(f),d=f.root+'/runtime/native-home/dsh/sessions/project/onboarding-check-'+nonce+'-standard';
 if(change==='user-file')await fs.writeFile(f.root+'/runtime/workspace-user.txt','KEEP');
 if(change==='edited-admission')await fs.appendFile(d+'/session.v4.jsonl.zstd','USER');
 if(change==='ledger-edit')await fs.appendFile(f.root+'/.control/runtime/restarts/'+id+'/admission-inventory.json',' ');
 if(change==='unknown-admission-child')await fs.writeFile(d+'/user.txt','KEEP');
 await assert.rejects(f.call('runtime_rollback'),/ROLLBACK_DRIFT|ADMISSION_OWNERSHIP_REVIEW/);assert(await fs.stat(f.root+'/runtime/example.txt'));
});
test('an admission cannot claim pre-existing files or unrecognized new nonce files',async t=>{
 const f=await admissionFixture(t),before=await f.api.runtimeInventory(f.q),nonce=randomUUID();await admissionFiles(f,nonce);const after=await f.api.runtimeInventory(f.q);
 assert.throws(()=>runtimeAdmissionDelta(after,after,nonce),/OWNERSHIP_REVIEW/);
 await fs.writeFile(f.root+'/runtime/native-home/dsh/sessions/project/onboarding-check-'+nonce+'-standard/user.txt','KEEP');
 const extra=await f.api.runtimeInventory(f.q);assert.throws(()=>runtimeAdmissionDelta(before,extra,nonce),/OWNERSHIP_REVIEW/);
});
test('a valid new admission never adopts a pre-existing user workspace file',async t=>{const f=await admissionFixture(t);await fs.writeFile(f.root+'/runtime/KEEP_USER.txt','KEEP');await registerAdmission(f);await assert.rejects(f.call('runtime_rollback'),/ROLLBACK_DRIFT/);assert.equal(await fs.readFile(f.root+'/runtime/KEEP_USER.txt','utf8'),'KEEP');});
test('a ledger created without a durable registration is retained for review',async t=>{const f=await admissionFixture(t),{id}=await registerAdmission(f);delete f.j.restart.admissionInventoryHash;delete f.j.restart.admissionInventoryCount;await fs.writeFile(f.root+'/.control/runtime/journal.json',JSON.stringify(signed(f.j,f.q)));await assert.rejects(f.call('runtime_rollback'),/ROLLBACK_DRIFT/);assert(await fs.stat(f.root+'/.control/runtime/restarts/'+id+'/admission-inventory.json'));});

async function resumeCleanup(f,io={}){const view=await f.call('runtime_status');assert.equal(view.state,'cleanup_pending');return f.api.runtimeControl({...f.q,action:'runtime_rollback_resume',fingerprint:view.cleanupFingerprint},{...(process.platform==='linux'?{}:{lock:async(q,fn)=>fn()}),...io});}
for(const cut of ['prepared','payload-intent','payload-item','controls-phase','controls-item','finalizing-phase','plan-removed'])test('durable cleanup resumes after '+cut,async t=>{
 const f=await fixture(t);await installed(f);let hit=false;const stop=()=>{hit=true;throw Error('test-cut');};
 const io={afterCleanupPrepared:cut==='prepared'?stop:undefined,afterCleanupIntent:(phase)=>{if(cut==='payload-intent'&&phase==='payload')stop();},afterCleanupItem:(phase)=>{if(cut===phase+'-item')stop();},afterCleanupPhase:phase=>{if(cut===phase+'-phase')stop();},afterCleanupPlanRemoval:cut==='plan-removed'?stop:undefined};
 await assert.rejects(f.call('runtime_rollback',io),/test-cut/);assert(hit);
 const before=await fs.readFile(f.root+'/.control/runtime-cleanup.json');const state=await f.call('runtime_status');assert.equal(state.state,'cleanup_pending');assert.deepEqual(await fs.readFile(f.root+'/.control/runtime-cleanup.json'),before,'status must not resume or rewrite');
 await assert.rejects(f.call('runtime_rollback'),/CLEANUP_RECOVERY_REQUIRED/);
 assert.equal((await resumeCleanup(f)).state,'rolled_back');for(const name of ['runtime','.control/runtime','.control/runtime-cleanup.json','.control/runtime-cleanup-plan.json'])await assert.rejects(fs.stat(f.root+'/'+name),{code:'ENOENT'});
 assert.equal(await fs.readFile(f.dir+'/USER_KEEP','utf8'),'preserved');assert.equal((await remoteControl({...f.q,action:'rollback'})).state,'rolled_back');
});
for(const change of ['unknown','edited','replaced','missing-progress','missing-plan','bad-progress','bad-plan'])test('interrupted cleanup refuses '+change+' without deleting more',async t=>{
 const f=await fixture(t);await installed(f);await assert.rejects(f.call('runtime_rollback',{afterCleanupIntent:()=>{throw Error('cut');}}),/cut/);
 if(change==='unknown')await fs.writeFile(f.root+'/runtime/USER.txt','KEEP');
 if(change==='edited')await fs.appendFile(f.root+'/runtime/example.txt','KEEP');
 if(change==='replaced'){await fs.rename(f.root+'/runtime/example.txt',f.dir+'/old-owned');await fs.writeFile(f.root+'/runtime/example.txt','owned');}
 if(change==='missing-progress')await fs.unlink(f.root+'/.control/runtime-cleanup.json');
 if(change==='missing-plan')await fs.unlink(f.root+'/.control/runtime-cleanup-plan.json');
 if(change==='bad-progress')await fs.appendFile(f.root+'/.control/runtime-cleanup.json','INVALID');
 if(change==='bad-plan')await fs.appendFile(f.root+'/.control/runtime-cleanup-plan.json','INVALID');
 await assert.rejects(resumeCleanup(f));assert(await fs.stat(f.root+'/runtime/example.txt'));assert.equal(await fs.readFile(f.dir+'/USER_KEEP','utf8'),'preserved');
});
test('resume requires the current signed progress fingerprint',async t=>{const f=await fixture(t);await installed(f);await assert.rejects(f.call('runtime_rollback',{afterCleanupPrepared:()=>{throw Error('cut');}}));await assert.rejects(f.api.runtimeControl({...f.q,action:'runtime_rollback_resume',fingerprint:hash('stale')},{lock:async(q,fn)=>fn()}),/CLEANUP_PLAN_DRIFT/);assert(await fs.stat(f.root+'/runtime/example.txt'));});
test('a committed deleted file cannot be resurrected during later cleanup',async t=>{const f=await fixture(t);await installed(f);await assert.rejects(f.call('runtime_rollback',{afterCleanupPhase:phase=>{if(phase==='controls')throw Error('cut');}}));await fs.mkdir(f.root+'/runtime');await fs.writeFile(f.root+'/runtime/USER.txt','KEEP');await assert.rejects(resumeCleanup(f),/CLEANUP_DRIFT/);assert.equal(await fs.readFile(f.root+'/runtime/USER.txt','utf8'),'KEEP');});
test('kernel lock excludes a second mutation while first cleanup is live',linux,async t=>{
 const f=await fixture(t);await installed(f);let enter,release;const reached=new Promise(r=>enter=r),gate=new Promise(r=>release=r);let once=false;
 const running=f.call('runtime_rollback',{afterCleanupIntent:async()=>{if(!once){once=true;enter();await gate;}}});await reached;
 try{assert.equal((await f.call('runtime_status')).state,'cleanup_running');await assert.rejects(f.call('runtime_rollback'),/RUNTIME_CONTROL_BUSY/);}finally{release();}
 assert.equal((await running).state,'rolled_back');
});
for(const cut of ['payload','controls','plan'])test('real SIGKILL releases lock and resumes '+cut+' cleanup',linux,async t=>{
 const f=await fixture(t);await installed(f);const script=f.dir+'/kill-cleanup.mjs';
 const hook=cut==='plan'?"afterCleanupPlanRemoval: async()=>hold()":"afterCleanupItem: async(phase,i)=>{if(phase==="+JSON.stringify(cut)+"&&i===0)await hold();}";
 await fs.writeFile(script,runtimeProgram(controller,extension)+`\nlet text='';for await(const b of process.stdin)text+=b;const q=JSON.parse(text);const hold=async()=>{process.send('cut');await new Promise(()=>{setInterval(()=>{},1000);});};await runtimeControl(q,{${hook}});`);
 const child=spawn(process.execPath,[script],{stdio:['pipe','ignore','pipe','ipc'],env:{PATH:process.env.PATH}});child.stderr.resume();t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 const reached=new Promise((resolve,reject)=>{child.once('message',resolve);child.once('exit',()=>reject(Error('controller exited before cut')));child.once('error',reject);});child.stdin.end(JSON.stringify({...f.q,action:'runtime_rollback'}));await reached;
 assert.equal((await f.call('runtime_status')).state,'cleanup_running');const exit=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await exit;
 assert.equal((await resumeCleanup(f)).state,'rolled_back');assert.equal(await fs.readFile(f.dir+'/USER_KEEP','utf8'),'preserved');
});

test('runtime status rechecks a stale restarting journal after observing a dead worker',linux,async t=>{
 const f=await fixture(t),j=await installed(f);j.state='restarting';j.restart={id:randomUUID(),state:'requested'};
 const stale=structuredClone(j);j.revision++;j.state='failed';j.error='ONBOARDING_CLOUD_NATIVE_ADMISSION_FAILED';j.restart.state='failed';
 await fs.writeFile(f.root+'/.control/runtime/journal.json',JSON.stringify(signed(j,f.q)));
 const v=await f.api.runtimeView(f.q,stale);assert.equal(v.state,'failed');assert.equal(v.error,j.error);assert.equal(v.revision,j.revision);
});
test('optional IM is bound to the preview fingerprint and has no binding or credential side effect',linux,async t=>{
 const f=await fixture(t),base=await f.call('runtime_preview'),im=await f.api.runtimeControl({...f.q,action:'runtime_preview',im:true});
 assert.equal(base.optionalIm,null);assert.equal(im.optionalIm.package,'@xmanrui/dsh-im');assert.equal(im.optionalIm.version,'5.0.3');assert(!im.optionalIm.botConnection&&!im.optionalIm.credentialTransfer&&!im.imEnabled);assert.notEqual(im.fingerprint,base.fingerprint);
 await assert.rejects(f.api.runtimeControl({...f.q,action:'runtime_start',im:false,fingerprint:im.fingerprint}),/PLAN_DRIFT/);
 await assert.rejects(fs.stat(f.root+'/runtime'),{code:'ENOENT'});await assert.rejects(fs.stat(f.root+'/.control/runtime'),{code:'ENOENT'});
});
test('optional IM flag never accepts arbitrary package input or mutates an existing runtime',async t=>{
 const f=await fixture(t);for(const q of [{action:'runtime_preview',im:'true'},{action:'runtime_preview',im:true,package:'evil'},{action:'runtime_restart_preview',im:true},{action:'runtime_status',im:true}])await assert.rejects(f.api.runtimeControl({...f.q,...q}),/ARGUMENTS/);
});

async function stopWorker(t,f,{asHost=false}={}){
 const marker=f.dir+'/signals.txt';const script=`const fs=require('fs');process.on('SIGTERM',()=>fs.appendFileSync(${JSON.stringify(marker)},'term\\n'));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));setInterval(()=>{},1000);console.log('ready');`;
 const worker=spawn(process.execPath,['-e',script],{detached:true,stdio:['pipe','pipe','ignore']});await new Promise((resolve,reject)=>{worker.stdout.once('data',resolve);worker.once('error',reject);});
 t.after(async()=>{if(worker.exitCode===null){const ended=new Promise(r=>worker.once('exit',r));worker.stdin.end();await ended;}});
 const j=await installed(f),identity=await stamp(worker.pid);j.state=asHost?'host_ready':'installing';j[asHost?'host':'worker']=identity;await fs.writeFile(f.root+'/.control/runtime/journal.json',JSON.stringify(signed(j,f.q)));
 return {worker,j,marker,async signals(){return (await fs.readFile(marker,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;})).split('\n').filter(Boolean).length;},async end(){const done=new Promise(r=>worker.once('exit',r));worker.stdin.end();await done;}};
}
const stopApply=(f,p,io={})=>f.api.runtimeControl({...f.q,action:'runtime_stop',stopPlan:p.stopPlan},io);
const stopReconcile=(f,p)=>f.api.runtimeControl({...f.q,action:'runtime_stop_reconcile',stopPlan:p.stopPlan});
async function eventual(fn){for(let n=0;n<100;n++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('original process did not reach expected state');}
test('stop has no legacy PID-only entry and refuses an active native Host before persisting or signalling',linux,async t=>{
 const f=await fixture(t),w=await stopWorker(t,f,{asHost:true}),before=await fs.readdir(f.root+'/.control/runtime');
 const p=await f.call('runtime_stop_preview');assert.equal(p.reason,'host_observation_required');assert(!p.canApply&&!p.hostStopAuthorized);assert.deepEqual(await fs.readdir(f.root+'/.control/runtime'),before);
 await assert.rejects(f.call('runtime_stop'),/ARGUMENTS/);await assert.rejects(f.api.runtimeControl({...f.q,action:'runtime_stop',stopPlan:p.stopPlan,acknowledgeNativeInterruption:true}),/STOP_NOT_READY/);assert.equal(await w.signals(),0);assert.equal((await f.call('runtime_status')).hostActive,true);await assert.rejects(fs.stat(f.root+'/.control/runtime/stop.json'),{code:'ENOENT'});
});
test('signed installer stop is explicit, durable, non-replayed, and reconciled only after original processes end',linux,async t=>{
 const f=await fixture(t),w=await stopWorker(t,f),p=await f.call('runtime_stop_preview');assert(p.canApply);assert.equal(p.scope,'installer_processes_only');
 let intentSeen=false;const v=await stopApply(f,p,{afterStopIntent:async()=>{const d=JSON.parse(await fs.readFile(f.root+'/.control/runtime/stop.json','utf8'));assert.equal(d.records[0].phase,'requested');assert.equal(await w.signals(),0);intentSeen=true;}});assert(intentSeen);assert.equal(v.stop.phase,'signalled');await eventual(async()=>await w.signals()===1);
 assert((await stopApply(f,p)).notResent);await new Promise(r=>setTimeout(r,30));assert.equal(await w.signals(),1);
 await assert.rejects(stopReconcile(f,p),/STILL_ACTIVE/);const next=await f.call('runtime_stop_preview');assert.equal(next.reason,'prior_stop_unresolved');
 await w.end();assert.equal((await f.call('runtime_status')).stop.reconcileRequired,true);const done=await stopReconcile(f,p);assert.equal(done.stop.phase,'ended');assert(!done.stop.reconcileRequired);assert.equal(done.stop.hostStopAuthorized,false);assert((await stopApply(f,p)).notResent);
 assert.equal((await f.call('runtime_rollback')).state,'rolled_back');
});
test('tampered, expired or stale installer stop plans do not signal a process',linux,async t=>{
 const f=await fixture(t),w=await stopWorker(t,f),p=await f.call('runtime_stop_preview');
 await assert.rejects(stopApply(f,{stopPlan:{...p.stopPlan,id:randomUUID()}}),/JOURNAL_REVIEW/);
 const {signature,...expired}=p.stopPlan;expired.createdAt=Date.now()-300001;expired.expiresAt=expired.createdAt+300000;await assert.rejects(stopApply(f,{stopPlan:signed(expired,f.q)}),/PLAN_EXPIRED/);
 const j={...w.j,revision:w.j.revision+1};await fs.writeFile(f.root+'/.control/runtime/journal.json',JSON.stringify(signed(j,f.q)));await assert.rejects(stopApply(f,p),/PLAN_DRIFT/);assert.equal(await w.signals(),0);await assert.rejects(fs.stat(f.root+'/.control/runtime/stop.json'),{code:'ENOENT'});
});
test('a Host that appears after the durable stop intent is preserved and the stop is not resent',linux,async t=>{
 const f=await fixture(t),w=await stopWorker(t,f),p=await f.call('runtime_stop_preview');
 await assert.rejects(stopApply(f,p,{afterStopIntent:async()=>{await fs.writeFile(f.root+'/.control/runtime/journal.json',JSON.stringify(signed({...w.j,host:await stamp(w.worker.pid)},f.q)));}}),/HOST_DRAIN_REQUIRED/);
 assert.equal(await w.signals(),0);const v=await f.call('runtime_status');assert.equal(v.stop.phase,'needs_review');assert(v.hostActive);assert((await stopApply(f,p)).notResent);assert.equal(await w.signals(),0);
});
test('controller crash after durable intent is observable and cannot silently resend a stop',linux,async t=>{
 const f=await fixture(t),w=await stopWorker(t,f),p=await f.call('runtime_stop_preview');
 const code=`const m=await import(${JSON.stringify(pathToFileURL(f.dir+'/extension.mjs').href)});await m.runtimeControl(${JSON.stringify({...f.q,action:'runtime_stop',stopPlan:p.stopPlan})},{afterStopIntent:()=>process.kill(process.pid,'SIGKILL')});`;
 const proc=spawn(process.execPath,['--input-type=module','-e',code],{stdio:'ignore'});const outcome=await new Promise((resolve,reject)=>{proc.once('error',reject);proc.once('exit',(code,signal)=>resolve({code,signal}));});assert.equal(outcome.signal,'SIGKILL');
 const observed=await f.call('runtime_status');assert.equal(observed.stop.phase,'requested');assert.equal(await w.signals(),0);assert((await stopApply(f,p)).notResent);assert.equal(await w.signals(),0);await assert.rejects(stopReconcile(f,p),/STILL_ACTIVE/);
 await w.end();assert.equal((await stopReconcile(f,p)).stop.phase,'ended');
});
test('unknown or altered stop control metadata prevents rollback without adopting it',async t=>{
 const f=await fixture(t);await installed(f);await fs.writeFile(f.root+'/.control/runtime/stop.json',JSON.stringify({foreign:'KEEP'}),{mode:0o600});
 await assert.rejects(f.call('runtime_status'),/JOURNAL_REVIEW/);await assert.rejects(f.call('runtime_rollback'),/JOURNAL_REVIEW/);assert.equal(await fs.readFile(f.root+'/runtime/example.txt','utf8'),'owned');assert.equal(JSON.parse(await fs.readFile(f.root+'/.control/runtime/stop.json','utf8')).foreign,'KEEP');
});
test('restart plan reports preserved unknown configuration instead of promising disabled IM or model',linux,async t=>{
 const f=await fixture(t);await restartable(f);const before=await fs.readFile(f.root+'/.control/runtime/journal.json'),p=await f.call('runtime_restart_preview');assert.equal(p.resumePolicy.contract,1);assert(p.resumePolicy.imMayReconnect&&p.resumePolicy.nativeWorkMayResume&&p.resumePolicy.requiresExplicitAcknowledgement);assert(!p.resumePolicy.automaticTaskApproval&&!p.resumePolicy.automaticRetry);assert(!Object.hasOwn(p,'modelEnabled'));assert(!Object.hasOwn(p,'imEnabled'));assert.deepEqual(await fs.readFile(f.root+'/.control/runtime/journal.json'),before);
 for(const ack of [undefined,false,'true'])await assert.rejects(f.api.runtimeControl({...f.q,action:'runtime_restart',fingerprint:p.fingerprint,...(ack===undefined?{}:{acknowledgeNativeResume:ack})}),/RESTART_CONSENT_REQUIRED/);
 assert.deepEqual(await fs.readFile(f.root+'/.control/runtime/journal.json'),before);await assert.rejects(fs.stat(f.root+'/.control/runtime/restarts'),{code:'ENOENT'});
});

async function stoppableHost(t){
 const f=await fixture(t),w=await stopWorker(t,f,{asHost:true});
 const {observationServer}=await import('./helpers/host-stop-fixture.mjs');
 const server=await observationServer(t,f.root,w.j);
 await fs.cp(f.root+'/plugin',f.root+'/runtime/plugin',{recursive:true});
 // Initial fixture ownership is recorded only after its complete plugin is installed.
 const inv=JSON.stringify(signed({schema:1,operationId:f.q.operationId,runtimeId:w.j.id,items:await f.api.runtimeInventory(f.q)},f.q));
 await fs.writeFile(f.root+'/.control/runtime/inventory.json',inv,{mode:0o600});w.j.inventoryHash=hash(inv);
 await fs.writeFile(f.root+'/.control/runtime/journal.json',JSON.stringify(signed(w.j,f.q)));
 return {...f,w,...server};
}
const hostStop=(f,p,ack=true,io={})=>f.api.runtimeControl({...f.q,action:'runtime_stop',stopPlan:p.stopPlan,acknowledgeNativeInterruption:ack},io);
test('explicit Host risk stop binds ownership, persists intent, signals once, then separately reconciles',linux,async t=>{
 const f=await stoppableHost(t),p=await f.call('runtime_stop_preview');assert(p.canApply&&p.risk.lateNativeInputMayAbort&&!p.risk.ingressFrozen);assert.equal(p.scope,'owned_host_with_loss_risk');
 await assert.rejects(hostStop(f,p,false),/CONSENT_REQUIRED/);assert.equal(await f.w.signals(),0);await assert.rejects(fs.stat(f.root+'/.control/runtime/stop.json'),{code:'ENOENT'});
 const v=await hostStop(f,p,true,{afterStopIntent:async()=>{assert.equal(await f.w.signals(),0);assert.equal(JSON.parse(await fs.readFile(f.root+'/.control/runtime/stop.json')).records[0].phase,'requested');}});assert.equal(v.stop.phase,'signalled');await eventual(async()=>await f.w.signals()===1);assert((await hostStop(f,p)).notResent);assert.equal(await f.w.signals(),1);
 await assert.rejects(stopReconcile(f,p),/STILL_ACTIVE/);await f.w.end();const done=await stopReconcile(f,p);assert.equal(done.stop.phase,'ended');assert.equal(done.stop.hostActive,false);assert.equal(await fs.readFile(f.root+'/runtime/example.txt','utf8'),'owned');
});
for(const phase of ['before_intent','after_intent'])test('Host becomes busy '+phase+' and no signal is sent',linux,async t=>{
 const f=await stoppableHost(t),p=await f.call('runtime_stop_preview');if(phase==='before_intent')f.rows.agent_hold_status.counts.running=1;
 await assert.rejects(hostStop(f,p,true,phase==='after_intent'?{afterStopIntent:()=>{f.rows.agent_hold_status.counts.pendingNextTurn=1;}}:{}),phase==='before_intent'?/PREFLIGHT_REFUSED/:/HOST_BUSY/);assert.equal(await f.w.signals(),0);
 if(phase==='after_intent'){assert.equal((await f.call('runtime_status')).stop.phase,'needs_review');assert((await hostStop(f,p)).notResent);}else await assert.rejects(fs.stat(f.root+'/.control/runtime/stop.json'),{code:'ENOENT'});
});
test('Host plugin source drift and unknown identity prevent a ready stop plan',linux,async t=>{const f=await stoppableHost(t);await fs.appendFile(f.root+'/runtime/plugin/package.json',' ');const p=await f.call('runtime_stop_preview');assert(!p.canApply);assert.equal(p.reason,'host_observation_required');assert.equal(await f.w.signals(),0);});
test('Host controller crash after intent does not replay stop after reconstruction',linux,async t=>{
 const f=await stoppableHost(t),p=await f.call('runtime_stop_preview');const q={...f.q,action:'runtime_stop',stopPlan:p.stopPlan,acknowledgeNativeInterruption:true};
 const code=`const m=await import(${JSON.stringify(pathToFileURL(f.dir+'/extension.mjs').href)});await m.runtimeControl(${JSON.stringify(q)},{afterStopIntent:()=>process.kill(process.pid,'SIGKILL')});`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:'ignore'}),end=await new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));assert.equal(end.signal,'SIGKILL');assert.equal((await f.call('runtime_status')).stop.phase,'requested');assert.equal(await f.w.signals(),0);assert((await hostStop(f,p)).notResent);assert.equal(await f.w.signals(),0);await f.w.end();assert.equal((await stopReconcile(f,p)).stop.phase,'ended');
});

// Real filesystem/controller coverage; no native Host or model is launched here.
async function repairable(f){
 const j=await installed(f),d=f.root+'/.control/runtime';await fs.cp(f.root+'/plugin',f.root+'/runtime/plugin',{recursive:true});
 await fs.mkdir(f.root+'/runtime/native-home/dsh/profiles/web',{recursive:true});await fs.mkdir(f.root+'/runtime/workspace');
 const patch=f.root+'/runtime/native-home/dsh/profiles/web/cordis.patch.yml';await fs.writeFile(patch,'USER_DEFAULT',{mode:0o600});
 j.defaultConfig={path:patch,sha256:hash('USER_DEFAULT'),preserved:true};j.state='stopped';j.nativeReceipt={ok:true,hostVersion:'0.2.1-rc.2',rows:[],modelAttempts:0};j.host=process.platform==='linux'?{pid:999999999,platform:'linux',start:'0',boot:randomUUID()}:null;
 const inv=JSON.stringify(signed({schema:1,operationId:f.q.operationId,runtimeId:j.id,items:await f.api.runtimeInventory(f.q)},f.q));j.inventoryHash=hash(inv);j.inventoryCount=JSON.parse(inv).items.length;await fs.writeFile(d+'/inventory.json',inv);await fs.writeFile(d+'/journal.json',JSON.stringify(signed(j,f.q)));
 return {j,inventory:inv,call:(action,args={})=>f.api.runtimeControl({...f.q,action,...args},{...(process.platform==='linux'?{}:{lock:async(q,fn)=>fn()})})};
}
const repairApply=p=>({repairId:p.id,fingerprint:p.fingerprint});
test('runtime repair persists plan, publishes exact ownership delta, keeps original inventory and user data',async t=>{
 const f=await fixture(t),r=await repairable(f),file=f.root+'/runtime/plugin/package.json';await fs.appendFile(file,'BROKEN');await fs.unlink(f.root+'/runtime/plugin/onboarding-install-fs.js');await fs.writeFile(f.root+'/runtime/workspace/result.txt','USER_RESULT');
 const p=await r.call('runtime_repair_preview');assert.equal(p.changes.length,2);const applied=await r.call('runtime_repair_apply',repairApply(p));assert.equal(applied.state,'repair_committed');assert(applied.repair.ownershipRebased&&!applied.hostStarted&&!applied.repair.activationVerified&&!applied.repair.versionUpgrade);
 assert.equal(await fs.readFile(f.root+'/.control/runtime/inventory.json','utf8'),r.inventory);assert.equal(await fs.readFile(file,'utf8'),await fs.readFile(f.root+'/plugin/package.json','utf8'));assert.equal(await fs.readFile(f.root+'/runtime/workspace/result.txt','utf8'),'USER_RESULT');
 const journal=JSON.parse(await fs.readFile(f.root+'/.control/runtime/plugin-maintenance.json'));assert.equal(journal.records.length,1);assert.equal(journal.records[0].delta.length,2);assert.equal((await r.call('runtime_repair_apply',repairApply(p))).notResent,true);
 if(process.platform==='linux')assert((await r.call('runtime_restart_preview')).fingerprint);
 await assert.rejects(r.call('runtime_rollback'),/ROLLBACK_DRIFT/);assert(await fs.stat(f.root+'/.control/runtime/plugin-repairs/'+p.id));
});
test('second repair chains original signed inventory without adopting unknown files',async t=>{
 const f=await fixture(t),r=await repairable(f),target=f.root+'/runtime/plugin/package.json';
 for(let n=0;n<2;n++){await fs.appendFile(target,'BROKEN');const p=await r.call('runtime_repair_preview');assert.equal((await r.call('runtime_repair_apply',repairApply(p))).state,'repair_committed');}
 assert.equal(JSON.parse(await fs.readFile(f.root+'/.control/runtime/plugin-maintenance.json')).records.length,2);
 if(process.platform==='linux')assert((await r.call('runtime_restart_preview')).fingerprint);
 await fs.writeFile(f.root+'/runtime/plugin/user.js','KEEP');await assert.rejects(r.call('runtime_repair_preview'),/OUTSIDE_DRIFT/);assert.equal(await fs.readFile(f.root+'/runtime/plugin/user.js','utf8'),'KEEP');
});
for(const drift of ['outside-file','target-link','target-hardlink','source','plan'])test('runtime repair preserves drift rather than broadening ownership: '+drift,async t=>{
 const f=await fixture(t),r=await repairable(f),target=f.root+'/runtime/plugin/package.json';await fs.appendFile(target,'BROKEN');const p=await r.call('runtime_repair_preview');
 if(drift==='outside-file')await fs.writeFile(f.root+'/runtime/vendor-user.txt','KEEP');
 if(drift==='target-link'){await fs.unlink(target);await fs.symlink(f.dir+'/USER_KEEP',target);}
 if(drift==='target-hardlink'){await fs.unlink(target);await fs.link(f.dir+'/USER_KEEP',target);}
 if(drift==='source')await fs.appendFile(f.root+'/plugin/package.json','CHANGED');
 if(drift==='plan')await fs.appendFile(f.root+'/.control/runtime/plugin-repair-plan.json','x');
 await assert.rejects(r.call('runtime_repair_apply',repairApply(p)));await assert.rejects(fs.stat(f.root+'/.control/runtime/plugin-maintenance.json'),{code:'ENOENT'});assert.equal(await fs.readFile(f.dir+'/USER_KEEP','utf8'),'preserved');
});
test('runtime repair checks live process birth identity before any plan',linux,async t=>{
 const f=await fixture(t),r=await repairable(f);r.j.host=await stamp(process.pid);await fs.writeFile(f.root+'/.control/runtime/journal.json',JSON.stringify(signed(r.j,f.q)));await assert.rejects(r.call('runtime_repair_preview'),/PROCESS_ACTIVE/);await assert.rejects(fs.stat(f.root+'/.control/runtime/plugin-repair-plan.json'),{code:'ENOENT'});
});
test('runtime repair signed ledger corruption blocks restart and never refreshes inventory',async t=>{
 const f=await fixture(t),r=await repairable(f);await fs.appendFile(f.root+'/runtime/plugin/package.json','BROKEN');const p=await r.call('runtime_repair_preview');await r.call('runtime_repair_apply',repairApply(p));const file=f.root+'/.control/runtime/plugin-maintenance.json',d=JSON.parse(await fs.readFile(file));d.records[0].delta[0].after.ino++;await fs.writeFile(file,JSON.stringify(d));await assert.rejects(r.call('runtime_repair_status'),/JOURNAL_REVIEW/);if(process.platform==='linux')await assert.rejects(r.call('runtime_restart_preview'),/JOURNAL_REVIEW/);assert.equal(await fs.readFile(f.root+'/.control/runtime/inventory.json','utf8'),r.inventory);
});
test('lost outer commit is recovered from exact inner publication, not by reapplying',async t=>{
 const f=await fixture(t),r=await repairable(f),target=f.root+'/runtime/plugin/package.json';await fs.appendFile(target,'BROKEN');const p=await r.call('runtime_repair_preview');await r.call('runtime_repair_apply',repairApply(p));const inode=(await fs.stat(target)).ino,file=f.root+'/.control/runtime/plugin-maintenance.json',d=JSON.parse(await fs.readFile(file));delete d.signature;d.records[0].state='applying';d.records[0].delta=[];await fs.writeFile(file,JSON.stringify(signed(d,f.q)));
 assert.equal((await r.call('runtime_repair_status')).repair.recoveryRequired,true);if(process.platform==='linux')await assert.rejects(r.call('runtime_restart_preview'),/RECOVERY_REQUIRED/);
 assert.equal((await r.call('runtime_repair_recover',{repairId:p.id})).state,'repair_committed');assert.equal((await fs.stat(target)).ino,inode);assert.equal((await r.call('runtime_repair_recover',{repairId:p.id})).notResent,true);
});
test('intent before inner journal can settle only against exact signed preimage',async t=>{
 const f=await fixture(t),r=await repairable(f),target=f.root+'/runtime/plugin/package.json';await fs.appendFile(target,'BROKEN');const p=await r.call('runtime_repair_preview');const inv=JSON.parse(r.inventory),d={schema:1,operationId:f.q.operationId,runtimeId:r.j.id,inventoryHash:r.j.inventoryHash,records:[{id:p.id,fingerprint:p.fingerprint,baseHash:hash(inv.items),state:'applying',delta:[],updatedAt:Date.now()}]};await fs.writeFile(f.root+'/.control/runtime/plugin-maintenance.json',JSON.stringify(signed(d,f.q)),{mode:0o600});
 assert.equal((await r.call('runtime_repair_recover',{repairId:p.id})).state,'repair_rolled_back');assert.match(await fs.readFile(target,'utf8'),/BROKEN$/);assert.equal(await fs.readFile(f.root+'/.control/runtime/inventory.json','utf8'),r.inventory);
});

test('missing outer ledger never adopts existing repair history as a fresh installation',async t=>{const f=await fixture(t),r=await repairable(f);await fs.appendFile(f.root+'/runtime/plugin/package.json','BROKEN');const p=await r.call('runtime_repair_preview');await r.call('runtime_repair_apply',repairApply(p));await fs.unlink(f.root+'/.control/runtime/plugin-maintenance.json');await assert.rejects(r.call('runtime_repair_status'),/LEDGER_REVIEW/);await assert.rejects(r.call('runtime_repair_preview'),/LEDGER_REVIEW/);assert(await fs.stat(f.root+'/.control/runtime/plugin-repairs/'+p.id));});
test('original runtime dispatch exposes historical activation separately and refuses pre-restart verification',async t=>{
 const f=await fixture(t),r=await repairable(f);await fs.appendFile(f.root+'/runtime/plugin/package.json','BROKEN');const p=await r.call('runtime_repair_preview');await r.call('runtime_repair_apply',repairApply(p));
 const status=await r.call('runtime_repair_status');assert.equal(status.repair.state,'committed');assert.equal(status.activation.contract,1);assert(!status.activation.activationVerified&&status.activation.cached);assert.equal(status.activation.observedAt,null);
 await assert.rejects(r.call('runtime_repair_verify',{repairId:p.id}),/ACTIVATION_RESTART_REQUIRED/);await assert.rejects(fs.stat(f.root+'/.control/runtime/plugin-activation.json'),{code:'ENOENT'});assert.equal(await fs.readFile(f.root+'/.control/runtime/inventory.json','utf8'),r.inventory);
});
