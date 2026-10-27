// Verified archive extension; no arbitrary commands, targets or model entry.
import {spawn as runtimeSpawn} from 'node:child_process';
import {pathToFileURL as runtimeURL} from 'node:url';
const runtimeDir=q=>path.join(q.root,'.control/runtime');
const runtimeRoot=q=>path.join(q.root,'runtime');
const runtimeStates=['launching','installing','runtime_ready','configuring','starting_host','host_ready','restarting','failed','stopped'];
async function runtimeSource(q){
 const s=await load(q);if(s.state!=='prepared'||s.active)fail('RUNTIME_SOURCE_NOT_READY');
 for(const f of s.owner.manifest){const r=await regular(path.join(q.root,f.path));if(!r||r.sha256!==f.sha256||r.identity.mode!==f.mode||r.identity.uid!==s.owner.identity.uid)fail('RUNTIME_SOURCE_CHANGED');}
 return s;
}
async function runtimeRecord(q){
 await checkAncestors(runtimeDir(q));
 const f=await regular(path.join(runtimeDir(q),'journal.json'),262144);if(!f)return null;
 if(f.identity.mode!==0o600||f.identity.uid!==process.getuid())fail('RUNTIME_JOURNAL_REVIEW');
 const j=verified(JSON.parse(f.data),q.proof);
 if(j.schema!==1||j.operationId!==q.operationId||j.planHash!==q.planHash||j.root!==q.root||!uuid(j.id)||!runtimeStates.includes(j.state)||!Number.isSafeInteger(j.revision)||j.revision<1||!hex(j.fingerprint))fail('RUNTIME_JOURNAL_REVIEW');
 return j;
}
async function runtimeSave(q,j){j.revision++;j.updatedAt=Date.now();await atomicJSON(path.join(runtimeDir(q),'journal.json'),signed(j,q.proof));}
async function runtimeAlive(p){
 if(!p)return false;
 const active=await processActive(p);if(!active)return false;
 const raw=await fs.readFile('/proc/'+p.pid+'/stat','utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
 return !!raw&&!['Z','X'].includes(raw.slice(raw.lastIndexOf(')')+2).split(' ')[0]);
}
async function runtimeView(q,j,observation=0){
 if(!j)return {state:'not_started',operationId:q.operationId,initialization:false,hostStarted:false};
 const hostActive=await runtimeAlive(j.host),workerActive=await runtimeAlive(j.worker),childActive=await runtimeAlive(j.child),restartLauncherActive=await runtimeAlive(j.restart?.launcher),state=j.state==='host_ready'&&!hostActive?'host_stopped':j.state==='restarting'&&!workerActive&&!restartLauncherActive?'restart_needs_review':j.state;
 // Journal may advance while inspecting the original PID.
 if(observation===0&&j.state==='restarting'&&!workerActive&&!hostActive&&!restartLauncherActive){const latest=await runtimeRecord(q);if(latest?.id===j.id&&latest.revision>j.revision)return runtimeView(q,latest,1);}
 const native=j.nativeReceipt&&j.state!=='restarting'?{hostVersion:j.nativeReceipt.hostVersion,pluginVersion:j.nativeReceipt.pluginVersion??null,origin:j.nativeReceipt.origin,rows:j.nativeReceipt.rows,modelAttempts:j.nativeReceipt.modelAttempts,modelAttemptScope:j.nativeReceipt.modelAttemptScope??null,gatewayBound:j.nativeReceipt.gatewayBound,dshHome:j.nativeReceipt.dshHome,agentsHome:j.nativeReceipt.agentsHome,workspace:j.nativeReceipt.workspace,im:j.nativeReceipt.im??null}:null;
 return {state,stopPlanSupported:true,hostStopSupported:true,hostStopConsentContract:1,stop:await runtimeStopView(q,j),restartSupported:true,restartConsentContract:1,restartId:j.restart?.id??null,restartFingerprint:j.restart?.fingerprint??null,restartState:j.restart?.state??null,restartLauncherActive,operationId:q.operationId,runtimeId:j.id,revision:j.revision,fingerprint:j.fingerprint,workerActive,childActive,hostActive,worker:j.worker,child:j.child,host:j.host??null,error:j.error,inventoryCount:j.inventoryCount??0,installationRoot:runtimeRoot(q),runtimeInstalled:['runtime_ready','host_ready'].includes(j.state),nativeHostReady:j.state==='host_ready'&&hostActive&&j.nativeReceipt?.ok===true&&j.nativeReceipt?.rows?.length===4&&j.nativeReceipt?.modelAttempts===0&&j.nativeReceipt?.modelAttemptScope==='inspection_agents_only',native,optionalIm:j.optionalIm===true,defaultConfig:j.defaultConfig??null,rules:j.rules??null,initialization:false,hostStarted:hostActive,automaticRetry:false};
}

// Imported only after runtimeSource verifies the archived product manifest.
async function runtimeStopModule(q){const {createRuntimeStop}=await import(runtimeURL(path.join(q.root,'plugin/onboarding-runtime-stop.js')));return createRuntimeStop({fs,path,randomUUID,runtimeDir,regular,verified,signed,exact,uuid,hash,fail,runtimeAlive,runtimeRecord,runtimeView,atomicJSON,runtimeSource,checkAncestors,runtimeVerifyPlugin});}
async function runtimeStopLedger(q,j,terminalOnly=false){return (await runtimeStopModule(q)).ledger(q,j,terminalOnly);}
async function runtimeStopView(q,j){return (await runtimeStopModule(q)).view(q,j);}
async function runtimeStopPreview(q,j){return (await runtimeStopModule(q)).preview(q,j);}
async function runtimeStop(q,j,io){return (await runtimeStopModule(q)).apply(q,j,io);}
async function runtimeTool(file){const real=await fs.realpath(file),r=await regular(real,2097152);if(!r)fail('RUNTIME_TOOL_MISSING');return {path:real,...r.identity,sha256:r.sha256};}
async function runtimePlan(q){
 const s=await runtimeSource(q);if(process.platform!=='linux'||Number(process.versions.node.split('.')[0])<22)fail('RUNTIME_PLATFORM_UNSUPPORTED');
 let npm=null;for(const file of [path.join(path.dirname(process.execPath),'npm'),'/usr/local/bin/npm','/usr/bin/npm'])try{npm=await runtimeTool(file);break;}catch(e){if(e.code!=='ENOENT')throw e;}
 if(!npm||path.basename(npm.path)!=='npm-cli.js')fail('RUNTIME_NPM_MISSING');
 const im=q.im===true,prefix=im?'runtime-im':'runtime';
 const pkg=JSON.parse((await regular(path.join(q.root,'plugin',prefix+'-package.json')))?.data??'null'),lock=JSON.parse((await regular(path.join(q.root,'plugin',prefix+'-lock.json')))?.data??'null');
 const compat=JSON.parse((await regular(path.join(q.root,'plugin/compatibility.json'))).data);
 if(pkg?.private!==true||pkg.name!=='dsh-dual-host-isolated-runtime'||pkg.dependencies?.['@deepseek-ai/dsh']!==compat.hostBaseline||lock?.lockfileVersion!==3||hash(lock.packages?.['']?.dependencies)!==hash(pkg.dependencies)||pkg.scripts)fail('RUNTIME_LOCK_REVIEW');
 for(const [name,p] of Object.entries(lock.packages)){if(!name)continue;if(!name.startsWith('node_modules/')||p.link||p.resolved&&!/^https:\/\/registry\.npmjs\.org\/[^?#\s]+$/.test(p.resolved)||!p.integrity||!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(p.integrity))fail('RUNTIME_LOCK_REVIEW');}
 if(im&&(compat.onboardingOptionalIm!==1||pkg.dependencies?.['@xmanrui/dsh-im']!==(compat.imOptional?.installationVersion??compat.imOptional?.testedVersion))||!im&&pkg.dependencies?.['@xmanrui/dsh-im'])fail('RUNTIME_OPTIONAL_IM_REVIEW');
 const systemLock=await runtimeTool('/usr/bin/flock').catch(()=>null);if(!systemLock||systemLock.uid!==0||(systemLock.mode&0o022)!==0)fail('RUNTIME_LOCK_UNAVAILABLE');
 const d=await fs.statfs(q.root);if(Number(d.bavail)*Number(d.bsize)<2147483648)fail('RUNTIME_DISK_LOW');
 const plan={schema:1,operationId:q.operationId,sourceManifestHash:s.owner.manifestHash,root:q.root,hostVersion:compat.hostBaseline,node:{path:process.execPath,version:process.versions.node,...identity(await fs.stat(process.execPath))},npm,systemLock,packageHash:hash(pkg),lockHash:hash(lock),registry:'https://registry.npmjs.org',optionalIm:im?{package:'@xmanrui/dsh-im',version:pkg.dependencies['@xmanrui/dsh-im'],loaded:true,botConnection:false,credentialTransfer:false}:null,nativeHost:{listen:'127.0.0.1',port:0,rules:true,skills:true,officialSupportScript:'@deepseek-ai/dsh-subprocess-local/scripts/ensure-spawn-helper.mjs',gatewayBound:false},lifecycleScripts:false,modelEnabled:false,imEnabled:false,repositoryWrites:false,hostStarted:false};
 return {...plan,fingerprint:hash(plan)};
}
function runtimeEnv(q){const r=runtimeRoot(q),home=path.join(r,'.bootstrap-home');return {HOME:home,PATH:path.dirname(process.execPath)+':/usr/bin:/bin',SHELL:'/bin/sh',LANG:'C.UTF-8',XDG_CONFIG_HOME:path.join(home,'config'),XDG_CACHE_HOME:path.join(home,'cache'),XDG_DATA_HOME:path.join(home,'data'),NPM_CONFIG_USERCONFIG:path.join(r,'npm-user.ini'),NPM_CONFIG_GLOBALCONFIG:path.join(r,'npm-global.ini'),NPM_CONFIG_CACHE:path.join(r,'.npm-cache'),NPM_CONFIG_UPDATE_NOTIFIER:'false'};}
async function runtimeInventory(q,omit=null){await runtimeSource(q);return (await import(runtimeURL(path.join(q.root,'plugin/onboarding-runtime-inventory.js')))).runtimeInventory(q,omit);}
async function runtimeReadInput(limit=32768){let size=0,a=[];for await(const c of process.stdin){size+=c.length;if(size>limit)fail('RUNTIME_INPUT_LIMIT');a.push(c);}return JSON.parse(Buffer.concat(a));}
export async function runtimeWorkerCLI(){
 process.umask(0o077);let q,j,child=null,authorized=false,stopping=false,timedOut=false;
 process.on('SIGTERM',()=>{stopping=true;});
 try{
  q=await runtimeReadInput();base(q);if(q.action==='runtime_version'&&q.versionAction==='reclaim_worker'){await runtimeVersionControl(q);return;}if(q.action==='runtime_restart'){await runtimeRestartWorker(q);return;}const source=await runtimeSource(q);j=await runtimeRecord(q);
  const self=await processInfo();if(!j||j.state!=='launching'||!j.worker||hash(self)!==hash(j.worker)||j.fingerprint!==q.fingerprint)fail('RUNTIME_WORKER_NOT_AUTHORIZED');
  authorized=true;
  const plan=await runtimePlan(q);if(plan.fingerprint!==q.fingerprint)fail('RUNTIME_PLAN_DRIFT');
  if(stopping)fail('RUNTIME_STOPPED');const root=runtimeRoot(q);await fs.mkdir(root,{mode:0o700});j.state='installing';await runtimeSave(q,j);
  await fs.mkdir(path.join(root,'.bootstrap-home'),{mode:0o700});
  for(const name of ['npm-user.ini','npm-global.ini'])await writeNew(path.join(root,name),'');
  for(const [source,dest] of [[q.im===true?'runtime-im-package.json':'runtime-package.json','package.json'],[q.im===true?'runtime-im-lock.json':'runtime-lock.json','package-lock.json']])await writeNew(path.join(root,dest),(await regular(path.join(q.root,'plugin',source))).data);
  const log=await fs.open(path.join(runtimeDir(q),'npm.log'),'wx',0o600);
  try{
   if(stopping)fail('RUNTIME_STOPPED');
   child=runtimeSpawn(process.execPath,[plan.npm.path,'ci','--ignore-scripts','--no-audit','--no-fund','--registry='+plan.registry,'--prefix',root],{cwd:root,env:runtimeEnv(q),stdio:['ignore',log.fd,log.fd]});
   const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});done.catch(()=>{});
   await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
   j.child=await processInfo(child.pid);await runtimeSave(q,j);
   const timeout=setTimeout(()=>{timedOut=true;process.kill(-process.pid,'SIGTERM');},900000);
   let result;try{result=await done;}finally{clearTimeout(timeout);}
   if(result.code!==0||stopping||timedOut)fail(timedOut?'RUNTIME_INSTALL_TIMEOUT':stopping?'RUNTIME_STOPPED':'RUNTIME_NPM_FAILED');
   const pkg=JSON.parse((await regular(path.join(root,'package.json'))).data);
   for(const [name,version] of Object.entries(pkg.dependencies)){const p=JSON.parse((await regular(path.join(root,'node_modules',name,'package.json'))).data);if(p.name!==name||p.version!==version)fail('RUNTIME_PACKAGE_MISMATCH');}
   j.state='runtime_ready';j.error=null;await runtimeSave(q,j);
   const {initializeNativeHost}=await import(runtimeURL(path.join(q.root,'plugin/onboarding-native-host.js')));
   await initializeNativeHost(q,j,{manifest:source.owner.manifest,processInfo,alive:runtimeAlive,save:()=>runtimeSave(q,j),stopping:()=>stopping});
  }finally{await log.close();}
 }catch(e){if(j&&authorized){j.state=stopping?'stopped':'failed';j.error=/^ONBOARDING_CLOUD_[A-Z_]+$/.test(e.message)?e.message:'ONBOARDING_CLOUD_RUNTIME_FAILED';}}
 finally{
  if(j&&q&&authorized)try{if(j.error==='ONBOARDING_CLOUD_NATIVE_PATH_OCCUPIED')fail('RUNTIME_INVENTORY_REVIEW');if(child&&child.exitCode===null&&child.signalCode===null||await runtimeAlive(j.child))fail('RUNTIME_CHILD_STILL_ACTIVE');const inventory=await runtimeInventory(q);const data=JSON.stringify(signed({schema:1,operationId:q.operationId,runtimeId:j.id,items:inventory},q.proof));await writeNew(path.join(runtimeDir(q),'inventory.json'),data);j.inventoryHash=hash(data);j.inventoryCount=inventory.length;await runtimeSave(q,j);}catch{j.state='failed';j.error='ONBOARDING_CLOUD_RUNTIME_INVENTORY_REVIEW';await runtimeSave(q,j).catch(()=>{});}
 }
}

async function runtimeRepairModule(q,j){
 const {createRuntimeRepair}=await import(runtimeURL(path.join(q.root,'plugin/onboarding-runtime-repair.js')));
 return createRuntimeRepair({fs,path,hash,fail,regular,verified,signed,atomicJSON,runtimeOwnedInventory,runtimeInventory,runtimeAlive,runtimeRecord,runtimeStopLedger,runtimeSource,checkAncestors,runtimeVerifyPlugin},q,j);
}
async function runtimeBaseInventory(q,j){
 const original=await runtimeOwnedInventory(q,j);
 if(!await stat(path.join(runtimeDir(q),'plugin-maintenance.json')))return original;
 return {...original,items:await (await runtimeRepairModule(q,j)).effective()};
}
async function runtimeVersionModule(q,j,io={},dispatch=false){
 if(JSON.parse((await regular(path.join(q.root,'plugin/compatibility.json'))).data).onboardingPluginVersion!==1)fail('RUNTIME_VERSION_UNSUPPORTED');
 const m=await import(runtimeURL(path.join(q.root,'plugin/onboarding-runtime-version.js'))),api={fs,path,hash,fail,regular,verified,signed,atomicJSON,runtimeBaseInventory,runtimeInventory,runtimeAlive,runtimeRecord,runtimeStopLedger,runtimeSource,runtimeLock,cleanupRead,checkAncestors,runtimeVerifyPlugin,runtimeDir,runtimeEnv,reclaimWorkerSource:typeof RUNTIME_SOURCE==='undefined'?null:RUNTIME_SOURCE,runtimeProcessInfo:processInfo};
 return dispatch?m.dispatchRuntimeVersion(api,q,io):m.createRuntimeVersion(api,q,j);
}
async function runtimeVerifyPlugin(q,j){
 const source=await runtimeSource(q),compat=JSON.parse((await regular(path.join(q.root,'plugin/compatibility.json'))).data);
 if(compat.onboardingPluginVersionLifecycle!==1){for(const f of source.owner.manifest){const p=path.join(runtimeRoot(q),f.path);await checkAncestors(path.dirname(p));const v=await regular(p);if(!v||v.sha256!==f.sha256||v.identity.mode!==f.mode||v.identity.uid!==process.getuid())fail('RUNTIME_HOST_SOURCE_CHANGED');}return;}
 const {verifyRuntimePlugin}=await import(runtimeURL(path.join(q.root,'plugin/onboarding-runtime-inventory.js')));
 await verifyRuntimePlugin(q,(await runtimeEffectiveInventory(q,j)).items);
}
async function runtimeEffectiveInventory(q,j){
 if(!await stat(path.join(runtimeDir(q),'plugin-versions')))return runtimeBaseInventory(q,j);
 return {...await runtimeBaseInventory(q,j),items:(await (await runtimeVersionModule(q,j)).effective()).items};
}
async function runtimeOwnedInventory(q,j){
 const file=await regular(path.join(runtimeDir(q),'inventory.json'),33554432);if(!file||file.sha256!==j.inventoryHash)fail('RUNTIME_INVENTORY_REVIEW');
 const inv=verified(JSON.parse(file.data),q.proof);if(inv.operationId!==q.operationId||inv.runtimeId!==j.id||!Array.isArray(inv.items))fail('RUNTIME_INVENTORY_REVIEW');return inv;
}
async function runtimeRegisterAdmission(q,j,before){
 const {runtimeAdmissionDelta}=await import(runtimeURL(path.join(q.root,'plugin/onboarding-runtime-inventory.js')));
 const nonce=j.restart.nonce,receipt=j.nativeReceipt;
 if(!receipt?.ok||receipt.nonce!==nonce||receipt.pid!==j.host?.pid||receipt.modelAttempts!==0||receipt.rows?.length!==4||receipt.rows.some(x=>!x.valid||!x.idle))fail('RUNTIME_ADMISSION_OWNERSHIP_REVIEW');
 const items=runtimeAdmissionDelta(before,await runtimeInventory(q),nonce);
 const data=JSON.stringify(signed({schema:1,operationId:q.operationId,runtimeId:j.id,restartId:j.restart.id,nonce,items},q.proof));
 await writeNew(path.join(runtimeDir(q),'restarts',j.restart.id,'admission-inventory.json'),data);
 j.restart.admissionInventoryHash=hash(data);j.restart.admissionInventoryCount=items.length;await runtimeSave(q,j);
}
async function runtimeDeletionInventory(q,j){
 const {runtimeAdmissionDelta}=await import(runtimeURL(path.join(q.root,'plugin/onboarding-runtime-inventory.js')));
 const original=await runtimeEffectiveInventory(q,j),items=[...original.items],seen=new Set(items.map(x=>x.path));
 for(const run of [...(j.restartHistory??[]),...(j.restart?[j.restart]:[])]){
  if(!run.admissionInventoryHash)continue;
  const f=await regular(path.join(runtimeDir(q),'restarts',run.id,'admission-inventory.json'),2097152);
  if(!f||f.sha256!==run.admissionInventoryHash||f.identity.mode!==0o600||f.identity.uid!==process.getuid())fail('RUNTIME_ADMISSION_OWNERSHIP_REVIEW');
  const d=verified(JSON.parse(f.data),q.proof);
  if(d.schema!==1||d.operationId!==q.operationId||d.runtimeId!==j.id||d.restartId!==run.id||d.nonce!==run.nonce||!Array.isArray(d.items)||d.items.length!==16||d.items.length!==run.admissionInventoryCount)fail('RUNTIME_ADMISSION_OWNERSHIP_REVIEW');
  // Validate recorded shapes and parent ownership again; never infer ownership from current files.
  const validated=runtimeAdmissionDelta(items,[...items,...d.items],run.nonce);
  for(const item of validated){if(seen.has(item.path))fail('RUNTIME_ADMISSION_OWNERSHIP_REVIEW');seen.add(item.path);items.push(item);}
 }
 return items;
}
const runtimeMutable=p=>['runtime/native-home','runtime/native-tmp','runtime/workspace'].some(x=>p===x||p.startsWith(x+'/'));
async function runtimeRestartPlan(q,j,worker=false){
 if(j)await runtimeStopLedger(q,j,true);
 if(process.platform!=='linux'||!j?.nativeReceipt?.ok||!j.host||!j.defaultConfig||!j.inventoryHash)fail('RUNTIME_RESTART_NOT_READY');
 if(await runtimeAlive(j.host)||await runtimeAlive(j.child)||!worker&&(await runtimeAlive(j.worker)||await runtimeAlive(j.restart?.launcher)))fail('RUNTIME_PROCESS_ACTIVE');
 if(j.state==='restarting'&&!worker&&j.restart?.state==='requested')fail('RUNTIME_RESTART_REVIEW');
 await runtimeRestartControls(q,j);
 if(await stat(path.join(runtimeDir(q),'plugin-versions'))||await stat(path.join(runtimeDir(q),'plugin-artifacts.json'))){const m=await runtimeVersionModule(q,j),v=await m.effective();if((v.version!==v.originalVersion||await stat(path.join(runtimeDir(q),'plugin-artifacts.json')))&&!await m.artifactsReady())fail('RUNTIME_VERSION_ARTIFACT_MAINTENANCE_REQUIRED');}
 const source=await runtimeSource(q),prior=await runtimeEffectiveInventory(q,j),current=await runtimeInventory(q);
 if(hash(current.filter(x=>!runtimeMutable(x.path)))!==hash(prior.items.filter(x=>!runtimeMutable(x.path))))fail('RUNTIME_RESTART_IMMUTABLE_DRIFT');
 if(j.defaultConfig.path!==path.join(runtimeRoot(q),'native-home/dsh/profiles/web/cordis.patch.yml'))fail('RUNTIME_RESTART_PROFILE_REVIEW');const patch=await regular(j.defaultConfig.path,2097152);if(!patch)fail('RUNTIME_RESTART_PROFILE_REVIEW');
 const before=new Map(prior.items.map(x=>[x.path,hash(x)])),after=new Map(current.map(x=>[x.path,hash(x)]));
 const changed=[...new Set([...before.keys(),...after.keys()])].filter(x=>before.get(x)!==after.get(x));
 const plan={schema:1,operationId:q.operationId,runtimeId:j.id,sourceManifestHash:source.owner.manifestHash,root:q.root,previousHost:j.host,previousRestartId:worker?j.restart.previousId:j.restart?.id??null,inventorySnapshotHash:hash(current),configurationSha256:patch.sha256,preservedMutableChanges:changed.length,node:{path:process.execPath,version:process.versions.node,...identity(await fs.stat(process.execPath))},hostVersion:j.nativeReceipt.hostVersion,reinstall:false,defaultConfigPreserved:true,resumePolicy:{contract:1,nativeWorkMayResume:true,imMayReconnect:true,configurationPreserved:true,automaticTaskApproval:false,automaticRetry:false,requiresExplicitAcknowledgement:true},repositoryWrites:false,initialization:false,hostStarted:false};
 return {...plan,fingerprint:hash(plan)};
}
async function runtimeBeginRestart(q,j){
 if(q.acknowledgeNativeResume!==true)fail('RUNTIME_RESTART_CONSENT_REQUIRED');
 if(!hex(q.fingerprint))fail('ARGUMENTS');
 if(j.restart?.fingerprint===q.fingerprint)return {...await runtimeView(q,j),notResent:true};
 const plan=await runtimeRestartPlan(q,j);if(plan.fingerprint!==q.fingerprint)fail('RUNTIME_PLAN_DRIFT');
 const worker=await regular(path.join(runtimeDir(q),'worker.mjs'),2097152);if(!worker||worker.sha256!==j.workerHash)fail('RUNTIME_RESTART_WORKER_REVIEW');
 const history=j.restartHistory??[];if(!Array.isArray(history)||history.length>=128)fail('RUNTIME_RESTART_HISTORY_LIMIT');
 if(j.restart)history.push(j.restart);
 const previousId=j.restart?.id??null;
 j.restart={id:randomUUID(),nonce:randomUUID(),fingerprint:q.fingerprint,nativeResumeAcknowledged:true,consentContract:1,previousId,previousHost:j.host,previousWorker:j.worker,launcher:await processInfo(),state:'requested',createdAt:Date.now()};
 j.restartHistory=history;j.state='restarting';j.error=null;await runtimeSave(q,j);
 const parent=path.join(runtimeDir(q),'restarts');let ps=await stat(parent);if(!ps){await fs.mkdir(parent,{mode:0o700});ps=await fs.lstat(parent);}if(!ps.isDirectory()||ps.isSymbolicLink()||ps.uid!==process.getuid()||(ps.mode&0o777)!==0o700)fail('RUNTIME_RESTART_CONTROL_REVIEW');
 const dir=path.join(parent,j.restart.id);await fs.mkdir(dir,{mode:0o700});j.restart.parentIdentity=identity(ps);j.restart.controlIdentity=identity(await fs.lstat(dir));await runtimeSave(q,j);
 const log=await fs.open(path.join(dir,'worker.log'),'wx',0o600);let child;
 try{
  child=runtimeSpawn(process.execPath,[path.join(runtimeDir(q),'worker.mjs')],{cwd:q.root,detached:true,env:runtimeEnv(q),stdio:['pipe',log.fd,log.fd]});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});j.worker=await processInfo(child.pid);j.restart.worker=j.worker;j.restart.launcher=null;await runtimeSave(q,j);
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({...q,restartId:j.restart.id}));child.unref();
 }finally{if(child?.stdin&&!child.stdin.writableEnded)child.stdin.end();await log.close();}
 return runtimeView(q,j);
}
async function runtimeRestartWorker(q){
 let j,authorized=false,stopping=false;process.on('SIGTERM',()=>{stopping=true;});
 try{
  if(!exact(q,['action','root','operationId','installationId','proof','planHash','fingerprint','acknowledgeNativeResume','restartId'])||!uuid(q.restartId))fail('ARGUMENTS');
  await runtimeSource(q);j=await runtimeRecord(q);
  if(!j||j.state!=='restarting'||j.restart?.id!==q.restartId||j.restart.fingerprint!==q.fingerprint||hash(await processInfo())!==hash(j.worker))fail('RUNTIME_WORKER_NOT_AUTHORIZED');
  if(q.acknowledgeNativeResume!==true||j.restart.nativeResumeAcknowledged!==true||j.restart.consentContract!==1)fail('RUNTIME_RESTART_CONSENT_REQUIRED');
  authorized=true;const plan=await runtimeRestartPlan(q,j,true);if(plan.fingerprint!==q.fingerprint)fail('RUNTIME_PLAN_DRIFT');
  const before=await runtimeInventory(q);if(hash(before)!==plan.inventorySnapshotHash)fail('RUNTIME_PLAN_DRIFT');
  if(stopping)fail('RUNTIME_STOPPED');
  const {restartNativeHost}=await import(runtimeURL(path.join(q.root,'plugin/onboarding-native-host.js')));
  await restartNativeHost(q,j,{processInfo,alive:runtimeAlive,save:()=>runtimeSave(q,j),stopping:()=>stopping});
  await runtimeRegisterAdmission(q,j,before);
  j.restart.state='ready';j.restart.host=j.host;j.restart.completedAt=Date.now();await runtimeSave(q,j);
 }catch(e){if(authorized){j.state=stopping?'stopped':'failed';j.error=/^ONBOARDING_CLOUD_[A-Z_]+$/.test(e.message)?e.message:'ONBOARDING_CLOUD_RUNTIME_RESTART_FAILED';j.restart.state='failed';j.restart.host=j.host;await runtimeSave(q,j).catch(()=>{});}}
 // Never refresh/adopt the original deletion inventory: user data stays user data.
}
async function runtimeRestartControls(q,j){
 const parent=path.join(runtimeDir(q),'restarts'),s=await stat(parent),records=[...(j.restartHistory??[]),...(j.restart?[j.restart]:[])],ids=records.map(x=>x.id);
 if(ids.some(x=>!uuid(x))||new Set(ids).size!==ids.length)fail('RUNTIME_RESTART_CONTROL_REVIEW');
 const owned=records.filter(x=>x.controlIdentity),registered=owned.map(x=>x.id);
 if(!s){if(owned.length)fail('RUNTIME_RESTART_CONTROL_REVIEW');return [];}
 if(!owned.length||!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700||owned.some(x=>!x.parentIdentity||!same(identity(s),x.parentIdentity))||hash((await fs.readdir(parent)).sort())!==hash(registered.sort()))fail('RUNTIME_RESTART_CONTROL_REVIEW');
 const rows=[],known=['worker.log','native-overlay.yml','native-host.log','native-launch.json','native-receipt.json','native-access.json','native-diagnostic.json','admission-inventory.json'];
 for(const item of owned){const id=item.id,dir=path.join(parent,id);await checkAncestors(dir);const ds=await fs.lstat(dir);if(!same(identity(ds),item.controlIdentity)||ds.uid!==process.getuid()||(ds.mode&0o777)!==0o700)fail('RUNTIME_RESTART_CONTROL_REVIEW');
  for(const name of await fs.readdir(dir)){if(!known.includes(name))fail('RUNTIME_RESTART_CONTROL_REVIEW');const f=await regular(path.join(dir,name),2097152);if(!f||f.identity.uid!==process.getuid()||f.identity.mode!==0o600||name==='admission-inventory.json'&&(!hex(item.admissionInventoryHash)||f.sha256!==item.admissionInventoryHash))fail('RUNTIME_RESTART_CONTROL_REVIEW');rows.push({name:'restarts/'+id+'/'+name,...f});}
  rows.push({name:'restarts/'+id,kind:'directory',identity:identity(ds)});
 }
 rows.push({name:'restarts',kind:'directory',identity:identity(s)});return rows;
}
const cleanupPaths=q=>({plan:path.join(q.root,'.control/runtime-cleanup-plan.json'),progress:path.join(q.root,'.control/runtime-cleanup.json')});
async function runtimeLock(q,fn){
 if(process.platform!=='linux')fail('RUNTIME_PLATFORM_UNSUPPORTED');
 const owner=base(q).owner,before=await regular(owner,131072),tool=await regular('/usr/bin/flock',2097152);
 if(!before||!tool||tool.identity.uid!==0||(tool.identity.mode&0o022)!==0)fail('RUNTIME_LOCK_UNAVAILABLE');
 const h=await fs.open(owner,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  if(!same(identity(await h.stat()),before.identity))fail('OWNER_REVIEW');
  // The parent owns this flock until descriptor close or process exit.
  const lock=runtimeSpawn('/usr/bin/flock',['--exclusive','--nonblock','3'],{stdio:['ignore','ignore','ignore',h.fd],env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
  const code=await new Promise((resolve,reject)=>{lock.once('error',reject);lock.once('exit',resolve);});
  if(code!==0)fail('RUNTIME_CONTROL_BUSY');
  const current=await regular(owner,131072);if(!current||!same(current.identity,before.identity)||current.sha256!==before.sha256)fail('OWNER_REVIEW');
  return await fn();
 }finally{await h.close();}
}
async function cleanupRead(q){
 const p=cleanupPaths(q),file=await regular(p.progress,262144);
 if(!file){if(await stat(p.plan))fail('RUNTIME_CLEANUP_REVIEW');return null;}
 if(file.identity.uid!==process.getuid()||file.identity.mode!==0o600)fail('RUNTIME_CLEANUP_REVIEW');
 const d=verified(JSON.parse(file.data),q.proof);
 if(d.schema!==1||d.operationId!==q.operationId||d.planHash!==q.planHash||!uuid(d.id)||!uuid(d.runtimeId)||!hex(d.contentHash)||!['payload','controls','finalizing'].includes(d.phase)||!Number.isSafeInteger(d.revision)||d.revision<1||![d.cursor,d.pendingEnd].every(x=>Number.isSafeInteger(x)&&x>=0)||d.pendingEnd<d.cursor||d.pendingEnd>d.cursor+32||!Array.isArray(d.processes))fail('RUNTIME_CLEANUP_REVIEW');
 return d;
}
async function cleanupSave(q,d){d.revision++;await atomicJSON(cleanupPaths(q).progress,signed(d,q.proof));}
const cleanupFingerprint=d=>hash({id:d.id,revision:d.revision,phase:d.phase,cursor:d.cursor,pendingEnd:d.pendingEnd,contentHash:d.contentHash});
async function cleanupQuiescent(d){for(const member of d.processes)if(await runtimeAlive(member))fail('RUNTIME_PROCESS_ACTIVE');}
async function cleanupView(q,d){
 const active=await runtimeAlive(d.controller);await cleanupQuiescent(d);
 return {state:active?'cleanup_running':'cleanup_pending',cleanupSupported:true,cleanupActive:active,cleanupId:d.id,cleanupPhase:d.phase,cleanupCompleted:d.cursor,cleanupPendingEnd:d.pendingEnd,cleanupFingerprint:cleanupFingerprint(d),operationId:q.operationId,runtimeId:d.runtimeId,workerActive:false,childActive:false,hostActive:false,restartLauncherActive:false,initialization:false,hostStarted:false,runtimeInstalled:false,automaticRetry:false};
}
async function cleanupPlan(q,d){
 const f=await regular(cleanupPaths(q).plan,67108864);
 if(!f||f.sha256!==d.contentHash||!same(f.identity,d.planIdentity))fail('RUNTIME_CLEANUP_REVIEW');
 const p=verified(JSON.parse(f.data),q.proof);
 if(p.schema!==1||p.id!==d.id||p.operationId!==q.operationId||p.runtimeId!==d.runtimeId||!Array.isArray(p.payload)||!Array.isArray(p.controls)||p.payload.length>150000||p.controls.length>2048)fail('RUNTIME_CLEANUP_REVIEW');
 for(const [kind,entries] of [['payload',p.payload],['controls',p.controls]]){
  const seen=new Set(),prefix=kind==='payload'?'runtime':'.control/runtime';
  for(const e of entries){if(typeof e.path!=='string'||e.path!==prefix&&!e.path.startsWith(prefix+'/')||e.path.split('/').some(x=>!x||x==='.'||x==='..')||seen.has(e.path)||!['file','directory','link'].includes(e.kind)||e.uid!==process.getuid())fail('RUNTIME_CLEANUP_REVIEW');seen.add(e.path);}
 }
 return p;
}
async function cleanupControlInventory(q){
 const out=[],root=runtimeDir(q);await checkAncestors(path.dirname(root));
 async function visit(p){const s=await fs.lstat(p),name=path.relative(q.root,p);if(s.isSymbolicLink()||s.uid!==process.getuid())fail('RUNTIME_CLEANUP_DRIFT');
  if(s.isDirectory()){out.push({path:name,kind:'directory',...identity(s)});for(const child of (await fs.readdir(p)).sort())await visit(path.join(p,child));}
  else {const f=await regular(p,33554432);if(!f)fail('RUNTIME_CLEANUP_DRIFT');out.push({path:name,kind:'file',...f.identity,sha256:f.sha256});}
 }
 if(await stat(root))await visit(root);return out;
}
function cleanupCompare(expected,current,cursor,end){
 if(cursor>expected.length||end>expected.length)fail('RUNTIME_CLEANUP_REVIEW');
 const map=new Map(current.map(x=>[x.path,x]));if(map.size!==current.length)fail('RUNTIME_CLEANUP_DRIFT');
 for(let i=0;i<expected.length;i++){
  const e=expected[i],found=map.get(e.path);map.delete(e.path);
  if(i<cursor?!!found:i>=end?!found||hash(e)!==hash(found):found&&hash(e)!==hash(found))fail('RUNTIME_CLEANUP_DRIFT');
 }
 if(map.size)fail('RUNTIME_CLEANUP_DRIFT');
}
async function cleanupValidate(q,d,p){
 await cleanupQuiescent(d);
 const payload=await runtimeInventory(q),controls=await cleanupControlInventory(q);
 if(d.phase==='payload'){cleanupCompare(p.payload,payload,d.cursor,d.pendingEnd);cleanupCompare(p.controls,controls,0,0);}
 else{if(payload.length)fail('RUNTIME_CLEANUP_DRIFT');cleanupCompare(p.controls,controls,d.cursor,d.pendingEnd);}
}
async function cleanupDelete(q,e){
 const name=path.join(q.root,e.path);await checkAncestors(path.dirname(name));const s=await stat(name);if(!s)return;
 if(!same(identity(s),e))fail('RUNTIME_CLEANUP_DRIFT');
 if(e.kind==='directory'){if(!s.isDirectory()||s.isSymbolicLink())fail('RUNTIME_CLEANUP_DRIFT');await fs.rmdir(name);}
 else if(e.kind==='link'){if(!s.isSymbolicLink()||await fs.readlink(name)!==e.target)fail('RUNTIME_CLEANUP_DRIFT');await fs.unlink(name);}
 else{const f=await regular(name,268435456);if(!f||f.sha256!==e.sha256)fail('RUNTIME_CLEANUP_DRIFT');await fs.unlink(name);}
}
async function cleanupSync(q,entries){
 const parents=new Set();for(const e of entries){let p=path.dirname(path.join(q.root,e.path));while(!await stat(p)){if(p===q.root)fail('RUNTIME_CLEANUP_DRIFT');p=path.dirname(p);}parents.add(p);}
 for(const p of parents)await syncDir(p);
}
async function cleanupFinish(q,d,io){
 await cleanupQuiescent(d);
 if(await stat(runtimeRoot(q))||await stat(runtimeDir(q)))fail('RUNTIME_CLEANUP_DRIFT');
 const f=await regular(cleanupPaths(q).plan,67108864);
 if(f){if(f.sha256!==d.contentHash||!same(f.identity,d.planIdentity))fail('RUNTIME_CLEANUP_REVIEW');await fs.unlink(cleanupPaths(q).plan);await syncDir(path.dirname(cleanupPaths(q).plan));}
 await io.afterCleanupPlanRemoval?.();
 const latest=await cleanupRead(q);if(!latest||hash(latest)!==hash(d))fail('RUNTIME_CLEANUP_REVIEW');
 await fs.unlink(cleanupPaths(q).progress);await syncDir(path.dirname(cleanupPaths(q).progress));
 return {state:'rolled_back',operationId:q.operationId,runtimeId:d.runtimeId,initialization:false,hostStarted:false,runtimeInstalled:false,cleanupResumable:true};
}
async function cleanupContinue(q,d,io={}){
 let owns=false;
 try{
  if(await runtimeAlive(d.controller))fail('RUNTIME_CONTROL_BUSY');await cleanupQuiescent(d);
  if(d.phase!=='finalizing'){const p=await cleanupPlan(q,d);await cleanupValidate(q,d,p);}
  d.controller=await processInfo();await cleanupSave(q,d);owns=true;
  if(d.phase==='finalizing')return await cleanupFinish(q,d,io);
  const p=await cleanupPlan(q,d);
  for(const phase of ['payload','controls']){
   if(d.phase!==phase)continue;const items=p[phase];
   while(d.cursor<items.length){
    d.pendingEnd=Math.min(d.cursor+32,items.length);await cleanupSave(q,d);await io.afterCleanupIntent?.(phase,d.cursor,d.pendingEnd);
    const start=d.cursor;
    for(let i=start;i<d.pendingEnd;i++){await cleanupDelete(q,items[i]);await io.afterCleanupItem?.(phase,i,items[i].path);}
    await cleanupSync(q,items.slice(start,d.pendingEnd));
    d.cursor=d.pendingEnd;await cleanupSave(q,d);
   }
   d.phase=phase==='payload'?'controls':'finalizing';d.cursor=0;d.pendingEnd=0;await cleanupSave(q,d);await io.afterCleanupPhase?.(d.phase);
  }
  return await cleanupFinish(q,d,io);
 }finally{
  if(owns){const latest=await cleanupRead(q).catch(()=>null);if(latest&&hash(latest.controller)===hash(d.controller)){latest.controller=null;await cleanupSave(q,latest);}}
 }
}
async function runtimeRollback(q,j,io={}){
 if(await runtimeAlive(j.worker)||await runtimeAlive(j.child)||await runtimeAlive(j.host)||await runtimeAlive(j.restart?.launcher))fail('RUNTIME_PROCESS_ACTIVE');
 for(const name of ['plugin-candidates','plugin-versions','plugin-version-plan.json','plugin-artifacts.json','plugin-artifacts-plan.json'])if(await stat(path.join(runtimeDir(q),name)))fail('RUNTIME_VERSION_HISTORY_PRESERVED');
 const expected=await runtimeDeletionInventory(q,j),current=await runtimeInventory(q),byPath=new Map(expected.map(x=>[x.path,hash(x)]));
 if(current.length!==expected.length||current.some(x=>byPath.get(x.path)!==hash(x)))fail('RUNTIME_ROLLBACK_DRIFT');
 await runtimeStopLedger(q,j,true);
 const dir=runtimeDir(q),known=['stop.json','worker.mjs','journal.json','inventory.json','worker.log','npm.log','native-setup.log','native-host.log','native-launch.json','native-receipt.json','native-access.json','native-diagnostic.json','restarts'];
 await runtimeRestartControls(q,j);
 const contents=await fs.readdir(dir);if(contents.some(x=>!known.includes(x)))fail('RUNTIME_ROLLBACK_DRIFT');
 const controls=await cleanupControlInventory(q);
 for(const f of controls){if(f.mode!==(f.kind==='directory'?0o700:0o600))fail('RUNTIME_ROLLBACK_DRIFT');if(f.path==='.control/runtime/worker.mjs'&&f.sha256!==j.workerHash)fail('RUNTIME_ROLLBACK_DRIFT');}
 const id=randomUUID(),p=cleanupPaths(q),data=JSON.stringify(signed({schema:1,id,operationId:q.operationId,runtimeId:j.id,payload:[...current].reverse(),controls:[...controls].reverse()},q.proof));
 await writeNew(p.plan,data);await syncDir(path.dirname(p.plan));const plan=await regular(p.plan,67108864);
 const d={schema:1,id,operationId:q.operationId,runtimeId:j.id,planHash:q.planHash,contentHash:plan.sha256,planIdentity:plan.identity,phase:'payload',cursor:0,pendingEnd:0,revision:1,processes:[j.worker,j.child,j.host,j.restart?.launcher].filter(Boolean),controller:null};
 await writeNew(p.progress,JSON.stringify(signed(d,q.proof)));await syncDir(path.dirname(p.progress));await io.afterCleanupPrepared?.();
 return cleanupContinue(q,d,io);
}
async function runtimeControlUnlocked(q,io={}){
 const keys=['action','root','operationId','installationId','proof','planHash'];
 const optionalIm=Object.hasOwn(q??{},'im');if(optionalIm&&(!['runtime_preview','runtime_start'].includes(q.action)||typeof q.im!=='boolean'))fail('ARGUMENTS');
 if(!['runtime_preview','runtime_start','runtime_status','runtime_stop_preview','runtime_stop','runtime_stop_reconcile','runtime_rollback','runtime_restart_preview','runtime_restart','runtime_reconcile_restart','runtime_rollback_resume','runtime_repair_preview','runtime_repair_apply','runtime_repair_status','runtime_repair_recover','runtime_repair_verify'].includes(q?.action)||!exact(q,[...keys,...(['runtime_start','runtime_restart','runtime_reconcile_restart','runtime_rollback_resume','runtime_repair_apply'].includes(q.action)?['fingerprint']:[]),...(['runtime_repair_apply','runtime_repair_recover','runtime_repair_verify'].includes(q.action)?['repairId']:[]),...(optionalIm?['im']:[]),...(q.action==='runtime_restart'?['acknowledgeNativeResume']:[]),...(['runtime_stop','runtime_stop_reconcile'].includes(q.action)?['stopPlan']:[]),...(q.action==='runtime_stop'&&q.stopPlan?.schema===2?['acknowledgeNativeInterruption']:[])]))fail('ARGUMENTS');base(q);await runtimeSource(q);
 const cleanup=await cleanupRead(q);
 if(cleanup){
  if(q.action==='runtime_status')return cleanupView(q,cleanup);
  if(q.action!=='runtime_rollback_resume')fail('RUNTIME_CLEANUP_RECOVERY_REQUIRED');
  if(!hex(q.fingerprint)||q.fingerprint!==cleanupFingerprint(cleanup))fail('RUNTIME_CLEANUP_PLAN_DRIFT');
  return cleanupContinue(q,cleanup,io);
 }
 if(q.action==='runtime_rollback_resume')fail('RUNTIME_CLEANUP_REVIEW');
 let j=await runtimeRecord(q);
 if(await stat(path.join(runtimeDir(q),'runtime-reclaim.json'))){const r=await(await runtimeVersionModule(q,j)).reclaimGate();if(r)return {...await runtimeView(q,j),...r};}
 if(await stat(path.join(runtimeDir(q),'plugin-uninstall.json'))){const u=await(await runtimeVersionModule(q,j)).uninstallGate();if(u)return {...await runtimeView(q,j),...u};}
 if(q.action.startsWith('runtime_repair_')){if(await stat(path.join(runtimeDir(q),'plugin-versions'))){if(JSON.parse((await regular(path.join(q.root,'plugin/compatibility.json'))).data).onboardingVersionRepair!==1)fail('RUNTIME_VERSION_REPAIR_INTERLOCK');return (await runtimeVersionModule(q,j)).repair();}return (await runtimeRepairModule(q,j)).dispatch();}
 if(q.action==='runtime_reconcile_restart'){if(!j?.restart||j.restart.fingerprint!==q.fingerprint||j.state!=='restarting')fail('RUNTIME_RESTART_REVIEW');if(await runtimeAlive(j.worker)||await runtimeAlive(j.child)||await runtimeAlive(j.host)||await runtimeAlive(j.restart.launcher))fail('RUNTIME_PROCESS_ACTIVE');await runtimeRestartControls(q,j);j.state='failed';j.error='ONBOARDING_CLOUD_RUNTIME_RESTART_INTERRUPTED';j.restart.state='interrupted';await runtimeSave(q,j);return runtimeView(q,j);}
 if(q.action==='runtime_restart_preview')return runtimeRestartPlan(q,j);
 if(q.action==='runtime_restart'){if(!j)fail('RUNTIME_RESTART_NOT_READY');return runtimeBeginRestart(q,j);}
 if(q.action==='runtime_status')return runtimeView(q,j);
 if(q.action==='runtime_preview'){if(j)fail('RUNTIME_RECOVERY_REQUIRED');return runtimePlan(q);}
 if(q.action==='runtime_start'){
  if(!hex(q.fingerprint))fail('ARGUMENTS');if(j){if(j.fingerprint!==q.fingerprint)fail('RUNTIME_PLAN_DRIFT');return runtimeView(q,j);}
  const plan=await runtimePlan(q);if(plan.fingerprint!==q.fingerprint)fail('RUNTIME_PLAN_DRIFT');
  if(await stat(runtimeRoot(q)))fail('RUNTIME_EXISTING_CONTENT');
  const dir=runtimeDir(q);await fs.mkdir(dir,{mode:0o700});
  const record={schema:1,id:randomUUID(),operationId:q.operationId,planHash:q.planHash,root:q.root,revision:0,state:'launching',fingerprint:q.fingerprint,optionalIm:q.im===true,worker:null,child:null,workerHash:hash(RUNTIME_SOURCE),error:null,createdAt:Date.now()};
  await runtimeSave(q,record);await writeNew(path.join(dir,'worker.mjs'),RUNTIME_SOURCE);
  const log=await fs.open(path.join(dir,'worker.log'),'wx',0o600);
  try{
   const child=runtimeSpawn(process.execPath,[path.join(dir,'worker.mjs')],{cwd:q.root,detached:true,env:runtimeEnv(q),stdio:['pipe',log.fd,log.fd]});
   // Deliver input only after durable birth identity and intent.
   await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});record.worker=await processInfo(child.pid);await runtimeSave(q,record);
   child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(q));child.unref();
  }finally{await log.close();}
  return runtimeView(q,record);
 }
 if(!j)fail('RUNTIME_STATE_UNKNOWN');
 if(q.action==='runtime_rollback')return runtimeRollback(q,j,io);
 if(q.action==='runtime_stop_preview')return runtimeStopPreview(q,j);
 return runtimeStop(q,j,io);
}
export async function runtimeControl(q,io={}){
 if(q?.action==='runtime_restart'&&q.acknowledgeNativeResume!==true)fail('RUNTIME_RESTART_CONSENT_REQUIRED');
 const keys=['action','root','operationId','installationId','proof','planHash'];
 const optionalIm=Object.hasOwn(q??{},'im');if(optionalIm&&(!['runtime_preview','runtime_start'].includes(q.action)||typeof q.im!=='boolean'))fail('ARGUMENTS');
 if(!['runtime_preview','runtime_start','runtime_status','runtime_stop_preview','runtime_stop','runtime_stop_reconcile','runtime_rollback','runtime_restart_preview','runtime_restart','runtime_reconcile_restart','runtime_rollback_resume','runtime_repair_preview','runtime_repair_apply','runtime_repair_status','runtime_repair_recover','runtime_repair_verify'].includes(q?.action)||!exact(q,[...keys,...(['runtime_start','runtime_restart','runtime_reconcile_restart','runtime_rollback_resume','runtime_repair_apply'].includes(q.action)?['fingerprint']:[]),...(['runtime_repair_apply','runtime_repair_recover','runtime_repair_verify'].includes(q.action)?['repairId']:[]),...(optionalIm?['im']:[]),...(q.action==='runtime_restart'?['acknowledgeNativeResume']:[]),...(['runtime_stop','runtime_stop_reconcile'].includes(q.action)?['stopPlan']:[]),...(q.action==='runtime_stop'&&q.stopPlan?.schema===2?['acknowledgeNativeInterruption']:[])]))fail('ARGUMENTS');base(q);await runtimeSource(q);
 // Queries do not acquire the runtime write lock.
 if(['runtime_start','runtime_stop','runtime_stop_reconcile','runtime_rollback','runtime_restart','runtime_reconcile_restart','runtime_rollback_resume','runtime_repair_preview','runtime_repair_apply','runtime_repair_recover','runtime_repair_verify'].includes(q?.action)){
  base(q);await runtimeSource(q);return (io.lock??runtimeLock)(q,()=>runtimeControlUnlocked(q,io));
 }
 return runtimeControlUnlocked(q,io);
}
export async function runtimeCLI(){try{const q=await runtimeReadInput();const value=await runtimeControl(q);console.log(JSON.stringify({ok:true,value}));}catch(e){console.log(JSON.stringify({ok:false,error:/^ONBOARDING_CLOUD_[A-Z_]+$/.test(e.message)?e.message:'ONBOARDING_CLOUD_RUNTIME_FAILED'}));}}

// Only this archive package channel accepts 8 MiB; lifecycle input stays 32 KiB.
export async function runtimeVersionControl(q,io={}){
 base(q);await runtimeSource(q);return runtimeVersionModule(q,null,io,true);
}
export async function runtimeVersionCLI(){try{const value=await runtimeVersionControl(await runtimeReadInput(12582912));console.log(JSON.stringify({ok:true,value}));}catch(e){console.log(JSON.stringify({ok:false,error:/^ONBOARDING_CLOUD_[A-Z_]+$/.test(e.message)?e.message:'ONBOARDING_CLOUD_RUNTIME_VERSION_FAILED'}));}}
