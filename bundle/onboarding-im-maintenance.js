// Explicit, lossy single-bot maintenance. Never a whole-Host drain/stop grant.
import {randomUUID,createHash} from 'node:crypto';
import {createMaintenanceProcessIdentity,validMaintenanceProcess} from './maintenance-process-identity.js';
import {credentialKey} from '@deepseek-ai/dsh-credentials';
const KEY=credentialKey('dsh-task-gateway','onboarding-im-maintenance-v1'),OWNER='dsh-im-maintenance',LIMIT=128;
const fail=c=>{throw Error('ONBOARDING_IM_MAINTENANCE_'+c);};
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===k.slice().sort().join();
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const botId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const phases=['intent','acknowledged','needs_review','reviewed'];
const states=['connected','disconnected','connecting','provisioning','error'];
const pending=p=>p.entries.at(-1)&&['intent','needs_review'].includes(p.entries.at(-1).phase);
function decode(r){
 if(r==null)return {owner:OWNER,schema:2,revision:0,entries:[]};const p=r.payload;
 if(r.kind!=='grant'||!exact(p,['owner','schema','revision','entries'])||p.owner!==OWNER||![1,2].includes(p.schema)||!integer(p.revision)||!Array.isArray(p.entries)||p.entries.length>LIMIT)fail('LEDGER_REVIEW');
 const ids=new Set();for(const [i,e] of p.entries.entries()){
  if(!exact(e,['id','instanceId','planHash','botId','channel','action','configHash','createdAt','updatedAt','phase','observedState','ownerProcess',...(p.schema===2?['review']:[])])||!uuid(e.id)||!uuid(e.instanceId)||!digest(e.planHash)||!botId(e.botId)||e.channel!=='feishu'||!['disconnect','reconnect'].includes(e.action)||!digest(e.configHash)||!integer(e.createdAt)||!integer(e.updatedAt)||e.updatedAt<e.createdAt||(e.ownerProcess!==null&&!validMaintenanceProcess(e.ownerProcess))||!phases.includes(e.phase)||(e.observedState!==null&&!states.includes(e.observedState))||ids.has(e.id)||(i<p.entries.length-1&&['intent','needs_review'].includes(e.phase)))fail('LEDGER_REVIEW');if(p.schema===2&&e.review!==null&&(!exact(e.review,['id','instanceId','at'])||e.phase!=='reviewed'||!uuid(e.review.id)||!uuid(e.review.instanceId)||!integer(e.review.at)))fail('LEDGER_REVIEW');ids.add(e.id);
 }return {...structuredClone(p),entries:p.entries.map(e=>({...structuredClone(e),review:e.review??null}))};
}
export function createOnboardingImMaintenance({credentials,im,enabled=()=>true,now=Date.now,processIdentity=createMaintenanceProcessIdentity()}){
 const instanceId=randomUUID();let busy=false,closed=false,plan=null,tracked=null;
 function capture(needIm=true){const c=credentials(),s=im();if(closed||!enabled()||!c||typeof c.readRecord!=='function'||typeof c.modifyRecord!=='function'||needIm&&s?.contractVersion!==1)fail('UNAVAILABLE');return {c,s};}
 function check(a){if(closed||credentials()!==a.c||im()!==a.s)fail('PROVIDER_CHANGED');}
 async function read(a){const p=decode(await a.c.readRecord(KEY));check(a);if(tracked&&!p.entries.some(e=>e.id===tracked.id&&e.planHash===tracked.planHash))fail('LEDGER_CHANGED');return p;}
 async function write(a,p,fn){check(a);let next;await a.c.modifyRecord(KEY,raw=>{const old=decode(raw);if(old.revision!==p.revision)fail('REVISION_CHANGED');if(old.revision>=Number.MAX_SAFE_INTEGER-1)fail('LEDGER_REVIEW');next={...old,schema:2,revision:old.revision+1,entries:fn(old.entries)};decode({kind:'grant',payload:next});return {kind:'grant',payload:next};});check(a);if(!next)fail('LEDGER_REVIEW');return next;}
 async function observe(a,t){if(typeof t?.call!=='function')fail('TRANSPORT_REQUIRED');const rows=await t.call('status');check(a);return rows;}
 const result=(p,rows=[],inventoryState='observed')=>({contract:1,queryContract:1,inventoryState,scope:'single_bot_current_host',instanceId,revision:p.revision,receipt:p.entries.at(-1)??null,historyCount:p.entries.length,pending:!!pending(p),operationInFlight:busy,bots:rows,observedAt:now(),lossless:false,configurationRetainedByContract:true,configurationSecretsVerified:false,restartMayReconnect:true,hostStopAuthorized:false,pluginSwitchAuthorized:false,automaticDisconnect:false});
 async function serial(fn){if(closed)fail('CLOSED');if(busy)fail('BUSY');busy=true;try{const v=await fn();if(v&&Object.hasOwn(v,'operationInFlight'))v.operationInFlight=false;return v;}finally{busy=false;}}
 const row=(rows,id)=>{const r=rows.find(v=>v.botId===id);if(!r||r.channel!=='feishu'||!r.configured||!digest(r.configHash))fail('BOT_REVIEW');return r;};
 function save(body,a){plan={body:{...body,fingerprint:hash(body)},...a};return structuredClone(plan.body);}
 function checked(args,kind){if(!exact(args,['id','fingerprint','confirm','acknowledgeLoss'])||args.confirm!==true||args.acknowledgeLoss!==true)fail('CONFIRMATION_REQUIRED');if(!plan||plan.body.kind!==kind||plan.body.id!==args.id||plan.body.fingerprint!==args.fingerprint||plan.body.expiresAt<=now())fail('PLAN_EXPIRED');check(plan);return plan;}
 async function status(args={},t){
  if(!exact(args,[])&&(!exact(args,['operationId'])||!uuid(args.operationId)))fail('ARGUMENTS');
  const a=capture(false),p=await read(a);let rows=[],inventoryState='unavailable';
  if(a.s?.contractVersion===1)try{rows=await observe(a,t);inventoryState='observed';}catch{check(a);}
  const value=result(p,rows,inventoryState);
  return args.operationId?{...value,requestedOperationId:args.operationId,requestedReceipt:p.entries.find(e=>e.id===args.operationId)??null}:value;
 }
 async function preview(args,t){return serial(async()=>{
  if(!exact(args,['action','botId'])||!['disconnect','reconnect'].includes(args.action)||!botId(args.botId))fail('ARGUMENTS');const a=capture(),p=await read(a);if(pending(p))fail('RECOVERY_REQUIRED');if(p.entries.length>=LIMIT)fail('HISTORY_FULL');
  const r=row(await observe(a,t),args.botId);if(args.action==='disconnect'?!r.connected:r.connected||r.state!=='disconnected')fail('STATE_REVIEW');
  if(args.action==='reconnect'){const prior=p.entries.findLast(e=>e.botId===args.botId);if(!prior||prior.action!=='disconnect'||prior.configHash!==r.configHash||!['acknowledged','reviewed'].includes(prior.phase))fail('OWN_DISCONNECT_REQUIRED');}
  return save({kind:'action',id:randomUUID(),instanceId,action:args.action,botId:args.botId,channel:'feishu',botName:r.name,configHash:r.configHash,observationHash:hash(r),revision:p.revision,expiresAt:now()+300000,scope:'single_bot_current_host',mayAbortInFlight:true,restartMayReconnect:true,hostStopAuthorized:false,pluginSwitchAuthorized:false},a);
 });}
 async function apply(args,t){return serial(async()=>{
  const q=checked(args,'action'),a=capture();let p=await read(a);if(pending(p)||p.revision!==q.body.revision)fail('REVISION_CHANGED');
  const before=row(await observe(a,t),q.body.botId);if(hash(before)!==q.body.observationHash)fail('OBSERVATION_CHANGED');
  const e={id:q.body.id,instanceId,planHash:q.body.fingerprint,botId:q.body.botId,channel:'feishu',action:q.body.action,configHash:before.configHash,createdAt:now(),updatedAt:now(),phase:'intent',observedState:null,review:null,ownerProcess:await processIdentity.capture()};check(a);plan=null;
  p=await write(a,p,entries=>[...entries,e]);tracked={id:e.id,planHash:e.planHash};
  let phase='needs_review',observedState=null,rows=[];
  try{check(a);const current=row(await observe(a,t),e.botId);if(hash(current)!==q.body.observationHash)fail('OBSERVATION_CHANGED');rows=await t.call(e.action,e.botId);check(a);const after=row(rows,e.botId);observedState=after.state;if(after.configHash===e.configHash&&(e.action==='disconnect'?!after.connected&&after.state==='disconnected':after.connected))phase='acknowledged';}catch{/* Unknown effect. Never resend, reconnect, or erase the intent. */}
  p=await write(a,p,entries=>entries.map(x=>x.id===e.id?{...x,phase,observedState,updatedAt:now()}:x));return result(p,rows,phase==='acknowledged'?'observed':'unavailable');
 });}
 async function reconcilePreview(args={},t){return serial(async()=>{
  if(!exact(args,[]))fail('ARGUMENTS');const a=capture(),p=await read(a);if(!pending(p))fail('NOT_PENDING');const e=p.entries.at(-1),r=row(await observe(a,t),e.botId);if(r.configHash!==e.configHash)fail('CONFIG_CHANGED');
  const proof=e.phase==='intent'&&e.instanceId!==instanceId?await processIdentity.observe(e.ownerProcess):null;check(a);
  if(proof&&proof.state!=='exited')fail('ORIGINAL_IN_FLIGHT_UNVERIFIED');
  return save({kind:'review',id:randomUUID(),operationId:e.id,instanceId,revision:p.revision,observationHash:hash(r),observedState:r.state,expiresAt:now()+300000,scope:'ledger_only',priorEffectVerified:false,hostStopAuthorized:false,pluginSwitchAuthorized:false},a);
 });}
 async function reconcileApply(args,t){return serial(async()=>{
  const q=checked(args,'review'),a=capture();let p=await read(a);if(!pending(p)||p.revision!==q.body.revision||p.entries.at(-1).id!==q.body.operationId)fail('REVISION_CHANGED');const e=p.entries.at(-1),rows=await observe(a,t),r=row(rows,e.botId);
  if(e.phase==='intent'&&e.instanceId!==instanceId){const proof=await processIdentity.observe(e.ownerProcess);check(a);if(proof.state!=='exited')fail('ORIGINAL_IN_FLIGHT_UNVERIFIED');}
  if(hash(r)!==q.body.observationHash||r.configHash!==e.configHash)fail('OBSERVATION_CHANGED');plan=null;
  p=await write(a,p,entries=>entries.map(x=>x.id===e.id?{...x,phase:'reviewed',observedState:r.state,updatedAt:now(),review:{id:q.body.id,instanceId,at:now()}}:x));return {...result(p,rows),priorEffectVerified:false,componentActions:0};
 });}
 return {status,preview,apply,reconcilePreview,reconcileApply,dispose(){closed=true;plan=null;}};
}
