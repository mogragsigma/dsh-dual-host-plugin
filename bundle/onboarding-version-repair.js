// Nested repairs belong to a signed version epoch, not to a new release.
// Only the latest version journal is mutable. Its child pins the completed
// repair history through parentHash; rollback retains both damaged backups
// and the repaired discarded image. Nothing here starts a Host.
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fs,hash as sha} from './onboarding-install-fs.js';
import {statMaybe,syncDirectory} from './onboarding-maintenance-fs.js';
import {createPluginRepair} from './onboarding-plugin-repair.js';
const hash=x=>sha(JSON.stringify(x)),fail=c=>{throw Error('ONBOARDING_PLUGIN_VERSION_REPAIR_'+c);};
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const exact=(x,k)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join()===k.slice().sort().join();
const pending=r=>['preparing','applying','needs_review'].includes(r.state);
export function createVersionRepair({root,operationId,runtimeId,proof,original,readAll,save,guard,privateDir,verifyImage,readImage,now,hook,verifyRepairCandidate}){
 const folder=j=>path.join(root,'.control/runtime/plugin-versions',j.id,'repairs');
 const control=(j,r)=>path.join(folder(j),r.slot);
 const phase=j=>j.state==='committed'?'after':j.state==='rolled_back'?'before':null;
 const base=(j,p)=>p==='after'?{...j.after,image:j.stage}:j.before;
 function merge(j,p,{until,allowPending=false}={}){
  let current=structuredClone(base(j,p).image);
  for(const r of j.repairs??[]){
   if(r.phase!==p)continue;
   if(r.baseHash!==hash(current))fail('OWNERSHIP_REVIEW');
   if(r===until)break;
   if(pending(r)&&!allowPending)fail('RECOVERY_REQUIRED');
   const map=new Map(current.map(x=>[x.path,x]));
   for(const d of r.delta){const before=map.get(d.before?.path),a=d.after;
    if(!exact(d,['before','after'])||!before||before.kind!=='file'||hash(before)!==hash(d.before)||!exact(a,['path','kind','dev','ino','uid','mode','bytes','sha256'])||a.path!==before.path||a.kind!=='file'||a.sha256!==before.sha256||a.bytes!==before.bytes||a.dev!==before.dev||a.uid!==before.uid||a.mode!==before.mode||!Number.isSafeInteger(a.ino)||a.ino<0)fail('OWNERSHIP_REVIEW');
    map.set(a.path,a);
   }
   current=[...map.values()];
  }
  return current;
 }
 async function validate(j){
  if(j.repairs===undefined){if(await statMaybe(folder(j)))fail('JOURNAL_REVIEW');return;}
  if(!Array.isArray(j.repairs)||j.repairs.length>128||new Set(j.repairs.map(r=>r.slot)).size!==j.repairs.length||new Set(j.repairs.map(r=>r.id)).size!==j.repairs.length)fail('JOURNAL_REVIEW');
  for(const [n,r] of j.repairs.entries()){
   if(!exact(r,['slot','id','phase','baseHash','state','fingerprint','delta','updatedAt','directoryIdentity'])||!uuid(r.slot)||!uuid(r.id)||!['before','after'].includes(r.phase)||!hex(r.baseHash)||!['preparing','planned','applying','committed','rolled_back','needs_review'].includes(r.state)||r.fingerprint!==null&&!hex(r.fingerprint)||!Number.isSafeInteger(r.updatedAt)||!Array.isArray(r.delta)||r.delta.length>512||r.state!=='committed'&&r.delta.length||new Set(r.delta.map(x=>x.after?.path)).size!==r.delta.length||pending(r)&&n!==j.repairs.length-1)fail('JOURNAL_REVIEW');
   if(r.phase==='before'&&j.state!=='rolled_back')fail('JOURNAL_REVIEW');
   if(r.directoryIdentity){if(hash(await privateDir(control(j,r)))!==hash(r.directoryIdentity)||(await fs.readdir(control(j,r))).some(n=>!['plugin-repair-plan.json','plugin-repairs'].includes(n)))fail('JOURNAL_REVIEW');}
   else if(!pending(r))fail('JOURNAL_REVIEW');
  }
  if(await statMaybe(folder(j))){await privateDir(folder(j));if((await fs.readdir(folder(j))).some(n=>!j.repairs.some(r=>r.slot===n)))fail('JOURNAL_REVIEW');}
  else if(j.repairs.some(r=>r.directoryIdentity))fail('JOURNAL_REVIEW');
  merge(j,'before',{allowPending:true});if(j.stage)merge(j,'after',{allowPending:true});
 }
 function settled(j){if((j.repairs??[]).some(pending))fail('RECOVERY_REQUIRED');}
 function current(j){settled(j);const p=phase(j);if(!p)fail('VERSION_RECOVERY_REQUIRED');return {...base(j,p),image:merge(j,p)};}
 function source(j,rows){
  const b=base(j,phase(j));
  if(b.version===original.version&&hash(b.manifest)===hash(original.manifest))return path.join(root,'plugin');
  const owner=rows.findLast(x=>x.after.version===b.version&&hash(x.after.manifest)===hash(b.manifest));
  if(!owner)fail('SOURCE_UNAVAILABLE');return path.join(root,'.control/runtime/plugin-candidates',owner.candidateId,'plugin');
 }
 async function sourceVerified(j,rows){
  const p=source(j,rows),b=base(j,phase(j));
  if(p!==path.join(root,'plugin')&&verifyRepairCandidate){const checked=await verifyRepairCandidate(path.basename(path.dirname(p)));if(checked.version!==b.version||hash(checked.manifest.slice().sort((a,b)=>a.path.localeCompare(b.path,'en')))!==hash(b.manifest))fail('SOURCE_DRIFT');}
  const observed=await readImage(p);
  // The immutable signed release pins bytes, types, modes and names. Source
  // inodes need not be installed inodes, and are never adopted as target ownership.
  const canonical=a=>a?.map(({dev,ino,...x})=>x);
  if(hash(canonical(observed))!==hash(canonical(b.image)))fail('SOURCE_DRIFT');return p;
 }
 async function repairable(expected){
  const observed=await readImage(path.join(root,'runtime/plugin'));if(!observed)fail('DIRECTORY_REVIEW');
  const map=new Map(expected.map(x=>[x.path,x])),seen=new Set();
  for(const item of observed){const old=map.get(item.path);if(!old)fail('UNKNOWN_FILE');seen.add(item.path);
   if(item.kind!==old.kind)fail('TYPE_REVIEW');
   if(item.kind==='directory'){if(hash(item)!==hash(old))fail('DIRECTORY_REVIEW');}
   else if(item.dev!==old.dev||item.uid!==old.uid||item.mode!==old.mode||item.sha256===old.sha256&&item.ino!==old.ino)fail('OWNERSHIP_REVIEW');
  }
  if(expected.some(x=>x.kind==='directory'&&!seen.has(x.path)))fail('DIRECTORY_REVIEW');
 }
 function engine(j,r,rows){
  const image=merge(j,r.phase,{until:r,allowPending:true});
  return createPluginRepair({root,operationId,runtimeId,proof,manifest:base(j,r.phase).manifest,
   inventory:image.filter(x=>x.path).map(x=>({path:x.path,kind:x.kind,identity:{dev:x.dev,ino:x.ino,mode:x.mode},sha256:x.sha256??null})),
   versionContext:{source:source(j,rows),control:control(j,r),targetIdentity:((x)=>({dev:x.dev,ino:x.ino,uid:x.uid,mode:x.mode}))(image.find(x=>x.path===''))},
   exclusive:f=>f(),verifyOwnedStopped:async()=>{await guard();return {operationId,runtimeId,stopped:true,ownershipVerified:true};},now,hook});
 }
 function view(j,r){return {contract:1,id:r?.id??null,state:r?.state??'not_started',recoveryRequired:!!r&&pending(r),ownershipRebased:r?.state==='committed',activationVerified:false,activationSupported:false,activeVersionRepair:!!r&&r.phase===phase(j),versionUpgrade:false,version:base(j,r?.phase??phase(j)).version,versionTransactionId:j.id,files:r?.delta.map(x=>x.after.path)??[],hostStarted:false,backupsRetained:true};}
 async function finish(j,r,e,result){
  await guard();let delta=[];
  if(result.state==='committed'){
   const expected=merge(j,r.phase,{until:r,allowPending:true}),map=new Map(expected.map(x=>[x.path,x]));
   delta=(await e.ownership({id:r.id})).map(x=>{const before=map.get(x.path);return {before,after:{...before,dev:x.identity.dev,ino:x.identity.ino,mode:x.identity.mode,bytes:x.bytes,sha256:x.sha256}};});
  }
  r.state=result.state;r.delta=delta;r.updatedAt=now();await validate(j);
  if(r.state==='committed')await verifyImage(path.join(root,'runtime/plugin'),merge(j,r.phase));
  await save(j);return view(j,r);
 }
 async function action(name,args={}){
  const rows=await readAll(),j=rows.at(-1);if(!j||!phase(j))fail('VERSION_RECOVERY_REQUIRED');
  if(name==='status')return view(j,(j.repairs??[]).at(-1));
  if(name==='verify')fail('ACTIVATION_UNSUPPORTED');
  await guard();
  if(name==='preview'){
   if(!exact(args,[]))fail('ARGUMENTS');settled(j);await sourceVerified(j,rows);
   if((j.repairs??[]).length>=128)fail('HISTORY_FULL');
   const image=current(j).image;await repairable(image);
   const slot=randomUUID(),r={slot,id:slot,phase:phase(j),baseHash:hash(image),state:'preparing',fingerprint:null,delta:[],updatedAt:now(),directoryIdentity:null};
   (j.repairs??=[]).push(r);await save(j);
   try{
    if(!await statMaybe(folder(j))){await fs.mkdir(folder(j),{mode:0o700});await syncDirectory(path.dirname(folder(j)));}
    await privateDir(folder(j));await fs.mkdir(control(j,r),{mode:0o700});await syncDirectory(folder(j));r.directoryIdentity=await privateDir(control(j,r));await save(j);
    const p=await engine(j,r,rows).preview();r.id=p.id;r.fingerprint=p.fingerprint;r.state='planned';r.updatedAt=now();await save(j);
   return {...p,version:base(j,r.phase).version,versionTransactionId:j.id,historyAware:true,activationSupported:false};
   }catch(e){r.state='needs_review';await save(j);throw e;}
  }
  if(!['apply','recover'].includes(name))fail('ARGUMENTS');
  const r=(j.repairs??[]).find(x=>x.id===args.id);if(!r)fail('NOT_FOUND');
  if(!exact(args,name==='apply'?['id','fingerprint','confirm']:['id','confirm'])||args.confirm!==true||name==='apply'&&args.fingerprint!==r.fingerprint)fail('CONFIRMATION_REQUIRED');
  if(['committed','rolled_back'].includes(r.state))return {...view(j,r),notResent:true};
  if(r!==j.repairs.at(-1)||r.phase!==phase(j))fail('NOT_LATEST');
  if(!r.fingerprint||!r.directoryIdentity)fail('JOURNAL_REVIEW');
  const e=engine(j,r,rows);
  if(name==='apply'){
   if(r.state!=='planned')return {...view(j,r),notResent:true};
   await sourceVerified(j,rows);await e.validate(args);r.state='applying';r.updatedAt=now();await save(j);await hook?.('version_repair_intent');
  }else if(r.state==='planned')fail('NOT_STARTED');
  try{const result=await e[name](args);await hook?.('version_repair_result');return await finish(j,r,e,result);}
  catch(error){r.state='needs_review';r.delta=[];r.updatedAt=now();await save(j);throw error;}
 }
 async function binding(){const rows=await readAll(),j=rows.at(-1);if(!j||!phase(j))fail('VERSION_RECOVERY_REQUIRED');const release=current(j),r=j.repairs?.at(-1);return {release,versionTransactionId:j.id,repair:r?.phase===phase(j)?{id:r.id,fingerprint:r.fingerprint,updatedAt:r.updatedAt,state:r.state}:null};}
 return {validate,settled,current,after:j=>merge(j,'after'),action,binding};
}
