// One durable, target-bound queue decision. Independent from file-scope grants.
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {randomUUID} from 'node:crypto';
import {digest} from './onboarding-ssh.js';
import {handoffTarget} from './onboarding-handoff.js';
import {cloudFileStatus,bindCloudFiles} from './onboarding-file-contract.js';
import {reviewUuid as uuid,reviewHash as hex,reviewInput,cloudQueueList,cloudQueuePlan,cloudQueueReceipt,cloudQueueOutcome} from './onboarding-file-review-contract.js';
const KEY=credentialKey('dsh-task-gateway','onboarding-cloud-file-review-v1'),OWNER='dsh-dual-host-onboarding/file-review';
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===k.slice().sort().join();
const fail=c=>{throw Error('ONBOARDING_FILES_'+c);},terminal=p=>!p||['applied','closed'].includes(p.phase);
function parse(r){
 if(!r)return null;const p=r.payload;
 if(r.kind!=='grant'||!exact(p,['owner','schema','id','revision','fingerprint','target','remotePlan','phase','receipt','closure','updatedAt'])||p.owner!==OWNER||p.schema!==1||!uuid(p.id)||!Number.isSafeInteger(p.revision)||p.revision<1||p.revision>=Number.MAX_SAFE_INTEGER-1||!hex(p.fingerprint)||!['sending','needs_review','closing','applied','closed'].includes(p.phase)||!Number.isSafeInteger(p.updatedAt))fail('LEDGER_REVIEW');
 handoffTarget(p.target);cloudQueuePlan(p.remotePlan);if(p.receipt!==null)cloudQueueReceipt(p.receipt,p.remotePlan);if((p.phase==='applied')!==(p.receipt!==null))fail('LEDGER_REVIEW');
 if(p.closure!==null&&(!exact(p.closure,['id','fingerprint'])||!uuid(p.closure.id)||!hex(p.closure.fingerprint)))fail('LEDGER_REVIEW');if(p.phase==='closing'&&!p.closure)fail('LEDGER_REVIEW');return p;
}
export function createOnboardingCloudFileReview({state,credentials,remote,enabled,now=Date.now}){
 let pending=null,closePlan=null,busy=false;
 const available=()=>enabled()&&state.available()&&!!credentials();
 const ready=()=>{if(!available())fail('UNAVAILABLE');};
 const read=async()=>parse(await credentials().readRecord(KEY));
 async function run(fn){ready();if(busy)fail('BUSY');busy=true;try{return await fn();}finally{busy=false;}}
 function view(p,freshness='cached'){return {contract:1,scope:'managed_cloud_queue_only',operation:p?{id:p.id,state:p.phase,revision:p.revision,remoteOperation:p.remotePlan.id,remotePlanHash:p.remotePlan.fingerprint,runtimeId:p.remotePlan.runtimeId,item:p.remotePlan.review.item,name:p.remotePlan.review.name,decision:p.remotePlan.review.decision,target:p.target,observedAt:p.updatedAt}:{state:'not_started'},receipt:p?.receipt??null,freshness,automaticRetry:false,executionAuthorized:false,repositoryWriteAuthorized:false};}
 async function request(method,args,target){const r=await remote('file_transfer_'+method,args);if(!exact(r,['target','value']))fail('RESPONSE_REVIEW');handoffTarget(r.target);if(target&&digest(target)!==digest(r.target))fail('IDENTITY_REVIEW');return r;}
 async function current(target){const r=await request('status',target?{targetHash:digest(target)}:{},target),v=bindCloudFiles(cloudFileStatus(r.value),r.target);if(!v.available)fail('RUNTIME_REQUIRED');return {target:r.target,files:v};}
 async function saveResult(p,phase,receipt=null){let out;await credentials().modifyRecord(KEY,r=>{const c=parse(r);if(c?.id!==p.id||c.revision!==p.revision)fail('LEDGER_CONFLICT');out={...c,revision:c.revision+1,phase,receipt,updatedAt:now()};return {kind:'grant',payload:out};});return out;}
 async function observe(p){const r=await request('queueReviewStatus',{operation:p.remotePlan.id,fingerprint:p.remotePlan.fingerprint,targetHash:digest(p.target)},p.target);return cloudQueueOutcome(r.value,p.remotePlan);}
 async function reconcile(p){try{const v=await observe(p);if(v.receipt)return view(await saveResult(p,'applied',v.receipt),'remote_checked');if(v.closed)return view(await saveResult(p,'closed'),'remote_checked');return view(await saveResult(p,'needs_review'),'remote_checked');}catch{return view(p,'check_failed');}}
 async function queueList(a){return run(async()=>{if(!exact(a,[]))fail('ARGUMENTS');const s=await current(),r=await request('queueList',{targetHash:digest(s.target)},s.target);return {contract:1,queue:cloudQueueList(r.value,s.files),remoteTarget:s.target,freshness:'remote_checked',checkedAt:now()};});}
 async function queueReviewPreview(a){return run(async()=>{
  pending=null;reviewInput(a);const old=await read();if(!terminal(old))fail('RECOVERY_REQUIRED');const s=await current();if(s.files.enabled||s.files.active)fail('QUEUE_DISABLE_REQUIRED');
  const r=await request('queueReviewPreview',{...a,targetHash:digest(s.target)},s.target),p=cloudQueuePlan(r.value,s.files);if(digest(a)!==digest({item:p.review.item,decision:p.review.decision})||p.expiresAt<=now())fail('RESPONSE_REVIEW');
  const body={id:randomUUID(),target:r.target,remotePlan:p,priorId:old?.id??null,priorRevision:old?.revision??0,expiresAt:Math.min(p.expiresAt,now()+300000)};pending={...body,fingerprint:digest(body)};
  return {contract:1,kind:'cloud_queue_review',id:pending.id,fingerprint:pending.fingerprint,expiresAt:pending.expiresAt,review:p.review,remoteTarget:r.target,runtimeId:p.runtimeId,writes:0};
 });}
 async function queueReviewApply(a){return run(async()=>{
  if(!exact(a,['id','fingerprint','confirm'])||!uuid(a.id)||!hex(a.fingerprint)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');const old=await read();if(old?.id===a.id&&old.fingerprint===a.fingerprint)return {...view(old),notResent:true};
  const p=pending;if(!p||p.id!==a.id||p.fingerprint!==a.fingerprint||p.expiresAt<=now())fail('PLAN_EXPIRED');pending=null;
  const next={owner:OWNER,schema:1,id:p.id,revision:1,fingerprint:p.fingerprint,target:p.target,remotePlan:p.remotePlan,phase:'sending',receipt:null,closure:null,updatedAt:now()};
  await credentials().modifyRecord(KEY,r=>{const c=parse(r);if((c?.id??null)!==p.priorId||(c?.revision??0)!==p.priorRevision||!terminal(c))fail('LEDGER_CONFLICT');return {kind:'grant',payload:next};});
  try{const r=await request('queueReviewApply',{id:p.remotePlan.id,fingerprint:p.remotePlan.fingerprint,confirm:true,targetHash:digest(p.target)},p.target);return view(await saveResult(next,'applied',cloudQueueReceipt(r.value,p.remotePlan)),'remote_checked');}
  catch{return view(await saveResult(next,'needs_review'),'check_failed');}
 });}
 async function queueReviewStatus(a){return run(async()=>{if(!exact(a,['refresh'])||typeof a.refresh!=='boolean')fail('ARGUMENTS');const p=await read();return p&&a.refresh?reconcile(p):view(p);});}
 async function queueReviewClosePreview(a){return run(async()=>{
  closePlan=null;if(!exact(a,[]))fail('ARGUMENTS');const p=await read();if(!p||terminal(p))fail('RECOVERY_NOT_READY');const v=await observe(p);if(v.receipt){await saveResult(p,'applied',v.receipt);fail('ALREADY_APPLIED');}if(v.closed){await saveResult(p,'closed');fail('QUEUE_CLOSED');}
  const body={id:randomUUID(),operationId:p.id,revision:p.revision,target:p.target,remoteOperation:p.remotePlan.id,remotePlanHash:p.remotePlan.fingerprint,expiresAt:now()+300000};closePlan={...body,fingerprint:digest(body)};
  return {...closePlan,contract:1,kind:'queue_review_close',name:p.remotePlan.review.name,decision:p.remotePlan.review.decision,preservesFiles:true,preservesAuthorization:true};
 });}
 async function queueReviewClose(a){return run(async()=>{
  if(!exact(a,['id','fingerprint','confirm'])||!uuid(a.id)||!hex(a.fingerprint)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');const p=await read();if(p?.closure?.id===a.id&&p.closure.fingerprint===a.fingerprint)return {...view(p),notResent:true};
  const c=closePlan;if(!c||c.id!==a.id||c.fingerprint!==a.fingerprint||c.expiresAt<=now())fail('PLAN_EXPIRED');closePlan=null;if(!p||p.id!==c.operationId||p.revision!==c.revision||terminal(p))fail('LEDGER_CONFLICT');
  const next={...p,revision:p.revision+1,phase:'closing',closure:{id:c.id,fingerprint:c.fingerprint},updatedAt:now()};await credentials().modifyRecord(KEY,r=>{const old=parse(r);if(old?.id!==p.id||old.revision!==p.revision)fail('LEDGER_CONFLICT');return {kind:'grant',payload:next};});
  try{const r=await request('queueReviewClose',{operation:p.remotePlan.id,fingerprint:p.remotePlan.fingerprint,confirm:true,targetHash:digest(p.target)},p.target),v=cloudQueueOutcome(r.value,p.remotePlan);if(!v.closed&&!v.receipt)fail('RESPONSE_REVIEW');return view(await saveResult(next,v.receipt?'applied':'closed',v.receipt),'remote_checked');}
  catch{return view(await saveResult(next,'needs_review'),'check_failed');}
 });}
 return {available,queueList,queueReviewPreview,queueReviewApply,queueReviewStatus,queueReviewClosePreview,queueReviewClose};
}
