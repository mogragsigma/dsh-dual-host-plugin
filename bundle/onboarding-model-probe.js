// One explicit, bounded provider attempt through the official LLM service.
// No agent/session runner, tools, retry plugin, default route or external secrets.
import {randomUUID,createHash} from 'node:crypto';
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {BlockAssembler,createUserMessage} from '@deepseek-ai/dsh-llm';
export const MODEL_PROBE_LIMITS=Object.freeze({maxTokens:1024,timeoutMs:60000,maxResponseBytes:65536,requests:1});
export const MODEL_PROBE_SYSTEM='This is a model connection check. Do not use tools. Reply with DSH_CONNECTION_OK only.';
export const MODEL_PROBE_INPUT='Check this model connection.';
const owner='dsh-onboarding-model-probe',exact=(v,ks)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===ks.slice().sort().join();
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const rev=v=>Number.isSafeInteger(v)&&v>=0;
const text=v=>typeof v==='string'&&v.length>0&&v.length<=200&&!/[\x00-\x1f\x7f]/u.test(v);
const fail=c=>{throw Error('ONBOARDING_MODEL_PROBE_'+c);};
const safeCodes=new Set(['AUTH','INVALID_CREDENTIAL','MISSING_CREDENTIAL','RATE_LIMIT','QUOTA','ACCOUNT_QUOTA','NO_ADAPTER','CONTEXT_WINDOW_EXCEEDED']);
const ownCodes=new Set(['ROUTE_CHANGED','BINDING_CHANGED','OUTPUT_LIMIT','INCOMPLETE','TOOL_DENIED','DEADLINE','EMPTY_RESPONSE']);
function receipt(record){
 if(!record)return null;
 const p=record.payload,fields=['owner','schema','revision','id','planHash','state','selection','bindingRevision','credentialRevision','startedAt','deadlineAt','completedAt','error','request'];
 if(record.kind!=='grant'||!exact(p,fields)||p.owner!==owner||p.schema!==1||!rev(p.revision)||p.revision<1||!uuid(p.id)||!hex(p.planHash)||!['started','succeeded','failed','unknown'].includes(p.state)||!rev(p.bindingRevision)||!rev(p.credentialRevision)||!rev(p.startedAt)||p.deadlineAt!==p.startedAt+MODEL_PROBE_LIMITS.timeoutMs||p.completedAt!==null&&!rev(p.completedAt)||p.error!==null&&!safeCodes.has(p.error)&&!ownCodes.has(p.error)&&p.error!=='PROVIDER_ERROR'||!exact(p.selection,['provider','provider_name','model','model_name'])||!Object.values(p.selection).every(text))fail('RECORD_REVIEW');
 if(p.state==='started'&&(p.completedAt!==null||p.error!==null)||p.state!=='started'&&p.completedAt===null||p.state==='succeeded'&&p.error!==null||['failed','unknown'].includes(p.state)&&p.error===null)fail('RECORD_REVIEW');
 const q=p.request;
 if(!exact(q,['system','messages','reasoningEffort','maxTokens','tools','purpose','sessionId'])||q.system!==MODEL_PROBE_SYSTEM||q.reasoningEffort!=='high'||q.maxTokens!==MODEL_PROBE_LIMITS.maxTokens||q.purpose!=='onboarding-connection-check'||q.sessionId!=='onboarding-probe-'+p.id||!Array.isArray(q.tools)||q.tools.length||!Array.isArray(q.messages)||q.messages.length!==1||q.messages[0].role!=='user'||JSON.stringify(q.messages[0].content)!==JSON.stringify([{type:'text',text:MODEL_PROBE_INPUT}]))fail('RECORD_REVIEW');
 return p;
}
export function createOnboardingModelProbe({credentials,llm,snapshot,resolve,provider,recordName,now=Date.now,admit=()=>()=>{}}){
 const key=credentialKey('dsh-task-gateway',recordName+'-probe-v1');
 let plan=null,active=null,busy=false;
 const available=()=>typeof llm()?.prepareCall==='function';
 const read=async()=>{const p=receipt(await credentials().readRecord(key));if(p&&p.selection.provider!==provider)fail('RECORD_REVIEW');return p;};
 const bindingMatches=(s,p)=>s.state==='configured_unverified'&&s.registered===true&&s.provider===provider&&s.bindingRevision===p.bindingRevision&&s.credentialRevision===p.credentialRevision;
 async function run(fn){if(!available())fail('UNAVAILABLE');if(busy)fail('BUSY');busy=true;try{return await fn();}finally{busy=false;}}
 function publicReceipt(p,s){return p?{id:p.id,state:p.state==='started'?(active===p.id?'running':'unknown'):p.state,selection:p.selection,startedAt:p.startedAt,deadlineAt:p.deadlineAt,completedAt:p.completedAt,error:p.error,verifiedForCurrentBinding:p.state==='succeeded'&&bindingMatches(s,p)}:null;}
 async function status(a){
  if(!exact(a,[]))fail('ARGUMENTS');
  const s=await snapshot(),p=await read();
  return {contract:2,available:available(),target:s.target,receipt:publicReceipt(p,s),limits:MODEL_PROBE_LIMITS,automaticRetry:false,defaultModelChanged:false,taskStarted:false};
 }
 async function preview(a){
  if(!exact(a,['query','acknowledgeUnknown',...(a?.clarification!==undefined?['clarification']:[])])||typeof a.query!=='string'||!a.query.trim()||a.query.length>200||a.clarification!==undefined&&(!text(a.clarification)||!a.clarification.trim())||a.acknowledgeUnknown!==null&&!uuid(a.acknowledgeUnknown))fail('ARGUMENTS');
  return run(async()=>{
   plan=null;const old=await read(),s=await snapshot();
   if(!bindingMatches(s,s))fail('BINDING_REQUIRED');
   if(active||old?.state==='started'&&now()<old.deadlineAt)fail('BUSY');
   const unknown=old&&['started','unknown'].includes(old.state);
   if(unknown&&a.acknowledgeUnknown!==old.id)fail('UNKNOWN_ACK_REQUIRED');
   if(!unknown&&a.acknowledgeUnknown!==null)fail('UNKNOWN_CHANGED');
   const lookup={query:a.query,...(a.clarification!==undefined?{clarification:a.clarification}:{})},resolved=await resolve(lookup);
   if(resolved.status!=='resolved')fail('MODEL_SELECTION_REQUIRED');
   if(resolved.selection.provider!==provider)fail('OWN_ROUTE_REQUIRED');
   const body={id:randomUUID(),selection:resolved.selection,bindingRevision:s.bindingRevision,credentialRevision:s.credentialRevision,receiptRevision:old?.revision??0,previousUnknown:unknown?old.id:null,target:s.target,expiresAt:now()+300000,reasoningEffort:'high',limits:MODEL_PROBE_LIMITS};
   plan={...body,fingerprint:hash(body),lookup};
   return {...body,fingerprint:plan.fingerprint,modelRequests:0,authorization:'one_explicit_probe_only'};
  });
 }
 async function begin(a,wait){
  if(!exact(a,['id','fingerprint','confirm'])||!uuid(a.id)||!hex(a.fingerprint)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');
  return run(async()=>{
   const old=await read();
   // A repeated intent only reads its durable outcome. Never retry its model call.
   if(old?.id===a.id&&old.planHash===a.fingerprint)return status({});
   const p=plan;if(!p||p.id!==a.id||p.fingerprint!==a.fingerprint||p.expiresAt<=now())fail('PLAN_EXPIRED');plan=null;
   if(!bindingMatches(await snapshot(),p))fail('BINDING_CHANGED');
   const resolved=await resolve(p.lookup);
   if(resolved.status!=='resolved'||JSON.stringify(resolved.selection)!==JSON.stringify(p.selection))fail('ROUTE_CHANGED');
   if(!bindingMatches(await snapshot(),p))fail('BINDING_CHANGED');
   const startedAt=now(),request={system:MODEL_PROBE_SYSTEM,messages:[createUserMessage({content:[{type:'text',text:MODEL_PROBE_INPUT}],source:{kind:'dsh-onboarding-connection-check'}})],reasoningEffort:'high',maxTokens:MODEL_PROBE_LIMITS.maxTokens,tools:[],purpose:'onboarding-connection-check',sessionId:'onboarding-probe-'+p.id};
   const entry={owner,schema:1,revision:p.receiptRevision+1,id:p.id,planHash:p.fingerprint,state:'started',selection:p.selection,bindingRevision:p.bindingRevision,credentialRevision:p.credentialRevision,startedAt,deadlineAt:startedAt+MODEL_PROBE_LIMITS.timeoutMs,completedAt:null,error:null,request};
   const leave=admit('model_attempt');
   try{await credentials().modifyRecord(key,current=>{if((receipt(current)?.revision??0)!==p.receiptRevision)fail('RECEIPT_CHANGED');return {kind:'grant',payload:entry};});}catch(e){leave();throw e;}
   active=p.id;
   const execution=execute(p,entry,request,leave);
   if(wait)return execution;
   // The persistent intent precedes this detached attempt. Host restart never
   // resumes it; only status is recoverable. Handle rejection without logging.
   void execution.catch(()=>{});
   return status({});
  });
 }
 async function execute(p,entry,request,leave){
   const controller=new AbortController();let timer,timedOut=false,state='succeeded',error=null;
   const attempt=(async()=>{
    if(now()>=entry.deadlineAt)fail('DEADLINE');
    const policy={provider,model:p.selection.model,reasoningEffort:'high',maxTokens:MODEL_PROBE_LIMITS.maxTokens};
    const call=await llm().prepareCall(policy,controller.signal);
    controller.signal.throwIfAborted();
    if(Object.keys(policy).some(k=>call.config[k]!==policy[k]))fail('ROUTE_CHANGED');
    if(!bindingMatches(await snapshot(),p))fail('BINDING_CHANGED');
    // A credential lookup can finish after our deadline. Do not even dispatch
    // an already-aborted request; adapter cancellation is a second barrier.
    controller.signal.throwIfAborted();
    const blocks=new BlockAssembler();let bytes=0,finish=null;
    for await(const chunk of call.stream({...call.config,...request,signal:controller.signal})){
     controller.signal.throwIfAborted();bytes+=Buffer.byteLength(JSON.stringify(chunk));if(bytes>MODEL_PROBE_LIMITS.maxResponseBytes)fail('OUTPUT_LIMIT');
     if(finish)fail('INCOMPLETE');blocks.push(chunk);if(chunk.type==='finish')finish=blocks.finish;
    }
    controller.signal.throwIfAborted();
    if(!finish)fail('INCOMPLETE');
    if(finish.kind!=='stop'){const code=finish.failure?.code;throw Object.assign(Error('Provider attempt did not succeed'),{code:safeCodes.has(code)?code:'PROVIDER_ERROR'});}
    const content=blocks.blocks();if(content.some(b=>!['text','reasoning'].includes(b.type)))fail('TOOL_DENIED');
    if(!content.some(b=>b.type==='text'&&b.text.trim()))fail('EMPTY_RESPONSE');
    if(!bindingMatches(await snapshot(),p))fail('BINDING_CHANGED');
   })();
   try{await Promise.race([attempt,new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();reject(Error('ONBOARDING_MODEL_PROBE_DEADLINE'));},Math.max(0,entry.deadlineAt-now()));})]);}
   catch(e){const code=e?.message?.replace(/^ONBOARDING_MODEL_PROBE_/,'');error=timedOut?'DEADLINE':ownCodes.has(code)?code:safeCodes.has(e?.code)?e.code:'PROVIDER_ERROR';state=['DEADLINE','INCOMPLETE'].includes(error)?'unknown':'failed';}
   finally{clearTimeout(timer);controller.abort();}
   // Do not persist provider text, reasoning, auth headers, or exception messages.
   try{await credentials().modifyRecord(key,current=>{const c=receipt(current);if(c?.id!==p.id||c.revision!==entry.revision||c.state!=='started')fail('RECEIPT_CHANGED');return {kind:'grant',payload:{...c,revision:c.revision+1,state,error,completedAt:now()}};});}
   catch{fail('OUTCOME_UNKNOWN');}
   finally{
    // A deadline only ends the caller's observation. An adapter can ignore abort
    // or finish prepareCall later; retain admission until that original promise ends.
    void attempt.catch(()=>{}).finally(()=>{if(active===p.id)active=null;leave();});
   }
   return status({});
 }
 return {available,status,preview,apply:a=>begin(a,true),start:a=>begin(a,false)};
}
