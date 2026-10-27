import {readFileSync} from 'node:fs';
import {developmentToolNames} from './development-worker.js';
export const inject=['tools','taskGateway'];
const rules=readFileSync(new URL('./development-rules/AGENTS.md',import.meta.url),'utf8');
// Model-facing version strings avoid nullable-union coercion. These are CAS values,
// not authority: the unchanged gate still checks approval, epoch and actual content.
const version=hash=>hash===null?'absent':'sha256:'+hash;
function expectedHash(a){
 if(!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).some(k=>!['content','base_version'].includes(k))||
    typeof a.content!=='string'||typeof a.base_version!=='string'||!/^(?:absent|sha256:[a-f0-9]{64})$/.test(a.base_version))
  throw Error('DEVELOPMENT_BASE_VERSION_INVALID: copy base_version from development_read; do not use null or expected_hash');
 return a.base_version==='absent'?null:a.base_version.slice(7);
}
export function apply(ctx){
 const runtime=ctx.taskGateway.development,worker=runtime?.worker;if(!worker)throw Error('DEVELOPMENT_DISABLED');
 ctx.inject(['systemPrompt'],scope=>scope.systemPrompt.context({name:'dsh-development-worker-role',order:90,text:()=>rules}));
 const register=(name,description,parameters,fn)=>ctx.tools.register({name,description,parameters,output:{schema:{type:'object'},render:(_a,r)=>[{type:'text',text:JSON.stringify(r)}]},execute:fn});
 const bound=e=>{const b=worker.binding(e.agent);if(b.report)throw Error('DEVELOPMENT_REPORT_ALREADY_RECORDED');return {b,r:runtime.requestFor(b.job)};};
 register('development_read','Read only the approved new source file and its base_version. Copy that version string unchanged into development_write.',{type:'object',properties:{},additionalProperties:false},(_a,e)=>{const {r}=bound(e),v=runtime.gate.read(r.id,'cloud',r.epoch);return {base_version:version(v.hash),content:v.content};});
 register('development_write','Write only the approved new source file. Copy base_version from development_read: "absent" or "sha256:<64 lowercase hex>". Do not use null. No commit/push.',{type:'object',properties:{content:{type:'string'},base_version:{type:'string',pattern:'^(?:absent|sha256:[a-f0-9]{64})$'}},required:['content','base_version'],additionalProperties:false},async(a,e)=>{const {b,r}=bound(e);runtime.gate.admitWriteCall(r.id,'cloud',r.epoch,e.callId);const expected_hash=expectedHash(a);await runtime.g.repositories.refresh(b.job.task_id);worker.binding(e.agent);return runtime.gate.write(r.id,'cloud',r.epoch,{content:a.content,expected_hash,call_id:e.callId});});
 register('development_test','Run the fixed six-case validator in a bounded, restricted child. No arbitrary command.',{type:'object',properties:{},additionalProperties:false},async(_a,e)=>{const {b,r}=bound(e);return runtime.gate.test(r.id,'cloud',r.epoch,b.signal);});
 register('development_report','Finish only after the fixed test passes. The plugin records an audit report; no Git delivery.',{type:'object',properties:{summary:{type:'string'}},required:['summary'],additionalProperties:false},(a,e)=>worker.report(e.agent,a));
 const workspace=e=>{const pair=bound(e);if(!pair.b.workspace)throw Error('DEVELOPMENT_CONTRACT_METHOD_MISMATCH');return pair;};
 const strict=(a,keys)=>{if(!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).some(k=>!keys.includes(k)))throw Error('DEVELOPMENT_INVALID_REQUEST');};
 register('development_workspace_read','Read the approved file manifest and plan. Optional path reads ONE approved source/input. base_version is the whole-workspace CAS, not the file SHA. Never reads unrelated files.',{type:'object',properties:{path:{type:'string'}},additionalProperties:false},(a,e)=>{
  strict(a,['path']);if(a.path!==undefined&&typeof a.path!=='string')throw Error('DEVELOPMENT_INVALID_REQUEST');
  const {r}=workspace(e),v=runtime.gate.read(r.id,'cloud',r.epoch,a.path),auth=runtime.gate.assert(r.id,'cloud',r.epoch);
  // Do not send unrelated paths from the full inventory to the model.
  return {base_version:version(v.hash),files:v.files,reads:v.reads,...(a.path!==undefined?{path:v.path,content:v.content}:{}),commands:auth.spec.commands,
   model_budget:runtime.modelBudget.view(r.id),...runtime.gate.progress(r.id),max_writes:auth.spec.max_writes,max_commands:auth.spec.max_commands};
 });
 register('development_workspace_write','Apply ONE explicitly approved file change. Use action write with content (empty string is valid), or action delete with NO content. Copy the current whole-workspace base_version from read. No Git staging/commit.',{type:'object',properties:{path:{type:'string'},action:{type:'string',enum:['write','delete']},content:{type:'string'},base_version:{type:'string',pattern:'^sha256:[a-f0-9]{64}$'}},required:['path','action','base_version'],additionalProperties:false},async(a,e)=>{
  const {b,r}=workspace(e);runtime.gate.admitWriteCall(r.id,'cloud',r.epoch,e.callId);strict(a,['path','action','content','base_version']);
  if(typeof a.path!=='string'||!/^sha256:[a-f0-9]{64}$/.test(a.base_version??'')||
   (a.action==='delete'?Object.hasOwn(a,'content'):a.action!=='write'||typeof a.content!=='string'))throw Error('DEVELOPMENT_INVALID_WRITE');
  await runtime.g.repositories.refresh(b.job.task_id);worker.binding(e.agent);
  const result=runtime.gate.write(r.id,'cloud',r.epoch,{path:a.path,content:a.action==='delete'?null:a.content,expected_hash:a.base_version.slice(7),call_id:e.callId});
  return {...result,base_version:version(result.sha256),digest_scope:'whole_workspace_manifest'};
 });
 register('development_workspace_command','Run ONE command by approved id in the isolated cloud container. Never accepts executable/argv/env overrides. Source is read-only; outputs stay temporary. Requires all required command receipts on the current file manifest before reporting.',{type:'object',properties:{command_id:{type:'string'}},required:['command_id'],additionalProperties:false},async(a,e)=>{
  strict(a,['command_id']);const {b,r}=workspace(e);await runtime.g.repositories.refresh(b.job.task_id);worker.binding(e.agent);
  return runtime.gate.command(r.id,'cloud',r.epoch,{command_id:a.command_id,call_id:e.callId},b.signal);
 });
 ctx.tools.guard(e=>{try{const b=worker.binding(e.agent);if(!developmentToolNames(b.workspace).includes(e.name))return 'DEVELOPMENT_CAPABILITY_DENIED';}catch{return 'DEVELOPMENT_WORKER_NOT_CURRENT';}});
}
