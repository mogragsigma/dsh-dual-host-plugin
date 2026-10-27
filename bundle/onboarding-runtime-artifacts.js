// Executed from the original archive, never from the candidate. Candidate rules
// and Skills are data for the existing protective installer/maintenance engine.
import {randomUUID} from 'node:crypto';
import {createOnboardingMaintenance} from './onboarding-maintenance.js';
import {createMaintenancePlanner} from './onboarding-maintenance-plan.js';
import {snapshot,bytes} from './onboarding-install-fs.js';
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const exact=(x,k)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join()===k.slice().sort().join();
export function createRuntimeArtifacts(api,q,j,{original,effective,guard}){
 const {path,hash,fail,regular,signed,verified,atomicJSON}=api,now=api.versionNow??Date.now;
 const base=path.join(q.root,'runtime'),home=path.join(base,'native-home'),dsh=path.join(home,'dsh'),agents=path.join(home,'agents');
 const state=path.join(dsh,'dual-host-onboarding'),control=path.join(q.root,'.control/runtime');
 const ledgerFile=path.join(control,'plugin-artifacts.json'),planFile=path.join(control,'plugin-artifacts-plan.json');
 const binding=hash({operationId:q.operationId,runtimeId:j.id,inventoryHash:j.inventoryHash,installationId:j.rules?.transactionId??null});
 const env={HOME:home,DSH_HOME:dsh,DSH_AGENTS_HOME:agents,DSH_ONBOARDING_ISOLATED_ROOT:base};
 const config={onboarding:{role:'cloud',installation:{enabled:true,isolatedRoot:base}}};
 const options={env,home,source:path.join(base,'plugin'),maintenanceHook:api.artifactsHook};
 const service=()=>createOnboardingMaintenance(config,options),planner=()=>createMaintenancePlanner(config,options);
 const terminal=r=>['committed','rolled_back'].includes(r.state);
 const view=r=>({contract:1,scope:'stopped_owned_rules_and_skills_only',operationId:q.operationId,runtimeId:j.id,id:r?.id??null,
  state:r?.state??'not_requested',version:r?.version??null,recoveryRequired:!!r&&!terminal(r),historical:true,
  hostStarted:false,activationVerified:false,initialization:false,pluginBinaryChanged:false,credentialsChanged:false});
 async function json(file){const f=await regular(file,2097152);if(!f)return null;if(f.identity.uid!==process.getuid()||f.identity.mode!==0o600)fail('RUNTIME_ARTIFACTS_RECORD_REVIEW');return verified(JSON.parse(f.data),q.proof);}
 async function save(file,d){await atomicJSON(file,signed(d,q.proof));}
 async function read(){
  const d=await json(ledgerFile);if(!d)return {schema:1,binding,records:[]};
  if(!exact(d,['schema','binding','records'])||d.schema!==1||d.binding!==binding||!Array.isArray(d.records)||d.records.length>128)fail('RUNTIME_ARTIFACTS_RECORD_REVIEW');
  const seen=new Set();for(const r of d.records){
   if(!exact(r,['id','maintenanceId','fingerprint','innerFingerprint','imageHash','version','beforeHash','beforeContentHash','afterHash','state','updatedAt'])||!uuid(r.id)||!uuid(r.maintenanceId)||seen.has(r.id)||![r.fingerprint,r.innerFingerprint,r.imageHash,r.beforeHash,r.beforeContentHash].every(hex)||r.afterHash!==null&&!hex(r.afterHash)||typeof r.version!=='string'||r.version.length>100||!['requested','committed','rolled_back','needs_review'].includes(r.state)||!Number.isSafeInteger(r.updatedAt)||terminal(r)&&!hex(r.afterHash))fail('RUNTIME_ARTIFACTS_RECORD_REVIEW');seen.add(r.id);
  }return d;
 }
 function paths(){
  // A candidate/user cannot choose a different HOME through an RPC argument.
  if(j.nativeReceipt?.dshHome!==dsh||j.nativeReceipt?.agentsHome!==agents||j.nativeReceipt?.workspace!==path.join(base,'workspace')||!uuid(j.rules?.transactionId))fail('RUNTIME_ARTIFACTS_PATH_REVIEW');
 }
 async function metadata(){
  paths();const installed=await snapshot(path.join(state,'installed.json'),2097152),latest=await snapshot(path.join(state,'latest.json'),2097152);
  if(installed.missing||latest.missing)fail('RUNTIME_ARTIFACTS_OWNERSHIP_REVIEW');
  const m=JSON.parse(bytes(installed));if(![1,2].includes(m.schema)||!uuid(m.id))fail('RUNTIME_ARTIFACTS_OWNERSHIP_REVIEW');
  const name=path.join(state,m.schema===1?'transactions':'maintenance-transactions',m.id,'journal.json'),journal=await snapshot(name,2097152);
  if(journal.missing)fail('RUNTIME_ARTIFACTS_OWNERSHIP_REVIEW');
  return {hash:hash({installed,latest,journal}),contentHash:hash([installed,latest,journal].map(s=>({sha256:s.sha256,mode:s.mode}))),rows:[[path.join(state,'installed.json'),installed],[path.join(state,'latest.json'),latest],[name,journal]]};
 }
 async function owned(d){
  const m=await metadata(),last=d.records.at(-1),restored=await api.uninstallRestored?.();
  if(d.records.some(r=>!terminal(r)))fail('RUNTIME_ARTIFACTS_RECOVERY_REQUIRED');
  // Only a signed, rolled-back uninstall may update the metadata inode binding.
  // Once the artifacts ledger changes this bridge no longer applies.
  if(restored&&restored.artifactLedgerHash===hash(d)&&restored.metadataHash===m.hash)return m;
  if(last){if(!terminal(last))fail('RUNTIME_ARTIFACTS_RECOVERY_REQUIRED');if(m.hash!==last.afterHash)fail('RUNTIME_ARTIFACTS_OWNERSHIP_REVIEW');}
  else for(const [name,s] of m.rows){const row=original.items.find(x=>x.path===path.relative(q.root,name));if(!row||row.kind!=='file'||row.sha256!==s.sha256||row.bytes!==s.size||row.dev!==s.dev||row.ino!==s.ino||row.mode!==s.mode)fail('RUNTIME_ARTIFACTS_OWNERSHIP_REVIEW');}
  return m;
 }
 async function content(){
  const image=await effective(),p=await planner().prepare('upgrade');
  if(p.view.targetVersion!==image.version)fail('RUNTIME_ARTIFACTS_SOURCE_REVIEW');
  return {image,imageHash:hash(image),plan:p};
 }
 async function noPending(){if((await read()).records.some(r=>!terminal(r)))fail('RUNTIME_ARTIFACTS_RECOVERY_REQUIRED');}
 async function ready(){
  try{const d=await read();await owned(d);const c=await content();return c.plan.view.planReady&&c.plan.operations.length===0&&c.plan.view.installedVersion===c.image.version;}
  catch{return false;}
 }
 function publicPlan(p,v){return {...v,id:p.id,fingerprint:p.fingerprint,expiresAt:p.expiresAt,contract:1,scope:'stopped_owned_rules_and_skills_only',operationId:q.operationId,runtimeId:j.id,hostStarted:false,activationVerified:false,initialization:false,pluginBinaryChanged:false,credentialsChanged:false};}
 async function preview(){
  await guard();const d=await read(),m=await owned(d),c=await content();
  const v=c.plan.view;if(!v.planReady)return {...publicPlan({id:null,fingerprint:null,expiresAt:null},v),canApply:false};
  if(!c.plan.operations.length&&v.installedVersion===c.image.version)return {...publicPlan({id:null,fingerprint:null,expiresAt:null},v),canApply:false,artifactsMatched:true};
  const p={schema:1,binding,id:randomUUID(),kind:'upgrade',targetId:null,imageHash:c.imageHash,version:c.image.version,beforeHash:m.hash,innerFingerprint:v.fingerprint,expiresAt:now()+300000};p.fingerprint=hash(p);await save(planFile,p);
  return publicPlan(p,{...v,canApply:true,artifactsMatched:false});
 }
 async function plan(args,kind){
  if(!exact(args,['id','fingerprint','confirm'])||args.confirm!==true||!uuid(args.id)||!hex(args.fingerprint))fail('RUNTIME_ARTIFACTS_CONFIRMATION_REQUIRED');
  const p=await json(planFile);if(!p||p.schema!==1||p.binding!==binding||p.kind!==kind||p.id!==args.id||p.fingerprint!==args.fingerprint||p.expiresAt<=now())fail('RUNTIME_ARTIFACTS_PLAN_DRIFT');
  const {fingerprint,...body}=p;if(hash(body)!==fingerprint)fail('RUNTIME_ARTIFACTS_PLAN_DRIFT');return p;
 }
 async function innerJournal(r){
  const f=await snapshot(path.join(state,'maintenance-transactions',r.maintenanceId,'journal.json'),2097152);
  if(f.missing)fail('RUNTIME_ARTIFACTS_JOURNAL_REVIEW');const x=JSON.parse(bytes(f));
  if(x.id!==r.maintenanceId||x.fingerprint!==r.innerFingerprint||x.schema!==2||x.action!=='upgrade'||x.afterManifest?.version!==r.version||x.beforeManifest?.missing||x.beforeLatest?.missing)fail('RUNTIME_ARTIFACTS_JOURNAL_REVIEW');
  const old=JSON.parse(bytes(x.beforeManifest));if(![1,2].includes(old.schema)||!uuid(old.id))fail('RUNTIME_ARTIFACTS_JOURNAL_REVIEW');
  const prior=await snapshot(path.join(state,old.schema===1?'transactions':'maintenance-transactions',old.id,'journal.json'),2097152);
  if(prior.missing||hash({installed:x.beforeManifest,latest:x.beforeLatest,journal:prior})!==r.beforeHash)fail('RUNTIME_ARTIFACTS_JOURNAL_REVIEW');
 }
 async function settle(d,r){
  await innerJournal(r);
  const s=await service().status({id:r.maintenanceId});
  if(s.state==='committed'){
   const current=await service().status();if(current.canRecover||current.state!=='inspected')return {...view(r),state:'needs_review',recoveryRequired:true};
   const c=await content();if(c.imageHash!==r.imageHash||!c.plan.view.planReady||c.plan.operations.length||c.plan.view.installedVersion!==r.version)fail('RUNTIME_ARTIFACTS_CONTENT_REVIEW');
  }else if(s.state!=='rolled_back')return {...view(r),state:'needs_review',recoveryRequired:true};
  const m=await metadata();if(s.state==='rolled_back'&&m.contentHash!==r.beforeContentHash)fail('RUNTIME_ARTIFACTS_RESTORE_REVIEW');
  r.state=s.state;r.afterHash=m.hash;r.updatedAt=now();await save(ledgerFile,d);return {...view(r),historical:false};
 }
 async function apply(args){
  await guard();const d=await read(),prior=d.records.find(r=>r.id===args.id);
  if(prior){if(args.confirm!==true||args.fingerprint!==prior.fingerprint)fail('RUNTIME_ARTIFACTS_CONFIRMATION_REQUIRED');return {...view(prior),notResent:true};}
  const p=await plan(args,'upgrade'),m=await owned(d),c=await content();
  if(d.records.length>=128)fail('RUNTIME_ARTIFACTS_HISTORY_FULL');
  if(c.imageHash!==p.imageHash||m.hash!==p.beforeHash||c.plan.view.fingerprint!==p.innerFingerprint||!c.plan.view.planReady)fail('RUNTIME_ARTIFACTS_PLAN_DRIFT');
  const svc=service(),inner=await svc.preview({action:'upgrade'});if(inner.fingerprint!==p.innerFingerprint||!inner.canApply)fail('RUNTIME_ARTIFACTS_PLAN_DRIFT');
  const r={id:p.id,maintenanceId:inner.id,fingerprint:p.fingerprint,innerFingerprint:p.innerFingerprint,imageHash:p.imageHash,version:p.version,beforeHash:m.hash,beforeContentHash:m.contentHash,afterHash:null,state:'requested',updatedAt:now()};d.records.push(r);await save(ledgerFile,d);
  await api.artifactsHook?.('intent_saved',-1,null);await guard();
  await svc.apply({id:inner.id,fingerprint:inner.fingerprint,confirm:true});
  await api.artifactsHook?.('maintenance_returned',-1,null);return settle(d,r);
 }
 async function status(args){
  if(!exact(args,['id'])||!uuid(args.id))fail('ARGUMENTS');const d=await read(),r=d.records.find(x=>x.id===args.id);if(!r)fail('RUNTIME_ARTIFACTS_NOT_FOUND');
  if(terminal(r))return view(r);await guard();return settle(d,r);
 }
 async function recoveryPreview(args){
  if(!exact(args,['id'])||!uuid(args.id))fail('ARGUMENTS');await guard();const d=await read(),r=d.records.at(-1);
  if(!r||r.id!==args.id||terminal(r))fail('RUNTIME_ARTIFACTS_RECOVERY_REQUIRED');
  await innerJournal(r);const v=await service().recoveryPreview({id:r.maintenanceId}),image=await effective();if(hash(image)!==r.imageHash)fail('RUNTIME_ARTIFACTS_SOURCE_REVIEW');
  const p={schema:1,binding,id:randomUUID(),kind:'recover',targetId:r.id,imageHash:r.imageHash,version:r.version,beforeHash:hash(r),innerFingerprint:v.fingerprint,expiresAt:now()+300000};p.fingerprint=hash(p);await save(planFile,p);
  return publicPlan(p,{action:v.action,state:v.state,transactionId:r.id,confirmRequired:true});
 }
 async function recover(args){
  await guard();const p=await plan(args,'recover'),d=await read(),r=d.records.at(-1);
  if(!r||r.id!==p.targetId||hash(r)!==p.beforeHash||hash(await effective())!==p.imageHash)fail('RUNTIME_ARTIFACTS_PLAN_DRIFT');
  await innerJournal(r);const svc=service(),v=await svc.recoveryPreview({id:r.maintenanceId});if(v.fingerprint!==p.innerFingerprint)fail('RUNTIME_ARTIFACTS_PLAN_DRIFT');
  await svc.recover({id:r.maintenanceId,fingerprint:v.fingerprint,confirm:true});return settle(d,r);
 }
 return {preview,apply,status,recoveryPreview,recover,ready,noPending,metadata,ownership:async()=>{const d=await read();return {metadata:await owned(d),ledgerHash:hash(d)};}};
}
