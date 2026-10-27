import {errorInfo} from './link-contract.js';
// Read-only bounded projections. Do not call Gate.assert/acquire, workspace checks,
// repository.refresh, recovery, or any method that changes a ledger while rendering.
const has=(db,t)=>!!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const parse=(s,f=null)=>{try{return JSON.parse(s);}catch{return f;}};
const text=(s,n=128)=>typeof s==='string'?s.slice(0,n):null;
const role=s=>['local','cloud'].includes(s)?s:null;
const known=(s,values)=>values.includes(s)?s:'unknown';
const code=s=>s?errorInfo(s).code:null;
const policy=s=>{const p=parse(s);return p&&typeof p==='object'?{provider:text(p.provider),model:text(p.model),reasoningEffort:text(p.reasoningEffort)}:null;};
const number=n=>Number.isSafeInteger(n)&&n>=0?n:null;
const terminal=new Set(['completed','rejected']);
const events=new Set(['queued','acquired','write_tool_called','write_intent','write_applied','test_intent','test_drained','tested','blocked','safe_point','bridge_review_applied','rejected']);
export const developmentConfiguration=g=>({runtime_enabled:!!g.development?.gate?.enabled,bridge_enabled:!!g.development?.bridge,storage_host:'cloud',approval_required:true,grants_execution:false,publish_enabled:false});
function operations(db,id){
 if(!has(db,'development_operations'))return {available:false,total:0,unclosed:null};
 return {available:true,total:db.prepare('SELECT count(*) n FROM development_operations WHERE request_id=?').get(id).n,unclosed:db.prepare("SELECT count(*) n FROM development_operations WHERE request_id=? AND state<>'closed'").get(id).n};
}
function waiting(g,r,op,approval){
 const db=g.store.db,t=g.store.task(r.task_id);
 if(r.state==='needs_review')return 'development_review';
 if(r.state==='completed')return 'development_handed_off';
 if(r.state==='rejected')return 'development_stopped';
 if(!['queued','active'].includes(r.state))return 'development_unknown';
 if(!r.workspace_identity||!approval)return 'development_evidence_missing';
 if(t.blocked)return 'development_review';
 if(!op.available)return 'development_evidence_missing';
 if(r.state==='active'){
  if(has(db,'development_writes')&&db.prepare("SELECT 1 FROM development_writes WHERE request_id=? AND state<>'applied'").get(r.id))return 'development_review';
  if(op.unclosed)return 'development_testing';
  if(g.development?.gate?.inflight?.has(r.id))return 'development_draining';
  if(!g.development?.gate?.enabled)return 'development_runtime_unavailable';
  if(t.owner!==r.node||t.epoch!==r.epoch||!t.busy)return 'development_evidence_missing';
  if(approval.state!=='approved')return 'development_approval_review';
  const test=parse(r.test_result);return test?.passed===true&&test.file_hash===r.expected_hash?'development_tested':'development_held';
 }
 if(!g.development?.gate?.enabled)return 'development_disabled';
 if(approval.state!=='approved')return 'development_approval_review';
 if(t.busy||g.development.gate.busy?.(r.task_id))return 'task_busy';
 const holder=db.prepare("SELECT id,state FROM development_requests WHERE resource=? AND state IN ('active','needs_review')").get(r.resource);
 if(holder){if(holder.state==='needs_review')return 'development_resource_review';const other=operations(db,holder.id);return other.unclosed||g.development.gate.inflight?.has(holder.id)?'development_resource_draining':'development_resource_busy';}
 if(db.prepare("SELECT 1 FROM development_requests WHERE resource=? AND state='queued' AND seq<?").get(r.resource,r.seq))return 'development_fifo';
 return 'development_queued';
}
function approvalFor(g,r){
 const db=g.store.db;
 if(!has(db,'approval_requests')||!has(db,'task_catalog')||!db.prepare('SELECT 1 FROM task_catalog WHERE task_id=?').get(r.task_id))return null;
 const a=db.prepare('SELECT id FROM approval_requests WHERE id=? AND task_id=?').get(r.approval_id,r.task_id);
 if(!a)return null;
 try{return g.approvals.view(a.id);}catch{return null;}
}
export function developmentSnapshot(g,task,revision,detail=true){
 const db=g.store?.db,available=has(db,'development_requests');
 if(!available)return {available:false,total:0,items:[],current:null,read_only:true,configuration:developmentConfiguration(g)};
 const total=db.prepare('SELECT count(*) n FROM development_requests WHERE task_id=?').get(task).n;
 const rows=db.prepare("SELECT * FROM development_requests WHERE task_id=? ORDER BY CASE WHEN state IN ('active','needs_review') THEN 0 WHEN state='queued' THEN 1 ELSE 2 END,seq DESC LIMIT 20").all(task);
 const items=rows.map(r=>{
  const a=approvalFor(g,r),op=operations(db,r.id),test=parse(r.test_result),writes=has(db,'development_writes')?db.prepare('SELECT state,count(*) count FROM development_writes WHERE request_id=? GROUP BY state').all(r.id).map(x=>({state:known(x.state,['writing','applied']),count:number(x.count)})):[];
  const budget=a&&has(db,'development_writes')?{max_writes:number(a.proposal.development?.max_writes),writes_recorded:db.prepare('SELECT count(*) n FROM development_writes w JOIN development_requests r ON r.id=w.request_id WHERE r.approval_id=?').get(r.approval_id).n,write_calls:has(db,'development_events')?db.prepare("SELECT count(*) n FROM development_events e JOIN development_requests r ON r.id=e.request_id WHERE r.approval_id=? AND e.type='write_tool_called'").get(r.approval_id).n:null,scope:'same_approval_all_requests'}:null;
  let job=null;if(has(db,'development_jobs')){const j=db.prepare('SELECT job_id FROM development_jobs WHERE request_id=?').get(r.id),owned=j&&g.scheduler?.jobs.db.prepare('SELECT id,task_id,status FROM jobs WHERE id=?').get(j.job_id);if(owned?.task_id===task)job={id:owned.id,state:owned.status};}
  const timeline=detail&&has(db,'development_events')?db.prepare('SELECT seq,type,data,created FROM development_events WHERE request_id=? ORDER BY seq DESC LIMIT 20').all(r.id).reverse().filter(x=>events.has(x.type)).map(x=>{const d=parse(x.data,{})??{};return {seq:x.seq,type:x.type,at:x.created,node:role(d.node),epoch:number(d.epoch),prior_epoch:number(d.prior_epoch),code:code(d.code),passed:typeof d.passed==='boolean'?d.passed:null,cases:number(d.cases)};}):[];
  const state=waiting(g,r,op,a);
  const recorded=has(db,'development_attention')?db.prepare('SELECT snapshot,created FROM development_attention WHERE request_id=? ORDER BY rowid DESC LIMIT 1').get(r.id):null,attention=recorded?{...parse(recorded.snapshot,{}),recorded_at:recorded.created,historical:r.state!=='needs_review'}:null;
  return {id:r.id,node:role(r.node),recorded_state:known(r.state,['queued','active','needs_review','completed','rejected']),state,created:r.created,epoch:number(r.epoch),spec_revision:a?.spec_revision??null,approval_id:a?.id??null,approval_state:a?.state??'unavailable',requested_model:policy(r.policy),error:code(r.error),storage_host:'cloud',workspace:r.workspace_identity?'identity_recorded_not_checked_now':'identity_missing',job,budget,writes,operations:op,
   attention,test:test?{passed:test.passed===true,validator:test.validator==='approved-commands-v1'?'approved-commands-v1':'bounded',required_commands:Array.isArray(test.commands)?test.commands.length:null,cases:number(test.cases),matches_file:!!r.expected_hash&&test.file_hash===r.expected_hash}:null,timeline,grants_execution:false};
 });
 // Unresolved old requests retain visibility; completed old revisions cannot mark a new task complete.
 const current=items.find(r=>!terminal.has(r.recorded_state))??items.find(r=>r.spec_revision===revision);
 return {available,total,display_limit:20,items:detail?items:[],current:current?{id:current.id,node:current.node,state:current.state,spec_revision:current.spec_revision,requested_model:current.requested_model,operations:current.operations}:null,read_only:true,configuration:developmentConfiguration(g)};
}
export function developmentDisplayState(existing,s){
 if(!s.current)return existing;
 if(!['development_handed_off','development_stopped'].includes(s.current.state))return s.current.state;
 return ['registered','completed','cancelled'].includes(existing)?s.current.state:existing;
}
export function developmentPeerSnapshot(g,task=null){
 const db=g.db;if(!has(db,'development_peer_requests'))return {available:false,items:[],total:0,authority:'viewer_local_only',grants_execution:false};
 const predicate=task?" WHERE json_valid(payload) AND json_extract(payload,'$.task_id')=?":'',args=task?[task]:[];
 const rows=db.prepare('SELECT id,payload,state,request_id,error,updated FROM development_peer_requests'+predicate+" ORDER BY CASE WHEN state IN ('completed','cancelled') THEN 1 ELSE 0 END,updated DESC,rowid DESC LIMIT 20").all(...args);
 const items=rows.map(r=>{const a=parse(r.payload,{}),unresolved=has(db,'development_peer_calls')?db.prepare("SELECT count(*) n FROM development_peer_calls WHERE local_id=? AND state<>'completed'").get(r.id).n:null;
  return {id:r.id,task_id:text(a?.task_id),cloud_request_id:text(r.request_id),state:known(r.state,['pending','cloud_queued','claiming','active','finishing','reviewing','needs_review','completed','cancelled']),updated:r.updated,error:code(r.error),requested_model:policy(JSON.stringify(a?.policy??null)),unresolved_calls:unresolved,authority:'viewer_local_only',grants_execution:false};});
 return {available:true,items,total:db.prepare('SELECT count(*) n FROM development_peer_requests'+predicate).get(...args).n,authority:'viewer_local_only',grants_execution:false};
}
