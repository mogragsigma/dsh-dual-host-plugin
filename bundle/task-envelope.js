import {parsePolicyEnvelope,policyEnvelopeVersion} from './source-policy-envelope.js';
import {autonomous,CLOUD_TASK_POLICY,TASK_CONTEXT_MAX,validateTaskChannel} from './managed-cloud-policy.js';
import {humanMessages} from './native-human-context.js';
// The native Host owns request provenance. Model-written summaries are not the source.
import {createHash} from 'node:crypto';
import {validateSearch,searchExecutor,taskExecutor} from './search-contract.js';
import {newCloudPolicy,validPolicy,validSources,validReferences,validSuggestions} from './task-context.js';
const hash=text=>createHash('sha256').update(text).digest('hex');
export const envelopeVersion='dsh-native-task-v1';
export function identity(role,{managed=false}={}){
 if(!['local','cloud'].includes(role))throw Error('INVALID_DEPLOYMENT');
 return {role,name:role==='local'?'本地大肥鱼':'云端大肥鱼',peer_role:role==='local'?'cloud':'local',
  peer_name:role==='local'?'云端大肥鱼':'本地大肥鱼',session_role:'entry',worker_host:'cloud',...(managed?{worker_capability:'native-cloud-continuous',task_execution:'cloud-only',authorization:'explicit-user-task-not-im',default_request_limit:null,default_task_ttl:null}:{worker_capability:'readonly-plan',development:false,publish:false})};
}
export function currentHumanRequest(agent){
 return humanRequest(humanMessages(agent).at(-1));
}
export function humanRequest(m){
 if(!m||typeof m.id!=='string'||!m.id)throw Error('HUMAN_REQUEST_UNAVAILABLE');
 if(!Array.isArray(m.content)||m.content.some(x=>x.type!=='text'))throw Error('TEXT_TASK_REQUIRED');
 const text=m.content.map(x=>x.text).join('\n');
 if(!text.trim()||text.length>262144)throw Error('REQUEST_SIZE_UNSUPPORTED');
 return {message_id:m.id,text,sha256:hash(text)};
}
export function selectedHumanContext(agent,role,ids,strict=false){
 const messages=humanMessages(agent);
 if(strict&&ids===undefined&&messages.length>1)throw Error('TASK_CONTEXT_SELECTION_REQUIRED: use task_context_page, select necessary goal/clarification message IDs; do not submit only the final confirmation');
 ids??=[];
 const current=currentHumanRequest(agent);
 if(!Array.isArray(ids)||ids.length>256||new Set(ids).size!==ids.length||ids.some(x=>typeof x!=='string'))throw Error('CONTEXT_SELECTION_INVALID');
 const selected=ids.filter(id=>id!==current.message_id).sort((a,b)=>messages.findIndex(x=>x.id===a)-messages.findIndex(x=>x.id===b)).map(id=>{
  const m=messages.find(x=>x.id===id);
  if(!m)throw Error('CONTEXT_SELECTION_INVALID');
  return humanRequest(m);
 });
 return validSources([...selected,current].map(s=>({role,session_id:agent.id,...s})));
}
export function makeEnvelope(agent,role,args){
 identity(role);
 if(args.target!=='cloud')throw Error('UNSUPPORTED_TASK_TARGET');
 if(!['register','plan'].includes(args.intent))throw Error('TASK_INTENT_REQUIRED');
 if(typeof args.goal!=='string'||!args.goal.trim()||args.goal.length>2000)throw Error('INVALID_GOAL');
 const inputPolicy=args.model_policy??null;
 const policy=inputPolicy?(autonomous(args)?validPolicy(inputPolicy):newCloudPolicy(inputPolicy)):null;
 if(args.intent==='plan'&&(!policy||typeof policy.provider!=='string'||!policy.provider||typeof policy.model!=='string'||!policy.model))throw Error('MODEL_POLICY_REQUIRED');
 if(policy&&(Object.keys(inputPolicy).some(k=>!['provider','model','reasoningEffort'].includes(k))||
   [policy.provider,policy.model].some(v=>typeof v!=='string'||!v||v.length>200)||
   (policy.reasoningEffort!==undefined&&(typeof policy.reasoningEffort!=='string'||policy.reasoningEffort.length>64))))throw Error('INVALID_MODEL_POLICY');
 const request=currentHumanRequest(agent);
 const envelope={schema:envelopeVersion,origin:{role,session_id:agent.id,message_id:request.message_id,request_sha256:request.sha256},
  request_text:request.text,entry_interpretation:args.goal,target:'cloud',executor:'independent-readonly-worker',intent:args.intent,model_policy:policy};
 if(autonomous(args)){envelope.execution_policy=CLOUD_TASK_POLICY;envelope.channel=validateTaskChannel(role,args.channel);envelope.intent='register';}
 if(args.continuity!==undefined){if(args.continuity!==1)throw Error('INVALID_TASK_ENVELOPE');envelope.continuity=1;}
 if(args.notification_contract!==undefined){if(args.notification_contract!==1)throw Error('INVALID_TASK_ENVELOPE');envelope.notification_contract=1;envelope.executor=taskExecutor(envelope);}
 if(args.title!==undefined){if(typeof args.title!=='string'||!args.title.trim()||args.title.length>120)throw Error('INVALID_TASK_TITLE');envelope.title=args.title;}
 if(autonomous(args)||args.search||args.context_message_ids?.length||args.references?.length||args.split_suggestions?.length){
  const sources=selectedHumanContext(agent,role,args.context_message_ids,autonomous(args));
  envelope.task_context={schema:'dsh-task-context-v1',spec_revision:1,sources,references:validReferences(args.references??[],sources),split_suggestions:validSuggestions(args.split_suggestions??[])};
 }
 if(args.search){envelope.search=validateSearch(args.search,envelope.task_context.sources,{autonomous:autonomous(args)});envelope.executor=taskExecutor(envelope);}
 const goal=JSON.stringify(envelope);
 if(Buffer.byteLength(goal)>(autonomous(args)?TASK_CONTEXT_MAX:12000))throw Error('REQUEST_SIZE_UNSUPPORTED');
 return {goal,request,ingress_id:'native:'+role+':'+hash(agent.id+':'+request.message_id),task_key:args.task_key??'task-'+hash(role+':'+agent.id+':'+request.message_id).slice(0,24)};
}
export function parseEnvelope(goal){
 let value;try{value=JSON.parse(goal);}catch{return null;}
 if(value?.schema===policyEnvelopeVersion)return parsePolicyEnvelope(value);
 if(value?.schema!==envelopeVersion)return null;
 if(!value.origin||!['local','cloud'].includes(value.origin.role)||typeof value.request_text!=='string'||
   hash(value.request_text)!==value.origin.request_sha256||value.target!=='cloud'||!['independent-readonly-worker',searchExecutor,'independent-readonly-notify-worker','independent-readonly-search-notify-worker'].includes(value.executor)||
   !['register','plan'].includes(value.intent))throw Error('INVALID_TASK_ENVELOPE');
 if(value.intervention_context){const c=value.intervention_context;if(c.schema!==1||c.scope!=='saved-materials-only'||typeof c.parent_job_id!=='string'||typeof c.original_request!=='string'||typeof c.opinion!=='string'||!c.materials||value.search||value.task_context?.references?.length||value.intent!=='plan'||value.notification_contract)throw Error('INVALID_TASK_ENVELOPE');}
 if(value.execution_policy!==undefined){if(!autonomous(value)||value.intent!=='register'||value.continuity!==1)throw Error('INVALID_TASK_ENVELOPE');validateTaskChannel(value.origin.role,value.channel);}
 if(value.title!==undefined&&(typeof value.title!=='string'||!value.title.trim()||value.title.length>120))throw Error('INVALID_TASK_TITLE');
 if(value.task_context){
  const c=value.task_context;
  if(c.schema!=='dsh-task-context-v1'||!Number.isInteger(c.spec_revision)||c.spec_revision<1)throw Error('INVALID_TASK_ENVELOPE');
  validSources(c.sources);validReferences(c.references,c.sources);validSuggestions(c.split_suggestions);
  if(!c.sources.some(s=>s.role===value.origin.role&&s.session_id===value.origin.session_id&&s.message_id===value.origin.message_id&&s.sha256===value.origin.request_sha256))throw Error('INVALID_TASK_ENVELOPE');
 }
 if(value.search){validateSearch(value.search,value.task_context?.sources??[],{autonomous:autonomous(value)});}
 if(value.continuity!==undefined&&value.continuity!==1)throw Error('INVALID_TASK_ENVELOPE');
 if(value.notification_contract!==undefined&&value.notification_contract!==1||value.executor!==taskExecutor(value))throw Error('INVALID_TASK_ENVELOPE');
 return value;
}
export function assertScheduleEnvelope(goal,policy){
 const e=parseEnvelope(goal);if(!e)return;
 if(e.intent!=='plan')throw Error('TASK_REGISTER_ONLY');
 const p=e.model_policy;
 if(!p||!policy||p.provider!==policy.provider||p.model!==policy.model||p.reasoningEffort!==policy.reasoningEffort)throw Error('TASK_MODEL_POLICY_MISMATCH');
}
// Omitted dispatch effort inherits the persisted revision, not today's default.
// Explicit mismatches still fail, and legacy requests keep their original fingerprints.
export function schedulePolicy(goal,input){
 const stored=parseEnvelope(goal)?.model_policy;
 const policy=input&&input.reasoningEffort===undefined&&stored?.reasoningEffort!==undefined?{...input,reasoningEffort:stored.reasoningEffort}:input;
 assertScheduleEnvelope(goal,policy);return policy;
}
export function sameNativeTask(a,b){
 const left=parseEnvelope(a),right=parseEnvelope(b);
 if(!left&&!right)return true; // Retain legacy multi-ingress semantics; no history rewrite.
 if(!left||!right||left.schema!==right.schema)return false;
 if(left.origin.kind==='policy'&&JSON.stringify(left.source_events)!==JSON.stringify(right.source_events))return false;
 return left.request_text===right.request_text&&left.intent===right.intent&&
  JSON.stringify(left.model_policy)===JSON.stringify(right.model_policy)&&left.target===right.target&&
  left.execution_policy===right.execution_policy&&left.channel===right.channel&&left.continuity===right.continuity&&left.notification_contract===right.notification_contract&&left.title===right.title&&JSON.stringify(left.task_context)===JSON.stringify(right.task_context)&&JSON.stringify(left.search??null)===JSON.stringify(right.search??null);
}
