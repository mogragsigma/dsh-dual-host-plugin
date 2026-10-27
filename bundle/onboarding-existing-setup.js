// Explicit reuse of an existing pair. The sole write is an owned confirmation
// record. No migration/adoption of native configuration or task authority.
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {createHash,randomUUID} from 'node:crypto';
import {assertNonsecretDraft} from './onboarding-schema.js';
import {repositoryURL} from './repository-gitee.js';
const KEY=credentialKey('dsh-task-gateway','onboarding-existing-setup-v1');
const OWNER='dsh-dual-host-onboarding';
const exact=(x,ks)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join()===ks.slice().sort().join();
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const text=x=>typeof x==='string'&&x.length>0&&x.length<=200&&!/[\x00-\x1f\x7f]/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const fail=c=>{throw Error('ONBOARDING_EXISTING_'+c);};
function choice(a){
 if(!exact(a,['query','clarification','im','repoUrl'])||!text(a.query)||typeof a.clarification!=='string'||a.clarification.length>200||/[\x00-\x1f\x7f]/.test(a.clarification)||typeof a.im!=='boolean'||!(a.repoUrl===null||typeof a.repoUrl==='string'))fail('ARGUMENTS');
 assertNonsecretDraft({model:a.query});assertNonsecretDraft({model:a.clarification});
 return {query:a.query.trim(),clarification:a.clarification.trim(),im:a.im,repoUrl:a.repoUrl===null?null:repositoryURL(a.repoUrl).url};
}
function readRecord(r){
 if(!r)return null;const p=r.payload;
 if(r.kind!=='grant'||!exact(p,['owner','schema','state','revision','operation','fingerprint','confirmedAt','choices','evidence'])||p.owner!==OWNER||p.schema!==1||!['confirmed','barrier'].includes(p.state)||!Number.isSafeInteger(p.revision)||p.revision<1||p.revision>=Number.MAX_SAFE_INTEGER-1||!uuid(p.operation)||!/^[a-f0-9]{64}$/.test(p.fingerprint)||!Number.isSafeInteger(p.confirmedAt)||p.confirmedAt<0)fail('RECORD_REVIEW');
 if(p.state==='confirmed'){choice(p.choices);validateEvidence(p.evidence);}
 else if(p.choices!==null||p.evidence!==null)fail('RECORD_REVIEW');
 if(hash({choices:p.choices,evidence:p.evidence})!==p.fingerprint||JSON.stringify(p.evidence).length>32768)fail('RECORD_REVIEW');
 return p;
}
function validateEvidence(e){
 const fp=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
 if(!exact(e,['local','cloud','model','notification','repository']))fail('RECORD_REVIEW');
 for(const role of ['local','cloud']){
  const h=e[role];if(!exact(h,['role','instance','version','paths','rules','modelCatalog'])||h.role!==role||!uuid(h.instance)||!text(h.version)||!fp(h.modelCatalog))fail('RECORD_REVIEW');
  if(!exact(h.paths,['dsh','agents','source','loadingVerified'])||h.paths.source!=='target_host_resolution'||h.paths.loadingVerified!==false||[h.paths.dsh,h.paths.agents].some(x=>typeof x!=='string'||!x||x.length>4096||/[\x00-\x1f\x7f]/.test(x)))fail('RECORD_REVIEW');
  if(!exact(h.rules,['state','files','activationVerified'])||!['committed','inspected'].includes(h.rules.state)||!Number.isSafeInteger(h.rules.files)||h.rules.files<1||h.rules.files>65||h.rules.activationVerified!==false)fail('RECORD_REVIEW');
 }
 if(!exact(e.model,['provider','model','reasoningEffort','catalogFingerprint'])||!text(e.model.provider)||!text(e.model.model)||e.model.reasoningEffort!=='high'||!fp(e.model.catalogFingerprint))fail('RECORD_REVIEW');
 if(e.notification!==null){const n=e.notification;if(!exact(n,['revision','operation','target'])||!Number.isSafeInteger(n.revision)||n.revision<1||!uuid(n.operation)||!exact(n.target,['host','label'])||!['local','cloud'].includes(n.target.host)||!text(n.target.label)||n.target.label.length>80)fail('RECORD_REVIEW');}
 if(e.repository!==null){if(!exact(e.repository,['provider','repository_id','url','branch','base_sha','private']))fail('RECORD_REVIEW');existingRepositorySnapshot(e.repository,e.repository.url);}
}
export function existingRepositorySnapshot(value,url){
 const v=value;
 if(!v||v.provider!=='gitee'||!Number.isSafeInteger(v.repository_id)||v.repository_id<1||repositoryURL(v.url).url.toLowerCase()!==repositoryURL(url).url.toLowerCase()||!text(v.branch)||!/^[a-f0-9]{40}$/.test(v.base_sha)||typeof v.private!=='boolean')fail('REPOSITORY_REVIEW');
 return {provider:'gitee',repository_id:v.repository_id,url:repositoryURL(v.url).url,branch:v.branch,base_sha:v.base_sha,private:v.private};
}
export function createExistingSetup({gateway,inspection,state,credentials,notifications,now=Date.now}){
 let pending=null,busy=false,closed=false;
 const available=()=>!closed&&inspection.available()&&state.available()&&!!credentials();
 const current=()=>{if(!available())fail('UNAVAILABLE');const g=gateway();if(g.closed||g.c.role!=='local')fail('LOCAL_ENTRY_REQUIRED');return g;};
 const unchanged=g=>{if(current()!==g)fail('HOST_CHANGED');};
 const read=async()=>readRecord(await credentials().readRecord(KEY));
 async function exclusive(fn){if(busy)fail('BUSY');busy=true;try{return await fn();}finally{busy=false;}}
 function view(p){return {contract:1,state:p?.state==='confirmed'?'confirmed_history':'not_confirmed',revision:p?.revision??0,operation:p?.operation??null,fingerprint:p?.fingerprint??null,confirmedAt:p?.state==='confirmed'?p.confirmedAt:null,choices:p?.choices??null,evidence:p?.evidence??null,scope:'preserve_existing_configuration',freshness:'historical_receipt_recheck_required',nativeConfigurationChanged:false,installationOwned:false,executionAuthorized:false,endToEndVerified:false};}
 async function model(a){
  if(!exact(a,['query','clarification']))fail('ARGUMENTS');choice({...a,im:false,repoUrl:null});
  const g=current(),r=await g.link.call('model_resolve',{host:'cloud',query:a.query,reasoningEffort:'high',...(a.clarification.trim()?{provider_hint:a.clarification.trim()}:{})});unchanged(g);
  if(r.observation?.authority!=='cloud'||r.observation?.freshness!=='live_response'||r.result?.host!=='cloud'||!uuid(r.observation.instance_id))fail('PEER_CHANGED');
  return {resolution:r.result,cloudInstance:r.observation.instance_id,observedAt:now(),expiresAt:now()+300000};
 }
 async function repository(a){
  if(!exact(a,['url']))fail('ARGUMENTS');const url=repositoryURL(a.url).url,g=current();
  const p=await g.link.call('onboarding_existing_repository',{url});unchanged(g);
  if(p.observation?.authority!=='cloud'||p.observation?.freshness!=='live_response'||!uuid(p.observation.instance_id))fail('PEER_CHANGED');
  return {repository:existingRepositorySnapshot(p.result,url),cloudInstance:p.observation.instance_id,observedAt:now(),access:'read_verified',writes:0};
 }
 async function notificationStatus(a){
  if(!exact(a,[]))fail('ARGUMENTS');const g=current(),local=await notifications.status({});
  const p=await g.link.call('notification_default_status',{});unchanged(g);const remote=p.result;
  if(p.observation?.authority!=='cloud'||p.observation?.freshness!=='live_response'||!uuid(p.observation.instance_id))fail('PEER_CHANGED');
  // Public local/cloud views may build target keys in a different order.
  // Compare the contract fields, not JSON insertion order; do not change stored fingerprints.
  const fields=v=>({enabled:v?.enabled,revision:v?.revision,operation:v?.operation,target:v?.target?{host:v.target.host,label:v.target.label}:null});
  const matches=hash(fields(local))===hash(fields(remote));
  return {enabled:local.enabled===true,synchronized:matches,target:local.target??null,revision:local.revision,operation:local.operation,cloudInstance:p.observation.instance_id,observedAt:now(),deliveryVerified:false,changed:false};
 }
 async function collect(a){
  const choices=choice(a),g=current(),pair=await inspection.inspectPair({});unchanged(g);
  if(pair.local.host.instance_id!==g.instanceId||pair.local.host.role!=='local'||pair.cloud.host.role!=='cloud')fail('PEER_CHANGED');
  for(const h of [pair.local,pair.cloud]){
   if(!['committed','inspected'].includes(h.rules.state)||h.rules.files<1)fail('RULES_REQUIRED');
   if(h.models.state!=='listed'||h.models.models<1)fail('MODEL_REQUIRED');
  }
  const m=await model({query:choices.query,clarification:choices.clarification}),r=m.resolution;
  if(m.cloudInstance!==pair.cloud.host.instance_id)fail('PEER_CHANGED');
  if(r.status!=='resolved'||!text(r.model_policy?.provider)||!text(r.model_policy?.model)||r.model_policy.reasoningEffort!=='high'||!/^[a-f0-9]{64}$/.test(r.catalog_fingerprint??''))fail('MODEL_REQUIRED');
  let im=null,repo=null;
  if(choices.im){
   im=await notificationStatus({});
   if(im.cloudInstance!==pair.cloud.host.instance_id)fail('PEER_CHANGED');
   if(!im.enabled||!im.synchronized||!['local','cloud'].includes(im.target?.host))fail('NOTIFICATION_REQUIRED');
   const host=im.target.host==='local'?pair.local:pair.cloud;if(host.im.state!=='listed'||host.im.botsConfigured<1)fail('NOTIFICATION_REQUIRED');
  }
  if(choices.repoUrl){repo=await repository({url:choices.repoUrl});if(repo.cloudInstance!==pair.cloud.host.instance_id)fail('PEER_CHANGED');}
  unchanged(g);
  const host=h=>({role:h.host.role,instance:h.host.instance_id,version:h.host.plugin_version,paths:h.paths,rules:h.rules,modelCatalog:h.models.catalogFingerprint});
  const evidence={local:host(pair.local),cloud:host(pair.cloud),model:{provider:r.model_policy.provider,model:r.model_policy.model,reasoningEffort:'high',catalogFingerprint:r.catalog_fingerprint},notification:im?{revision:im.revision,operation:im.operation,target:im.target}:null,repository:repo?.repository??null};
  validateEvidence(evidence);return {choices,evidence};
 }
 async function status(a){if(!exact(a,[]))fail('ARGUMENTS');current();return view(await read());}
 async function preview(a){return exclusive(async()=>{
  pending=null;current();const old=await read(),body=await collect(a);if((await read())?.revision!==old?.revision)fail('REVISION_CONFLICT');
  const createdAt=now();pending={...body,id:randomUUID(),fingerprint:hash(body),expectedRevision:old?.revision??0,createdAt,expiresAt:createdAt+300000};
  return {...pending,scope:'preserve_existing_configuration',writes:['own_configuration_confirmation_record'],nativeConfigurationChanged:false,installationOwned:false,executionAuthorized:false,endToEndVerified:false};
 });}
 async function apply(a){return exclusive(async()=>{
  if(!exact(a,['id','fingerprint','confirm'])||a.confirm!==true)fail('CONFIRMATION_REQUIRED');
  const p=pending;if(!p||p.id!==a.id||p.fingerprint!==a.fingerprint||now()<p.createdAt||now()>=p.expiresAt)fail('PLAN_EXPIRED');
  pending=null; // Any uncertain write is reconciled by status, never replayed.
  const g=current();let body;try{body=await collect(p.choices);}catch{fail('RECHECK_FAILED');}if(hash(body)!==p.fingerprint)fail('CONFIGURATION_CHANGED');
  if(now()<p.createdAt||now()>=p.expiresAt)fail('PLAN_EXPIRED');current();
  try{await credentials().modifyRecord(KEY,old=>{
   const prior=readRecord(old);if((prior?.revision??0)!==p.expectedRevision)fail('REVISION_CONFLICT');
   unchanged(g);
   return {kind:'grant',payload:{owner:OWNER,schema:1,state:'confirmed',revision:p.expectedRevision+1,operation:p.id,fingerprint:p.fingerprint,confirmedAt:now(),...body}};
  });}catch{fail('WRITE_UNKNOWN');}
  return status({});
 });}
 async function fence(a){return exclusive(async()=>{
  if(!exact(a,['expectedRevision','operation','confirm'])||!Number.isSafeInteger(a.expectedRevision)||a.expectedRevision<0||a.expectedRevision>=Number.MAX_SAFE_INTEGER-1||!uuid(a.operation)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');
  const g=current();pending=null;
  await credentials().modifyRecord(KEY,old=>{unchanged(g);const p=readRecord(old);if(p?.operation===a.operation&&p.state==='barrier')return undefined;if((p?.revision??0)!==a.expectedRevision)fail('REVISION_CONFLICT');const body={choices:null,evidence:null};return {kind:'grant',payload:{owner:OWNER,schema:1,state:'barrier',revision:a.expectedRevision+1,operation:a.operation,fingerprint:hash(body),confirmedAt:now(),...body}};});
  return status({});
 });}
 return {available,model,repository,notifications:notificationStatus,status,preview,apply,fence,dispose(){closed=true;pending=null;}};
}
