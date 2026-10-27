// Original verified archive only. Candidate code is data here, never imported.
import {createRequire} from 'node:module';
import {createPluginVersion} from './onboarding-plugin-version.js';
import {createExclusiveRename} from './onboarding-exclusive-rename.js';
import {createVersionCandidates} from './onboarding-version-candidate.js';
import {createRuntimeActivation} from './onboarding-runtime-activation.js';
export async function dispatchRuntimeVersion(api,q,io={}){
 const {fail,cleanupRead,runtimeRecord,runtimeLock}=api,exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join()===keys.slice().sort().join();
 const keys={uninstall_preview:[],uninstall_apply:['id','fingerprint','confirm'],uninstall_status:['id'],uninstall_recoveryPreview:['id'],uninstall_recover:['id','fingerprint','confirm'],rules_preview:[],rules_apply:['id','fingerprint','confirm'],rules_status:['id'],rules_recoveryPreview:['id'],rules_recover:['id','fingerprint','confirm'],receive:['id','manifestHash','files','confirm'],candidate_status:['id'],preview:['id'],apply:['id','fingerprint','confirm'],status:['id'],recover:['id','confirm'],previewRollback:['id'],rollback:['id','planId','fingerprint','confirm']};
 Object.assign(keys,{activation_verify:['id'],activation_status:['id'],reclaim_worker:['id','planHash'],reclaim_preview:[],reclaim_apply:['id','fingerprint','confirm'],reclaim_status:[],reclaim_recoveryPreview:[],reclaim_recover:['id','fingerprint','confirm']});
 if(!exact(q,['action','root','operationId','installationId','proof','planHash','versionAction','args'])||q.action!=='runtime_version'||!Object.hasOwn(keys,q.versionAction)||!exact(q.args,keys[q.versionAction])&&!(q.versionAction==='uninstall_status'&&exact(q.args,[])))fail('ARGUMENTS');
 let entered=false,ready=false;const launches=[];
 const invoke=async()=>{entered=true;if(await cleanupRead(q))fail('RUNTIME_CLEANUP_RECOVERY_REQUIRED');const service=await createRuntimeVersion({...api,...io,deferReclaimStart:handle=>launches.push(handle)},q,await runtimeRecord(q));ready=true;return service.action(q.versionAction,q.args);};
 try{
  // Signed read-only reclamation snapshots must remain observable while a
  // deletion worker holds the exclusive owner lock. They never advance work.
  const result=q.versionAction==='reclaim_status'?await invoke():await(io.lock??runtimeLock)(q,invoke);
  for(const h of launches)h.start();return result;
 }catch(e){for(const h of launches)h.cancel();if(!entered||!ready)fail('RUNTIME_VERSION_PREFLIGHT_REFUSED');throw e;}

}
export async function createRuntimeVersion(api,q,j){
 const {fs,path,hash,fail,regular,runtimeSource,runtimeRecord,runtimeAlive,runtimeStopLedger,runtimeInventory,runtimeBaseInventory}=api;
 const source=await runtimeSource(q),read=async n=>JSON.parse((await regular(path.join(q.root,'plugin',n),4194304)).data),compat=await read('compatibility.json');
 if(compat.onboardingPluginVersion!==1)fail('RUNTIME_VERSION_UNSUPPORTED');
 if(!j?.inventoryHash||!j.nativeReceipt?.ok)fail('RUNTIME_VERSION_NOT_READY');
 const original=await runtimeBaseInventory(q,j),pkg=await read('package.json'),isPlugin=p=>p==='runtime/plugin'||p.startsWith('runtime/plugin/');
 const mutable=p=>['runtime/native-home','runtime/native-tmp','runtime/workspace'].some(x=>p===x||p.startsWith(x+'/'));
 async function stopped(){
  const current=await runtimeRecord(q);
  if(current?.id!==j.id||current.revision!==j.revision||current.inventoryHash!==j.inventoryHash)fail('RUNTIME_VERSION_RUNTIME_CHANGED');
  if(!['host_ready','failed','stopped'].includes(current.state))fail('RUNTIME_VERSION_NOT_READY');
  for(const p of [current.host,current.worker,current.child,current.restart?.launcher])if(await runtimeAlive(p))fail('RUNTIME_PROCESS_ACTIVE');
  await runtimeStopLedger(q,current,true);
 }
 async function guard(){
  await stopped();
  return {operationId:q.operationId,runtimeId:j.id,stopped:true,ownershipVerified:true};
 }
 async function outside(){await guard();const current=await runtimeInventory(q,new Set(['runtime/plugin'])),filter=x=>!isPlugin(x.path)&&!mutable(x.path);if(hash(current.filter(filter))!==hash(original.items.filter(filter)))fail('RUNTIME_VERSION_OUTSIDE_DRIFT');}
 const receiver=createVersionCandidates({q,j,original:{package:pkg,compatibility:compat,lock:await read('package-lock.json'),files:new Map(source.owner.manifest.map(f=>[f.path,f]))},regular,signed:api.signed,verified:api.verified,atomicJSON:api.atomicJSON,guard,hook:api.versionHook});
 let nativeMove;
 async function moveImage(from,to){
  // Dependencies remain the signed original runtime; importing from the
  // unlinked archive's node_modules would resolve the wrong installation.
  await outside();if(api.versionMove)return api.versionMove(from,to);
  if(!nativeMove){const require=createRequire(path.join(q.root,'runtime/package.json')),name=require.resolve('koffi');if(!name.startsWith(path.join(q.root,'runtime/node_modules/koffi')+path.sep))fail('RUNTIME_VERSION_DEPENDENCY_REVIEW');const p=JSON.parse((await regular(path.join(q.root,'runtime/node_modules/koffi/package.json'))).data);if(p.version!=='3.1.1')fail('RUNTIME_VERSION_DEPENDENCY_REVIEW');nativeMove=createExclusiveRename(require('koffi'));}
  return nativeMove(from,to);
 }
 const initial={version:pkg.version,manifest:source.owner.manifest.map(f=>({path:f.path.slice(7),sha256:f.sha256})),image:original.items.filter(x=>isPlugin(x.path)).map(x=>({path:x.path==='runtime/plugin'?'':x.path.slice(15),kind:x.kind,dev:x.dev,ino:x.ino,uid:x.uid,mode:x.mode,...(x.kind==='file'?{bytes:x.bytes,sha256:x.sha256}:{})}))};
 const version=createPluginVersion({root:q.root,operationId:q.operationId,runtimeId:j.id,proof:q.proof,initial,exclusive:fn=>fn(),verifyOwnedStopped:guard,moveImage,hook:api.versionHook,verifyRepairCandidate:id=>receiver.release(id)});
 function versionError(e){if(/^ONBOARDING_PLUGIN_VERSION_[A-Z_]+$/.test(e.message))fail('RUNTIME_VERSION_'+e.message.slice('ONBOARDING_PLUGIN_VERSION_'.length));throw e;}
 async function verifiedRelease(){try{return await version.effective();}catch(e){versionError(e);}}
 async function artifacts(){
  if(compat.onboardingPluginVersionArtifacts!==1)fail('RUNTIME_ARTIFACTS_UNSUPPORTED');
  const {createRuntimeArtifacts}=await import('./onboarding-runtime-artifacts.js');return createRuntimeArtifacts({...api,...(compat.onboardingPluginUninstall===1?{uninstallRestored:async()=>(await uninstall()).restored()}:{})},q,j,{original,effective:verifiedRelease,guard:outside});
 }
 async function uninstall(){
  if(compat.onboardingPluginUninstall!==1||compat.onboardingPluginVersionLifecycle!==1||compat.onboardingPluginVersionArtifacts!==1)fail('RUNTIME_UNINSTALL_UNSUPPORTED');
  const {createRuntimeUninstall}=await import('./onboarding-runtime-uninstall.js');return createRuntimeUninstall(api,q,j,{current:verifiedRelease,guard:outside,moveImage,artifacts});
 }
 async function reclamation(){
  if(compat.onboardingRuntimeReclamation!==1)fail('RUNTIME_RECLAIM_UNSUPPORTED');
  const {createRuntimeReclamation}=await import('./onboarding-runtime-reclaim.js');
  return createRuntimeReclamation(api,q,j,{background:compat.onboardingRuntimeReclamationWorker===1,prerequisite:async()=>(await uninstall()).reclamationProof()});
 }
 async function reclaimGate(){
  const marker=path.join(q.root,'.control/runtime/runtime-reclaim.json');await api.checkAncestors(path.dirname(marker));
  try{await fs.lstat(marker);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  const r=await(await reclamation()).status();
  if(q.action!=='runtime_status')fail('RUNTIME_RECLAIM_RESTART_BLOCKED');
  return {state:r.state==='committed'?'runtime_reclaimed':'reclamation_needs_review',runtimeInstalled:false,nativeHostReady:false,managedRestartBlocked:true,reclamation:r};
 }
 function view(v){return {...v,operationId:q.operationId,runtimeId:j.id,initialization:false,automaticRetry:false,activationVerified:false,threeArtifactMaintenancePending:true};}
 async function action(name,args){
  try{
   if(name.startsWith('reclaim_'))return await(await reclamation())[name.slice(8)](args);
   await reclaimGate();
   if(name.startsWith('uninstall_'))return await (await uninstall())[name.slice(10)](args);
   if(compat.onboardingPluginUninstall===1&&!['status','candidate_status','rules_status'].includes(name))await (await uninstall()).assertOpen();
   if(name.startsWith('activation_'))return await activation(name,args);
   if(!['status','candidate_status','rules_status'].includes(name))try{await outside();}catch{fail('RUNTIME_VERSION_PREFLIGHT_REFUSED');}
   if(name.startsWith('rules_'))try{return await (await artifacts())[name.slice(6)](args);}catch(e){if(/^ONBOARDING_(?!CLOUD_)[A-Z_]+$/.test(e.message))fail('RUNTIME_ARTIFACTS_'+e.message.slice('ONBOARDING_'.length));throw e;}
   if(compat.onboardingPluginVersionArtifacts===1&&['preview','apply','recover','previewRollback','rollback'].includes(name))await (await artifacts()).noPending();
   if(name==='receive')return view(await receiver.receive(args));
   if(name==='candidate_status')return view(await receiver.status(args.id));
   if(name==='preview'){await guard();return view(await version.preview(await receiver.release(args.id)));}
   if(!['apply','status','recover','previewRollback','rollback'].includes(name))fail('ARGUMENTS');
   return view(await version[name](args));
  }catch(e){versionError(e);}
 }
 async function activation(name,args){
  if(compat.onboardingVersionActivation!==1||compat.onboardingPluginVersionArtifacts!==1)fail('RUNTIME_VERSION_ACTIVATION_UNSUPPORTED');
  const binding=await version.activationBinding();
  if(args.id!==binding.transactionId)fail('RUNTIME_ACTIVATION_VERSION_CHANGED');
  const current=name==='activation_verify'?await effective():null;
  const currentCompat=name==='activation_verify'?JSON.parse((await regular(path.join(q.root,'runtime/plugin/compatibility.json'))).data):compat;
  if(name==='activation_verify'&&currentCompat.onboardingVersionActivation!==1)fail('RUNTIME_VERSION_ACTIVATION_UNSUPPORTED');
  const verifier=createRuntimeActivation(api,q,j,{inventory:current?.items??[],source:{owner:{manifest:binding.release.manifest}},compat:currentCompat,
   versionContext:{version:binding.release.version,imageHash:hash(binding.release),transactionId:binding.transactionId,artifactsReady:async()=>(await artifacts()).ready()},
   versionSubject:{state:binding.state,historyHash:binding.historyHash,stillCurrent:async()=>hash(await version.activationBinding())===hash(binding)}});
  const value=name==='activation_verify'?await verifier.verify(args.id):await verifier.status();
  return {...value,operationId:q.operationId,runtimeId:j.id,initialization:false,requestedTransactionId:args.id};
 }
 async function effective(){
  const r=await verifiedRelease(),rows=r.image.map(x=>({path:x.path?'runtime/plugin/'+x.path:'runtime/plugin',dev:x.dev,ino:x.ino,uid:x.uid,mode:x.mode,kind:x.kind,...(x.kind==='file'?{bytes:x.bytes,sha256:x.sha256}:{})}));
  // Canonical original scanner order, not locale collation. Preserve every
  // non-plugin row from the signed baseline; no user data is adopted.
  const map=new Map(rows.map(x=>[x.path,x])),result=[];let inserted=false;
  for(const row of original.items){if(isPlugin(row.path)){if(!inserted){const visit=p=>{const x=map.get(p);if(!x)fail('RUNTIME_VERSION_IMAGE_DRIFT');result.push(x);if(x.kind==='directory')for(const n of [...map.keys()].filter(n=>path.posix.dirname(n)===p).sort())visit(n);};visit('runtime/plugin');inserted=true;}}else result.push(row);}
  if(!inserted)fail('RUNTIME_VERSION_IMAGE_DRIFT');return {items:result,version:r.version,originalVersion:pkg.version};
 }
 async function repair(){
  if(compat.onboardingVersionRepair!==1||compat.onboardingPluginVersionLifecycle!==1)fail('RUNTIME_VERSION_REPAIR_INTERLOCK');
  const name=q.action.slice(15),args={...(q.repairId?{id:q.repairId,confirm:true}:{}),...(q.fingerprint?{fingerprint:q.fingerprint}:{})};
  if(!['preview','apply','status','recover','verify'].includes(name))fail('ARGUMENTS');
  const activationSupported=compat.onboardingVersionRepairActivation===1&&compat.onboardingPluginVersionArtifacts===1;
  if(name==='verify'&&!activationSupported)fail('RUNTIME_REPAIR_ACTIVATION_UNSUPPORTED');
  try{
   if(!['status','verify'].includes(name))await outside();
   if(compat.onboardingPluginVersionArtifacts===1&&['preview','apply','recover'].includes(name))await (await artifacts()).noPending();
   const r=await version.repair(name==='verify'?'status':name,name==='verify'?{}:args);
   if(name==='preview')return {...r,activationSupported,operationId:q.operationId,runtimeId:j.id,initialization:false,repairSupported:true,ownershipRebased:false,activationVerified:false};
   r.activationSupported=activationSupported&&r.activeVersionRepair;
   let activation=null;
   if(activationSupported&&!r.recoveryRequired&&['status','verify'].includes(name)){
    const binding=await version.repairBinding(),current=name==='verify'?await effective():null;
    const currentCompat=name==='verify'?JSON.parse((await regular(path.join(q.root,'runtime/plugin/compatibility.json'))).data):compat;
    const verifier=createRuntimeActivation(api,q,j,{repair:binding.repair,inventory:current?.items??[],source:{owner:{manifest:binding.release.manifest}},compat:currentCompat,
     versionContext:{version:binding.release.version,imageHash:hash(binding.release),transactionId:binding.versionTransactionId,artifactsReady:async()=>(await artifacts()).ready()}});
    activation=name==='verify'?await verifier.verify(q.repairId):await verifier.status();
   }
   return {operationId:q.operationId,runtimeId:j.id,initialization:false,hostStarted:await runtimeAlive(j.host),state:'repair_'+r.state,scope:'stopped_owned_plugin_files_only',repair:r,activation,automaticRetry:false};
  }catch(e){
   if(/^ONBOARDING_PLUGIN_(VERSION_REPAIR|REPAIR)_[A-Z_]+$/.test(e.message))fail('RUNTIME_REPAIR_'+e.message.replace(/^ONBOARDING_PLUGIN_(VERSION_REPAIR|REPAIR)_/,''));
   versionError(e);
  }
 }
 async function uninstallGate(){
  const s=await(await uninstall()).status();if(!s.managedRestartBlocked)return null;
  if(q.action!=='runtime_status')fail(s.state==='committed'?'RUNTIME_UNINSTALL_ALREADY_UNINSTALLED':'RUNTIME_UNINSTALL_RECOVERY_REQUIRED');
  return {state:s.state==='committed'?'plugin_uninstalled':'uninstall_needs_review',pluginInstalled:s.pluginInstalled,nativeHostReady:false,managedRestartBlocked:true,uninstall:s};
 }
 return {action,effective,repair,uninstallGate,reclaimGate,artifactsReady:async()=>compat.onboardingPluginVersionArtifacts===1&&(await artifacts()).ready()};
}
