// Own namespace only. The public official credential provider owns disk IO/locking.
// No model tools, environment injection, automatic cloud transfer or model invocation.
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {defaults,validateDraft,assertNonsecretDraft} from './onboarding-schema.js';
import {onboardingBoundary} from './onboarding-boundary.js';
const OWNER='dsh-dual-host-onboarding',SCOPE='dsh-task-gateway';
const SLOTS=['deepseek-local','deepseek-cloud','token-plan','token-plan-cloud','gitee','gitee-cloud'];
const recordKey=id=>credentialKey(SCOPE,'onboarding-'+id+'-v1');
const fail=code=>{throw Error('ONBOARDING_'+code);};
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&Object.keys(x).every(k=>keys.includes(k));
const revision=x=>Number.isSafeInteger(x)&&x>=0;
const operation=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const initial=()=>({draft:defaults(),page:0,handled:[],skipped:[]});
function content(value){
 if(!exact(value,['draft','page','handled','skipped']))fail('INVALID_DRAFT');
 assertNonsecretDraft(value.draft);validateDraft(value.draft);
 if(!Number.isInteger(value.page)||value.page<0||value.page>5)fail('INVALID_DRAFT');
 for(const list of [value.handled,value.skipped])if(!Array.isArray(list)||list.length>5||new Set(list).size!==list.length||list.some(i=>!Number.isInteger(i)||i<0||i>4))fail('INVALID_DRAFT');
 if(value.skipped.some(i=>![2,3].includes(i)||!value.handled.includes(i)))fail('INVALID_DRAFT');
 return {draft:{...defaults(),...value.draft},page:value.page,handled:[...value.handled].sort(),skipped:[...value.skipped].sort()};
}
function payload(record,type){
 if(!record)return null;
 const p=record.payload,keys=['owner','schema','type','revision','operation','updatedAt',type==='draft'?'content':'value'];
 if(record.kind!=='grant'||!exact(p,keys)||p.owner!==OWNER||p.schema!==1||p.type!==type||!revision(p.revision)||!p.revision||!operation(p.operation)||!Number.isSafeInteger(p.updatedAt))fail('STATE_REVIEW');
 if(type==='draft')content(p.content);else if(p.value!==null&&!secretValid(p.value))fail('STATE_REVIEW');
 return p;
}
const secretValid=s=>typeof s==='string'&&s.length>=8&&s.length<=4096&&/^[\x21-\x7e]+$/.test(s)&&!s.includes('PRIVATE KEY');
function draftView(p){return {contract:1,revision:p?.revision??0,updatedAt:p?.updatedAt??null,...(p?.content??initial()),notAuthorization:true};}
function secretView(slot,p,writable=true){return {slot,reference:'dsh-managed:'+slot,revision:p?.revision??0,configured:!!p?.value,writable,updatedAt:p?.updatedAt??null,verified:false,transferState:'see_handoff_ledger'};}
export function createOnboardingState(ctx,config={},runtime={}){
 const now=runtime.now??Date.now;
 function provider(){return runtime.credentials??ctx.credentials;}
 function available(){
  try{onboardingBoundary(config,runtime,'persistence');const c=provider();return !!c&&['readRecord','describeRecord','modifyRecord'].every(k=>typeof c[k]==='function');}catch{return false;}
 }
 function ready(){if(!available())fail('PERSISTENCE_DISABLED');return provider();}
 async function load(){return draftView(payload(await ready().readRecord(recordKey('draft')),'draft'));}
 async function save(args){
  if(!exact(args,['expectedRevision','operation','content'])||!revision(args.expectedRevision)||!operation(args.operation))fail('INVALID_ARGUMENTS');
  const next=content(args.content),c=ready();let result;
  await c.modifyRecord(recordKey('draft'),old=>{
   const p=payload(old,'draft');
   if(p?.operation===args.operation){if(p.revision!==args.expectedRevision+1||JSON.stringify(p.content)!==JSON.stringify(next))fail('OPERATION_CONFLICT');result=draftView(p);return undefined;}
   if((p?.revision??0)!==args.expectedRevision)fail('DRAFT_CONFLICT');
   const value={owner:OWNER,schema:1,type:'draft',revision:args.expectedRevision+1,operation:args.operation,updatedAt:now(),content:next};
   result=draftView(value);return {kind:'grant',payload:value};
  });
  if(!result)fail('STATE_REVIEW');return result;
 }
 async function secrets(){
  const c=ready(),rows=[];
  for(const slot of SLOTS){const key=recordKey(slot),info=await c.describeRecord(key),p=payload(await c.readRecord(key),'secret');rows.push(secretView(slot,p,info.writable===true));}
  return {contract:1,storage:'official_host_credentials',encryptedByPlugin:false,osIdentityIsolation:false,slots:rows};
 }
 async function changeSecret(args,remove=false){
  if(!exact(args,remove?['slot','expectedRevision','operation','confirm']:['slot','expectedRevision','operation','confirm','secret'])||!SLOTS.includes(args.slot)||!revision(args.expectedRevision)||!operation(args.operation)||args.confirm!==true||!remove&&!secretValid(args.secret))fail('INVALID_SECRET_REQUEST');
  const c=ready(),key=recordKey(args.slot),next=remove?null:args.secret;let result;
  await c.modifyRecord(key,old=>{
   const p=payload(old,'secret');
   if(p?.operation===args.operation){if(p.revision!==args.expectedRevision+1||p.value!==next)fail('OPERATION_CONFLICT');result=secretView(args.slot,p);return undefined;}
   if((p?.revision??0)!==args.expectedRevision)fail('SECRET_CONFLICT');
   const value={owner:OWNER,schema:1,type:'secret',revision:args.expectedRevision+1,operation:args.operation,updatedAt:now(),value:next};
   result=secretView(args.slot,value);return {kind:'grant',payload:value};
  });
  if(!result)fail('STATE_REVIEW');return result;
 }
 // Internal adapter seam only. Never expose this method through onboarding RPC,
 // model tools, draft serialization, logs, AGENTS.md or Skill content.
 async function readManagedSecret(slot){
  if(!SLOTS.includes(slot))fail('INVALID_SECRET_SLOT');
  const p=payload(await ready().readRecord(recordKey(slot)),'secret');
  return {revision:p?.revision??0,value:p?.value??null};
 }
 // A revision barrier preserves the current value, including null. It prevents a
 // delayed CAS write with an older revision; it is not removal or Key delivery.
 async function fenceSecret(args){
  if(!exact(args,['slot','operation','expectedRevision','confirm'])||!['deepseek-local','token-plan','gitee'].includes(args.slot)||!operation(args.operation)||!revision(args.expectedRevision)||args.expectedRevision>=Number.MAX_SAFE_INTEGER-1||args.confirm!==true)fail('INVALID_SECRET_REQUEST');
  let result;await ready().modifyRecord(recordKey(args.slot),old=>{
   const p=payload(old,'secret');
   if(p?.operation===args.operation){if(p.revision!==args.expectedRevision+1)fail('OPERATION_CONFLICT');result=secretView(args.slot,p);return undefined;}
   if((p?.revision??0)!==args.expectedRevision)fail('SECRET_CONFLICT');
   const value={owner:OWNER,schema:1,type:'secret',revision:args.expectedRevision+1,operation:args.operation,updatedAt:now(),value:p?.value??null};
   result=secretView(args.slot,value);return {kind:'grant',payload:value};
  });if(!result)fail('STATE_REVIEW');return result;
 }
 async function secretReceipt(args){
  if(!exact(args,['slot','operation','expectedRevision'])||!SLOTS.includes(args.slot)||!operation(args.operation)||!revision(args.expectedRevision))fail('INVALID_SECRET_REQUEST');
  const p=payload(await ready().readRecord(recordKey(args.slot)),'secret');
  return {...secretView(args.slot,p),operationMatched:p?.operation===args.operation&&p.revision===args.expectedRevision+1};
 }
 return {available,load,save,secrets,readManagedSecret,secretReceipt,fence:fenceSecret,put:args=>changeSecret(args),remove:args=>changeSecret(args,true)};
}
