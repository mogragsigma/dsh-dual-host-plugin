import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createMaintenancePlanner} from './onboarding-maintenance-plan.js';
import {fs,hash,bytes,snapshot,ancestors,identity,sameIdentity,inside,syncWrite,atomicState,fail} from './onboarding-install-fs.js';
import {publishMaintenanceItem,rollbackMaintenanceItem,syncDirectory,statMaybe} from './onboarding-maintenance-fs.js';

const active=new Set(),uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const receipt=j=>({id:j.id,action:j.action,state:j.state,error:j.error??null,review:j.review??[],version:j.afterManifest?.version??null,
 files:j.items.map(x=>({path:x.path,action:x.action})),directoryResults:j.directoryResults??[],canRecover:['applying','rolling_back','needs_review'].includes(j.state),
 rulesAndSkillsOnly:true,pluginBinaryChanged:false,credentialsChanged:false,activationVerified:false,initialization:false,executionAuthorized:false});

export function createOnboardingMaintenance(config={},runtime={}){
 const planner=createMaintenancePlanner(config,runtime),now=runtime.now??Date.now;
 const plans=new Map(),recoveries=new Map();let busy=false;
 function context(){const b=planner.boundary();return {...b,state:path.join(b.paths.dsh.path,'dual-host-onboarding')};}
 async function json(file){const s=await snapshot(file,2097152);if(s.missing)return null;try{return JSON.parse(bytes(s));}catch{fail('MAINTENANCE_JOURNAL_REVIEW');}}
 function allowed(c,p){return c.paths.globalCandidates.includes(p)||typeof p==='string'&&/^[a-z][a-z0-9-]{1,79}$/.test(path.basename(path.dirname(p)))&&p===path.join(c.paths.dsh.path,'skills',path.basename(path.dirname(p)),'SKILL.md');}
 function validate(c,j){
  if(!j||j.schema!==2||!uuid(j.id)||!digest(j.fingerprint)||!['upgrade','repair','uninstall'].includes(j.action)||!['applying','committed','rolling_back','rolled_back','needs_review'].includes(j.state)||
   !Array.isArray(j.items)||j.items.length>65||new Set(j.items.map(x=>x?.path)).size!==j.items.length||!Array.isArray(j.dirs)||j.dirs.length>132||!object(j.beforeManifest)||!object(j.beforeLatest))fail('MAINTENANCE_JOURNAL_REVIEW');
  for(const i of j.items){
   if(!allowed(c,i?.path)||!['create','replace','remove'].includes(i.action)||!['pending','intent','done','restored'].includes(i.phase)||!object(i.before)||
    (i.action==='create'&&!i.before.missing)||i.action==='replace'&&i.before.missing||
    !i.before.missing&&(typeof i.before.data!=='string'||hash(bytes(i.before))!==i.before.sha256||bytes(i.before).length!==i.before.size)||
    (i.after===null?i.afterHash!==null:typeof i.after!=='string'||i.after.length>360000||hash(Buffer.from(i.after,'base64'))!==i.afterHash)||
    (i.published&&(!digest(i.published.sha256)||i.published.sha256!==i.afterHash||i.published.size!==Buffer.from(i.after??'','base64').length)))fail('MAINTENANCE_JOURNAL_REVIEW');
  }
  for(const d of j.dirs)if(!j.items.some(i=>inside(d.path,path.dirname(i.path)))||!c.roots.some(root=>inside(root,d.path)))fail('MAINTENANCE_JOURNAL_REVIEW');
  if(!Array.isArray(j.ownedDirs)||j.ownedDirs.length>132||j.ownedDirs.some(d=>!object(d)||!inside(path.join(c.paths.dsh.path,'skills'),d.path)||!d.identity))fail('MAINTENANCE_JOURNAL_REVIEW');
  for(const s of [j.beforeManifest,j.beforeLatest])if(s.missing||typeof s.data!=='string'||hash(bytes(s))!==s.sha256||bytes(s).length!==s.size)fail('MAINTENANCE_JOURNAL_REVIEW');
  if(j.action==='uninstall'){if(j.afterManifest!==null)fail('MAINTENANCE_JOURNAL_REVIEW');}
  else if(!j.afterManifest||j.afterManifest.schema!==2||j.afterManifest.id!==j.id||!Array.isArray(j.afterManifest.files)||j.afterManifest.files.length>65||
   j.afterManifest.files.some(f=>!allowed(c,f?.path)||!digest(f.sha256)||!digest(f.sourceHash)||typeof f.managedData!=='string'||hash(Buffer.from(f.managedData,'base64'))!==f.sourceHash))fail('MAINTENANCE_JOURNAL_REVIEW');
 }
 const dir=(c,id)=>path.join(c.state,'maintenance-transactions',id);
 async function read(c,id){if(!uuid(id))fail('INVALID_ARGUMENTS');const j=await json(path.join(dir(c,id),'journal.json'));if(j)validate(c,j);return j;}
 async function save(c,j){await atomicState(path.join(dir(c,j.id),'journal.json'),j);}
 async function knownLock(c,id){const lock=await json(path.join(c.state,'lock.json'));if(lock?.id!==id||lock.kind!=='maintenance')fail('MAINTENANCE_LOCK_REVIEW');return lock;}
 async function inactive(c,lock){
  if(active.has(c.state))fail('MAINTENANCE_BUSY');if(!Number.isSafeInteger(lock.pid)||lock.pid<1)fail('MAINTENANCE_LOCK_REVIEW');
  // A lock from this process is stale only when its in-process transaction is gone.
  if(lock.pid!==process.pid)try{process.kill(lock.pid,0);fail('MAINTENANCE_BUSY');}catch(e){if(e.code!=='ESRCH')throw e;}
 }
 async function ensureDirs(c,j,folder){
  for(const entry of (await ancestors(folder)).filter(x=>x.missing)){
   if(!c.roots.some(root=>inside(root,entry.path)))fail('UNSAFE_PATH');
   const d={path:entry.path,identity:null};j.dirs.push(d);await save(c,j);
   await fs.mkdir(entry.path,{mode:0o700});d.identity=identity(await fs.lstat(entry.path));await save(c,j);
  }
 }
 async function preview(args){
  if(!object(args)||Object.keys(args).join()!=='action'||!['upgrade','repair','uninstall'].includes(args.action))fail('INVALID_ARGUMENTS');
  const p=await planner.prepare(args.action);p.id=randomUUID();p.expiresAt=now()+300000;plans.clear();plans.set(p.id,p);
  const needsChange=p.operations.length>0||p.view.installedVersion!==p.view.targetVersion||args.action==='uninstall';
  return {...p.view,id:p.id,expiresAt:p.expiresAt,canApply:p.view.planReady&&needsChange,mutationAvailable:true};
 }
 async function operationStatus(args={}){
  if(!object(args)||Object.keys(args).some(k=>k!=='id'))fail('INVALID_ARGUMENTS');const c=context();
  if(args.id){const j=await read(c,args.id);if(!j)fail('MAINTENANCE_OPERATION_NOT_FOUND');return receipt(j);}
  const lock=await json(path.join(c.state,'lock.json'));
  if(lock?.kind==='maintenance'){const j=await read(c,lock.id);return j?{...receipt(j),canRecover:true,recoveryAction:j.state==='committed'?'finalize_receipt':'rollback_incomplete_changes'}:{id:lock.id,state:'needs_review',canRecover:false,error:'ONBOARDING_MAINTENANCE_INCOMPLETE_JOURNAL'};}
  const latest=await json(path.join(c.state,'latest.json'));let lastReceipt=null;
  if(latest?.kind==='maintenance'){
   const j=await read(c,latest.id);if(!j)fail('MAINTENANCE_JOURNAL_REVIEW');lastReceipt=receipt(j);
   if(j.state==='committed'&&j.action==='uninstall'){
    if(!(await snapshot(path.join(c.state,'installed.json'))).missing)fail('MAINTENANCE_MANIFEST_DRIFT');
    return {...receipt(j),state:'uninstalled',canRecover:false};
   }
  }
  return {...await planner.status(),mutationAvailable:true,lastReceipt};
 }
 async function restoreState(file,before,after){
  const current=await snapshot(file,2097152);if(equal(current,before)||!current.missing&&!before.missing&&current.sha256===before.sha256&&current.mode===before.mode)return;
  if(after===null?!current.missing:current.sha256!==hash(JSON.stringify(after)))fail('MAINTENANCE_STATE_DRIFT');
  if(before.missing){if(!current.missing){await fs.unlink(file);await syncDirectory(path.dirname(file));}}
  else await atomicState(file,JSON.parse(bytes(before)));
 }
 async function cleanupDirectories(c,j){
  if(j.action!=='uninstall')return;
  const results=[];
  for(const d of [...j.ownedDirs].sort((a,b)=>b.path.length-a.path.length)){
   try{await ancestors(path.dirname(d.path));const s=await statMaybe(d.path);
    if(!s){results.push({path:d.path,state:'absent'});continue;}
    if(!s.isDirectory()||s.isSymbolicLink()||!sameIdentity(s,d.identity))fail('MAINTENANCE_DIRECTORY_DRIFT');
    await fs.rmdir(d.path);await syncDirectory(path.dirname(d.path));results.push({path:d.path,state:'removed_empty_owned_directory'});
   }catch{results.push({path:d.path,state:'retained_nonempty_or_changed'});}
  }
  j.directoryResults=results;await save(c,j);
 }
 async function rollback(c,j){
  j.state='rolling_back';await save(c,j);const review=[];
  for(let n=j.items.length-1;n>=0;n--){const i=j.items[n];try{await rollbackMaintenanceItem(i,dir(c,j.id),n);i.phase='restored';await save(c,j);}catch{review.push({path:i.path,reason:'changed_or_unreadable_preserved',backup:path.join(dir(c,j.id),'backup-'+n)});}}
  for(const d of [...j.dirs].reverse())try{const s=await statMaybe(d.path);if(!s)continue;if(!sameIdentity(s,d.identity)||s.isSymbolicLink())fail('MAINTENANCE_DIRECTORY_DRIFT');await fs.rmdir(d.path);}catch{review.push({path:d.path,reason:'directory_preserved'});}
  try{await restoreState(path.join(c.state,'installed.json'),j.beforeManifest,j.afterManifest);}catch{review.push({path:path.join(c.state,'installed.json'),reason:'manifest_preserved'});}
  try{await restoreState(path.join(c.state,'latest.json'),j.beforeLatest,{id:j.id,kind:'maintenance'});}catch{review.push({path:path.join(c.state,'latest.json'),reason:'latest_preserved'});}
  j.review=review;j.state=review.length?'needs_review':'rolled_back';await save(c,j);
  if(!review.length){await knownLock(c,j.id);await fs.unlink(path.join(c.state,'lock.json'));await syncDirectory(c.state);}
  return receipt(j);
 }
 async function apply(args){
  if(!object(args)||Object.keys(args).sort().join()!=='confirm,fingerprint,id'||args.confirm!==true||!uuid(args.id)||!digest(args.fingerprint))fail('INVALID_ARGUMENTS');
  if(busy)fail('MAINTENANCE_BUSY');const c=context(),prior=await read(c,args.id);
  if(prior){if(prior.fingerprint!==args.fingerprint)fail('MAINTENANCE_RECEIPT_MISMATCH');return receipt(prior);}
  const plan=plans.get(args.id);if(!plan||now()>plan.expiresAt||args.fingerprint!==plan.view.fingerprint)fail('PLAN_EXPIRED');
  if(!plan.view.planReady)fail('PLAN_BLOCKED');busy=true;plans.delete(args.id);let j,locked=false;
  try{
   const fresh=await planner.prepare(plan.view.action);if(fresh.view.fingerprint!==args.fingerprint)fail('PLAN_DRIFT');
   if(!fresh.operations.length&&fresh.view.installedVersion===fresh.view.targetVersion&&plan.view.action!=='uninstall')fail('PLAN_BLOCKED');
   const beforeManifest=await snapshot(path.join(c.state,'installed.json'),2097152),beforeLatest=await snapshot(path.join(c.state,'latest.json'),2097152);
   j={schema:2,id:args.id,fingerprint:args.fingerprint,action:plan.view.action,state:'applying',createdAt:now(),
    items:fresh.operations.map(x=>({...x,phase:'pending'})),dirs:[],ownedDirs:fresh.ownedDirs,beforeManifest,beforeLatest,
    afterManifest:plan.view.action==='uninstall'?null:{schema:2,id:args.id,version:fresh.view.targetVersion,files:fresh.nextFiles}};
   if(Buffer.byteLength(JSON.stringify(j))>1900000)fail('MAINTENANCE_JOURNAL_LIMIT');validate(c,j);
   try{await syncWrite(path.join(c.state,'lock.json'),JSON.stringify({id:args.id,pid:process.pid,kind:'maintenance'}));locked=true;active.add(c.state);}catch(e){if(e.code==='EEXIST')fail('MAINTENANCE_BUSY');throw e;}
   await runtime.maintenanceHook?.('after_lock',-1,null);
   await ancestors(path.join(c.state,'maintenance-transactions'));await fs.mkdir(path.join(c.state,'maintenance-transactions'),{recursive:true,mode:0o700});await fs.mkdir(dir(c,args.id),{mode:0o700});await save(c,j);
   for(let n=0;n<j.items.length;n++){await ensureDirs(c,j,path.dirname(j.items[n].path));await publishMaintenanceItem(j.items[n],dir(c,j.id),n,()=>save(c,j),runtime.maintenanceHook);}
   for(const i of j.items){const s=await snapshot(i.path);if(i.after===null?!s.missing:s.sha256!==i.afterHash||!sameIdentity(s,i.published))fail('MAINTENANCE_FILE_DRIFT');}
   if(j.afterManifest){j.afterManifest.ownedDirs=[...new Map([...j.ownedDirs,...j.dirs].map(d=>[d.path,d])).values()];await save(c,j);}
   if(!equal(await snapshot(path.join(c.state,'installed.json'),2097152),beforeManifest)||!equal(await snapshot(path.join(c.state,'latest.json'),2097152),beforeLatest))fail('MAINTENANCE_STATE_DRIFT');
   if(j.afterManifest===null){await fs.unlink(path.join(c.state,'installed.json'));await syncDirectory(c.state);}else await atomicState(path.join(c.state,'installed.json'),j.afterManifest);
   await runtime.maintenanceHook?.('after_manifest',-1,null);
   await atomicState(path.join(c.state,'latest.json'),{id:j.id,kind:'maintenance'});
   j.state='committed';await save(c,j);await runtime.maintenanceHook?.('after_commit',-1,null);await cleanupDirectories(c,j);
   await knownLock(c,j.id);await fs.unlink(path.join(c.state,'lock.json'));await syncDirectory(c.state);return receipt(j);
  }catch(e){
   if(locked&&j&&await statMaybe(path.join(dir(c,j.id),'journal.json'))){
    // Committed means the mutation succeeded; don't undo it due to lost cleanup/reply.
    if(j.state==='committed')return receipt(j);
    j.error=/^ONBOARDING_[A-Z_]+$/.test(e.message)?e.message:'ONBOARDING_MAINTENANCE_FAILED';return await rollback(c,j);
   }throw e;
  }finally{busy=false;if(locked)active.delete(c.state);}
 }
 async function recoveryPreview(args){
  if(!object(args)||Object.keys(args).join()!=='id'||!uuid(args.id))fail('INVALID_ARGUMENTS');const c=context(),lock=await knownLock(c,args.id);await inactive(c,lock);
  const j=await read(c,args.id);if(!j)fail('MAINTENANCE_JOURNAL_REVIEW');
  const observations=[];
  for(let n=0;n<j.items.length;n++)for(const f of [j.items[n].path,path.join(dir(c,j.id),'backup-'+n),path.join(dir(c,j.id),'stage-'+n)]){
   try{const s=await snapshot(f);observations.push({path:f,snapshot:s});}catch{const s=await statMaybe(f);observations.push({path:f,unreadable:true,identity:s?identity(s):null});}
  }
  const fingerprint=hash(JSON.stringify({j,lock,observations})),p={id:j.id,fingerprint,expiresAt:now()+300000,action:j.state==='committed'?'finalize_receipt':'rollback_incomplete_changes',state:j.state,confirmRequired:true};
  recoveries.clear();recoveries.set(j.id,p);return p;
 }
 async function recover(args){
  if(!object(args)||Object.keys(args).sort().join()!=='confirm,fingerprint,id'||args.confirm!==true||!uuid(args.id))fail('INVALID_ARGUMENTS');
  if(busy)fail('MAINTENANCE_BUSY');const old=recoveries.get(args.id);if(!old||old.fingerprint!==args.fingerprint||now()>old.expiresAt)fail('PLAN_EXPIRED');
  const fresh=await recoveryPreview({id:args.id});if(fresh.fingerprint!==old.fingerprint)fail('PLAN_DRIFT');recoveries.delete(args.id);
  const c=context(),j=await read(c,args.id);busy=true;active.add(c.state);
  try{
   if(j.state==='committed'){
    const manifest=await json(path.join(c.state,'installed.json')),latest=await json(path.join(c.state,'latest.json'));
    if(!equal(manifest,j.afterManifest)||latest?.id!==j.id||latest.kind!=='maintenance')fail('MAINTENANCE_STATE_DRIFT');
    for(const i of j.items){const s=await snapshot(i.path);if(i.after===null?!s.missing:s.sha256!==i.afterHash||!sameIdentity(s,i.published))fail('MAINTENANCE_FILE_DRIFT');}
    await cleanupDirectories(c,j);await knownLock(c,j.id);await fs.unlink(path.join(c.state,'lock.json'));await syncDirectory(c.state);return receipt(j);
   }
   return await rollback(c,j);
  }finally{busy=false;active.delete(c.state);}
 }
 return {available:planner.available,preview,apply,status:operationStatus,recoveryPreview,recover};
}
