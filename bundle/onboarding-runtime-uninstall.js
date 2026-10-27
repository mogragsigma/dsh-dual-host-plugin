// Original-archive, offline three-artifact removal. The installed image is
// retired by no-replace rename, not recursively deleted. User data, dependency
// installation and every version/repair backup remain outside this operation.
import {randomUUID} from 'node:crypto';
import {createOnboardingMaintenance} from './onboarding-maintenance.js';
import {createMaintenancePlanner} from './onboarding-maintenance-plan.js';
import {snapshot,bytes} from './onboarding-install-fs.js';
import {syncDirectory} from './onboarding-maintenance-fs.js';
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const exact=(x,k)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join()===k.slice().sort().join();
const terminal=r=>['committed','rolled_back'].includes(r.state);
const op=x=>({path:x.path,kind:x.kind,before:x.before,after:x.after,afterHash:x.afterHash,action:x.action});

export function createRuntimeUninstall(api,q,j,{current,guard,moveImage,artifacts}){
 const {fs,path,hash,fail,regular,signed,verified,atomicJSON,checkAncestors}=api,now=api.versionNow??Date.now;
 const control=path.join(q.root,'.control/runtime'),file=path.join(control,'plugin-uninstall.json'),planFile=path.join(control,'plugin-uninstall-plan.json');
 const target=path.join(q.root,'runtime/plugin'),retired=path.join(control,'retired-plugin');
 const home=path.join(q.root,'runtime/native-home'),dsh=path.join(home,'dsh'),state=path.join(dsh,'dual-host-onboarding');
 const config={onboarding:{role:'cloud',installation:{enabled:true,isolatedRoot:path.join(q.root,'runtime')}}};
 const options={home,env:{HOME:home,DSH_HOME:dsh,DSH_AGENTS_HOME:path.join(home,'agents'),DSH_ONBOARDING_ISOLATED_ROOT:path.join(q.root,'runtime')},source:target,maintenanceHook:api.artifactsHook};
 const binding=hash({root:q.root,operationId:q.operationId,runtimeId:j.id,inventoryHash:j.inventoryHash});
 const bad=code=>fail('RUNTIME_UNINSTALL_'+code);
 async function exists(p){await checkAncestors(path.dirname(p));try{return await fs.lstat(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async function load(p){const f=await regular(p,16777216);if(!f)return null;if(f.identity.uid!==process.getuid()||f.identity.mode!==0o600)bad('LEDGER_REVIEW');try{return verified(JSON.parse(f.data),q.proof);}catch{bad('LEDGER_REVIEW');}}
 async function save(p,d){if(Buffer.byteLength(JSON.stringify(d))>16000000)bad('HISTORY_LIMIT');await atomicJSON(p,signed(d,q.proof));}
 async function ledger(){
  const d=await load(file);if(!d){if(await exists(retired))bad('LEDGER_REVIEW');return {schema:1,binding,records:[]};}
  if(!exact(d,['schema','binding','records'])||d.schema!==1||d.binding!==binding||!Array.isArray(d.records)||d.records.length>16||new Set(d.records.map(r=>r.id)).size!==d.records.length)bad('LEDGER_REVIEW');
  for(const [i,r] of d.records.entries()){
   if(!exact(r,['id','fingerprint','state','image','beforeMetadata','artifactLedgerHash','innerId','innerFingerprint','operations','restoredMetadataHash','updatedAt'])||!uuid(r.id)||!uuid(r.innerId)||![r.fingerprint,r.artifactLedgerHash,r.innerFingerprint].every(hex)||!['intent','rules_removed','capturing','committed','rolled_back'].includes(r.state)||i<d.records.length-1&&r.state!=='rolled_back'||!Array.isArray(r.operations)||r.operations.length>65||!r.beforeMetadata||!hex(r.beforeMetadata.hash)||!hex(r.beforeMetadata.contentHash)||!Array.isArray(r.beforeMetadata.rows)||!Number.isSafeInteger(r.updatedAt)||r.restoredMetadataHash!==null&&!hex(r.restoredMetadataHash)||r.state==='rolled_back'&&!hex(r.restoredMetadataHash)||!r.image?.version||!Array.isArray(r.image.image)||r.image.image.length>4096)bad('LEDGER_REVIEW');
  }return d;
 }
 const view=(r,extra={})=>({contract:1,operationId:q.operationId,runtimeId:j.id,scope:'owned_plugin_rules_skills_only',id:r?.id??null,state:r?.state??'not_requested',version:r?.image.version??null,recoveryRequired:!!r&&!terminal(r),historical:true,pluginInstalled:r?.state==='committed'?false:null,hostStarted:false,initialization:false,activationVerified:false,automaticRetry:false,dependenciesRemoved:false,userDataPreserved:true,backupsRetained:true,managedRestartBlocked:!!r&&r.state!=='rolled_back',...extra});
 async function assertOpen(){const r=(await ledger()).records.at(-1);if(r&&r.state!=='rolled_back')bad(r.state==='committed'?'ALREADY_UNINSTALLED':'RECOVERY_REQUIRED');}
 async function restored(){const r=(await ledger()).records.at(-1);return r?.state==='rolled_back'?{metadataHash:r.restoredMetadataHash,artifactLedgerHash:r.artifactLedgerHash}:null;}
 async function metadata(){return (await artifacts()).metadata();}
 async function imageAt(location,image){
  await checkAncestors(path.dirname(location));const rows=image.image,seen=new Set();
  if(!rows.some(x=>x.path===''&&x.kind==='directory'))bad('IMAGE_REVIEW');
  for(const x of rows){
   if(typeof x.path!=='string'||x.path&&(!/^[A-Za-z0-9_./-]+$/.test(x.path)||x.path.split('/').some(n=>!n||n==='.'||n==='..'))||seen.has(x.path)||!['file','directory'].includes(x.kind))bad('IMAGE_REVIEW');seen.add(x.path);
   const p=path.join(location,x.path);await checkAncestors(path.dirname(p));const s=await exists(p);
   if(!s||s.isSymbolicLink()||s.dev!==x.dev||s.ino!==x.ino||s.uid!==x.uid||(s.mode&0o777)!==x.mode)bad('IMAGE_DRIFT');
   if(x.kind==='directory'){
    if(!s.isDirectory())bad('IMAGE_DRIFT');const names=rows.filter(y=>y.path&&path.posix.dirname(y.path)===(x.path||'.')).map(y=>path.posix.basename(y.path)).sort();
    if(hash((await fs.readdir(p)).sort())!==hash(names))bad('IMAGE_DRIFT');
   }else{const f=await regular(p,4194304);if(!f||f.sha256!==x.sha256||f.data.length!==x.bytes||f.identity.ino!==x.ino||f.identity.dev!==x.dev)bad('IMAGE_DRIFT');}
  }
 }
 async function location(r){
  const a=await exists(target),b=await exists(retired);
  if(a&&!b){await imageAt(target,r.image);return 'installed';}
  if(!a&&b&&['capturing','committed'].includes(r.state)){await imageAt(retired,r.image);return 'retired';}
  bad('IMAGE_DRIFT');
 }
 async function preflight(){
  await guard();await assertOpen();if(await exists(retired))bad('IMAGE_DRIFT');
  const image=await current();await imageAt(target,image);
  const owner=await (await artifacts()).ownership(),p=await createMaintenancePlanner(config,options).prepare('uninstall');
  if(!p.view.planReady)return {blocked:p.view};
  const root=await fs.lstat(control);if(image.image.some(x=>x.dev!==root.dev))bad('CROSS_DEVICE');
  return {image,owner,p};
 }
 function publicPlan(p,v={}){return {contract:1,operationId:q.operationId,runtimeId:j.id,id:p.id,fingerprint:p.fingerprint,expiresAt:p.expiresAt,scope:'owned_plugin_rules_skills_only',hostStarted:false,activationVerified:false,initialization:false,automaticRetry:false,dependenciesRemoved:false,backupsRetained:true,userDataPreserved:true,...v};}
 async function writePlan(body){const p={schema:1,binding,id:randomUUID(),expiresAt:now()+300000,...body};p.fingerprint=hash(p);await save(planFile,p);return p;}
 async function plan(a,kind){
  if(!exact(a,['id','fingerprint','confirm'])||a.confirm!==true||!uuid(a.id)||!hex(a.fingerprint))bad('CONFIRMATION_REQUIRED');
  const p=await load(planFile);if(!p||p.schema!==1||p.binding!==binding||p.kind!==kind||p.id!==a.id||p.fingerprint!==a.fingerprint||p.expiresAt<=now())bad('PLAN_DRIFT');
  const {fingerprint,...body}=p;if(hash(body)!==fingerprint)bad('PLAN_DRIFT');return p;
 }
 async function preview(){
  const c=await preflight();if(c.blocked)return publicPlan({id:null,fingerprint:null,expiresAt:null},{canApply:false,conflicts:c.blocked.conflicts,changes:[],retained:c.blocked.retained});
  const p=await writePlan({kind:'apply',imageHash:hash(c.image),metadataHash:c.owner.metadata.hash,artifactLedgerHash:c.owner.ledgerHash,innerFingerprint:c.p.view.fingerprint});
  return publicPlan(p,{canApply:true,version:c.image.version,changes:[{path:target,action:'retire_owned_image',files:c.image.manifest.length},...c.p.view.changes],conflicts:[],retained:[{path:home,reason:'user_configuration_credentials_sessions_preserved'},{path:path.join(q.root,'runtime/workspace'),reason:'tasks_and_artifacts_preserved'},{path:control,reason:'all_history_and_retired_image_preserved'},...c.p.view.retained]});
 }
 async function inner(r){
  const f=await snapshot(path.join(state,'maintenance-transactions',r.innerId,'journal.json'),2097152);if(f.missing)bad('INNER_JOURNAL_REQUIRED');
  let x;try{x=JSON.parse(bytes(f));}catch{bad('INNER_JOURNAL_REVIEW');}
  const before=new Map(r.beforeMetadata.rows);
  if(x.schema!==2||x.id!==r.innerId||x.action!=='uninstall'||x.fingerprint!==r.innerFingerprint||x.afterManifest!==null||hash(x.beforeManifest)!==hash(before.get(path.join(state,'installed.json')))||hash(x.beforeLatest)!==hash(before.get(path.join(state,'latest.json')))||!Array.isArray(x.items)||hash(x.items.map(op))!==hash(r.operations))bad('INNER_JOURNAL_REVIEW');
  const svc=createOnboardingMaintenance(config,options),s=await svc.status({id:r.innerId});return {x,s,svc};
 }
 async function result(r){
  const v=await inner(r),live=await v.svc.status();if(live.canRecover)bad('INNER_RECOVERY_REQUIRED');
  if(v.s.state==='rolled_back'){
   for(const i of r.operations){const s=await snapshot(i.path);if(i.before.missing?!s.missing:s.missing||s.sha256!==i.before.sha256||s.mode!==i.before.mode)bad('RESTORE_REVIEW');}
   const m=await metadata();if(m.contentHash!==r.beforeMetadata.contentHash)bad('RESTORE_REVIEW');
   return {state:'rolled_back',metadata:m};
  }
  if(v.s.state!=='committed'||live.state!=='uninstalled'||live.id!==r.innerId)bad('INNER_RECOVERY_REQUIRED');
  for(const [n,i] of r.operations.entries()){
   const s=await snapshot(i.path),published=v.x.items[n].published;
   if(i.after===null?!s.missing:s.missing||s.sha256!==i.afterHash||s.mode!==i.before.mode||!published||s.ino!==published.ino||s.dev!==published.dev)bad('RULES_DRIFT');
  }
  return {state:'uninstalled'};
 }
 async function update(d,r,values){Object.assign(r,values,{updatedAt:now()});await save(file,d);}
 async function finish(d,r){
  await guard();const state=await result(r),where=await location(r);
  if(state.state==='rolled_back'){
   if(where!=='installed')bad('RESTORE_REVIEW');await update(d,r,{state:'rolled_back',restoredMetadataHash:state.metadata.hash});return view(r,{historical:false});
  }
  if(r.state==='intent')await update(d,r,{state:'rules_removed'});
  await api.uninstallHook?.('rules_removed');
  if(where==='installed'){
   await update(d,r,{state:'capturing'});await guard();await imageAt(target,r.image);if(await exists(retired))bad('IMAGE_DRIFT');
   await api.uninstallHook?.('before_capture');await moveImage(target,retired);await syncDirectory(path.dirname(target));await syncDirectory(path.dirname(retired));await api.uninstallHook?.('after_capture');
  }
  await guard();if(await location(r)!=='retired')bad('IMAGE_DRIFT');await result(r);
  await update(d,r,{state:'committed'});await api.uninstallHook?.('after_commit');return view(r,{historical:false});
 }
 async function apply(a){
  if(!exact(a,['id','fingerprint','confirm'])||a.confirm!==true||!uuid(a.id)||!hex(a.fingerprint))bad('CONFIRMATION_REQUIRED');
  await guard();const d=await ledger(),prior=d.records.find(r=>r.id===a.id);
  if(prior){if(a.fingerprint!==prior.fingerprint)bad('PLAN_DRIFT');return view(prior,{notResent:true});}
  const p=await plan(a,'apply'),c=await preflight();
  if(c.blocked||hash(c.image)!==p.imageHash||c.owner.metadata.hash!==p.metadataHash||c.owner.ledgerHash!==p.artifactLedgerHash||c.p.view.fingerprint!==p.innerFingerprint)bad('PLAN_DRIFT');
  if(d.records.length>=16)bad('HISTORY_LIMIT');const svc=createOnboardingMaintenance(config,options),v=await svc.preview({action:'uninstall'});
  if(!v.canApply||v.fingerprint!==p.innerFingerprint)bad('PLAN_DRIFT');
  const r={id:p.id,fingerprint:p.fingerprint,state:'intent',image:c.image,beforeMetadata:c.owner.metadata,artifactLedgerHash:c.owner.ledgerHash,innerId:v.id,innerFingerprint:v.fingerprint,operations:c.p.operations.map(op),restoredMetadataHash:null,updatedAt:now()};d.records.push(r);await save(file,d);
  await api.uninstallHook?.('intent_saved');await guard();await imageAt(target,r.image);
  await svc.apply({id:v.id,fingerprint:v.fingerprint,confirm:true});await api.uninstallHook?.('rules_returned');
  return finish(d,r);
 }
 async function recoveryState(r){
  await guard();const where=await location(r),lock=await snapshot(path.join(state,'lock.json'),2097152);
  // A missing inner journal alone is never evidence of non-execution. Only the
  // pre-call outer phase, absence of both lock AND transaction directory, and
  // exact original file/metadata identities can authorize a separate cancellation.
  const innerDir=path.join(state,'maintenance-transactions',r.innerId);
  if(r.state==='intent'&&where==='installed'&&lock.missing&&!await exists(innerDir)){
   const m=await metadata();if(m.hash!==r.beforeMetadata.hash)bad('INNER_JOURNAL_REQUIRED');
   for(const i of r.operations)if(hash(await snapshot(i.path))!==hash(i.before))bad('INNER_JOURNAL_REQUIRED');
   return {where,innerState:'not_observed',metadataHash:m.hash,recovery:{action:'cancel_proven_unstarted_uninstall'}};
  }
  const v=await inner(r);
  const recovery=lock.missing?null:await v.svc.recoveryPreview({id:r.innerId});
  if(!recovery)await result(r);
  return {where,innerState:v.s.state,innerJournalHash:hash(v.x),lockHash:hash(lock),recovery:recovery?{id:recovery.id,fingerprint:recovery.fingerprint,action:recovery.action,state:recovery.state}:null};
 }
 async function recoveryPreview(a){
  if(!exact(a,['id'])||!uuid(a.id))bad('ARGUMENTS');const d=await ledger(),r=d.records.at(-1);if(!r||r.id!==a.id||terminal(r))bad('RECOVERY_REQUIRED');
  const s=await recoveryState(r),p=await writePlan({kind:'recover',targetId:r.id,recordHash:hash(r),observationHash:hash(s)});
  return publicPlan(p,{transactionId:r.id,action:s.recovery?.action??'finish_recorded_uninstall',confirmRequired:true});
 }
 async function recover(a){
  const p=await plan(a,'recover'),d=await ledger(),r=d.records.at(-1);if(!r||r.id!==p.targetId||hash(r)!==p.recordHash||terminal(r))bad('PLAN_DRIFT');
  const s=await recoveryState(r);if(hash(s)!==p.observationHash)bad('PLAN_DRIFT');
  if(s.recovery?.action==='cancel_proven_unstarted_uninstall'){
   await update(d,r,{state:'rolled_back',restoredMetadataHash:s.metadataHash});return view(r,{historical:false,cancelledBeforeInnerAction:true});
  }
  if(s.recovery){const v=await inner(r),fresh=await v.svc.recoveryPreview({id:r.innerId});if(fresh.fingerprint!==s.recovery.fingerprint)bad('PLAN_DRIFT');await v.svc.recover({id:r.innerId,fingerprint:fresh.fingerprint,confirm:true});}
  return finish(d,r);
 }
 async function status(a={}){if(!exact(a,[])&&!exact(a,['id'])||a.id!==undefined&&!uuid(a.id))bad('ARGUMENTS');const d=await ledger(),r=a.id?d.records.find(r=>r.id===a.id):d.records.at(-1);if(a.id&&!r)bad('NOT_FOUND');return view(r);}
 async function reclamationProof(){
  // The reclamation caller separately verifies the stopped runtime and immutable
  // deletion ownership. Later user rule/data edits do not invalidate a completed
  // historical uninstall and must not be read into deletion ownership.
  const r=(await ledger()).records.at(-1);
  if(!r||r.state!=='committed')bad('NOT_COMPLETED');
  if(await location(r)!=='retired')bad('RESULT_REVIEW');
  return view(r);
 }
 return {preview,apply,status,recoveryPreview,recover,assertOpen,restored,reclamationProof};
}
