import {deliveryActions} from './delivery-state.js';
import {randomUUID} from 'node:crypto';
import {readFileSync,openSync,closeSync,fstatSync,realpathSync,constants} from 'node:fs';
import {join} from 'node:path';
import {canonical,digest} from './approval-ledger.js';
import {developmentSpec} from './development-contract.js';
import {DevelopmentFiles} from './development-files.js';
import {DevelopmentWorkspace,contentHash} from './development-workspace.js';

const has=(db,t)=>!!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const actions=Object.freeze({commit:false,push:false,publish:false,deploy:false});
const fail=code=>{throw Error('DELIVERY_'+code);};
const decode=bytes=>{if(bytes===null)return '';if(bytes.includes(0))return null;try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return null;}};
function currentBytes(root,path,sha){
 if(sha===null)return null;
 const name=join(root,path);if(realpathSync(name)!==name)fail('FILE_CONFLICT');
 const fd=openSync(name,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.size>1048576)fail('FILE_CONFLICT');const b=readFileSync(fd);if(contentHash(b)!==sha)fail('FILE_CONFLICT');return b;}finally{closeSync(fd);}
}
// A bounded comparison for review, NOT a patch, shell input, or proof the user read it.
export function compareText(before,after){
 const a=decode(before),b=decode(after);
 if(a===null||b===null)return {format:'binary_or_invalid_utf8',truncated:true,executable_patch:false};
 const al=a.split('\n'),bl=b.split('\n');let prefix=0,suffix=0;
 while(prefix<al.length&&prefix<bl.length&&al[prefix]===bl[prefix])prefix++;
 while(suffix<al.length-prefix&&suffix<bl.length-prefix&&al[al.length-1-suffix]===bl[bl.length-1-suffix])suffix++;
 const clip=ls=>{const s=ls.slice(0,40).join('\n');return {text:s.slice(0,2048),truncated:ls.length>40||s.length>2048};};
 const old=clip(al.slice(prefix,al.length-suffix)),next=clip(bl.slice(prefix,bl.length-suffix));
 return {format:'single_changed_span',before_ends_newline:a.endsWith('\n'),after_ends_newline:b.endsWith('\n'),before_changed_lines:al.length-prefix-suffix,after_changed_lines:bl.length-prefix-suffix,unchanged_prefix_lines:prefix,unchanged_suffix_lines:suffix,before:old.text,after:next.text,truncated:old.truncated||next.truncated,executable_patch:false};
}

// Rendering reads only persisted metadata. It never inspects Git, migrates task
// rows, renews approvals, checks remote access, or gives a filesystem freshness claim.
export function deliverySnapshot(g,task,revision){
 const db=g.store?.db,execution=deliveryActions(g,task);
 if(!has(db,'delivery_previews'))return {available:false,read_only:true,latest:null,execution,grants_execution:false};
 const row=db.prepare('SELECT snapshot FROM delivery_previews WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(task);
 const snapshot=row?JSON.parse(row.snapshot):null;
 return {available:true,read_only:true,latest:snapshot,execution,revision_matches:snapshot?snapshot.spec_revision===revision:null,filesystem_checked_now:false,remote_checked_now:false,grants_execution:false};
}

export class DeliveryPreview {
 constructor(g){
  this.g=g;this.db=g.store.db;
  this.db.exec(`CREATE TABLE IF NOT EXISTS delivery_previews(id TEXT PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,event_fingerprint TEXT NOT NULL,task_id TEXT NOT NULL,request_id TEXT NOT NULL,snapshot TEXT NOT NULL,created INTEGER NOT NULL);`);
 }
 status(task){
  this.g.store.task(task);
  const h=this.db.prepare('SELECT spec_revision FROM task_catalog WHERE task_id=?').get(task);
  return deliverySnapshot(this.g,task,h?.spec_revision??null);
 }
 stored(task,id,fingerprint){
  if(typeof id!=='string'||typeof fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(fingerprint))fail('INVALID_REFERENCE');
  const row=this.db.prepare('SELECT task_id,snapshot FROM delivery_previews WHERE id=?').get(id);
  if(!row||row.task_id!==task)fail('PREVIEW_NOT_FOUND');
  const p=JSON.parse(row.snapshot),{fingerprint:hash,...body}=p;
  if(hash!==fingerprint||digest(body)!==hash||p.task_id!==task||p.id!==id)fail('PREVIEW_FINGERPRINT_MISMATCH');
  return p;
 }
 checked(p){
  const checked=this.inspect(p.task_id,p.spec_revision,p.request_id);
  if(checked.r.expected_hash!==p.tested_content.sha256||checked.a.proposal_hash!==p.source_approval.proposal_hash||checked.spec.branch!==p.workspace_branch||checked.w.b.base_sha!==p.baseline_commit||canonical(checked.a.proposal.repository)!==canonical(p.repository))fail('PREVIEW_CHANGED');
  return checked;
 }
 page(a){
  if(!a||Object.keys(a).some(k=>!['task_id','preview_id','fingerprint','path','side','offset','limit'].includes(k))||typeof a.task_id!=='string'||typeof a.path!=='string'||!['before','after'].includes(a.side)||!Number.isSafeInteger(a.offset)||a.offset<0||!Number.isSafeInteger(a.limit)||a.limit<1||a.limit>4096)fail('INVALID_PAGE');
  const p=this.stored(a.task_id,a.preview_id,a.fingerprint),f=p.files.find(f=>f.path===a.path);
  if(!f)fail('FILE_DENIED');
  const {w}=this.checked(p),sha=f[a.side+'_sha256'];
  const bytes=sha===null?null:a.side==='before'?Buffer.from(w.git(['show',p.baseline_commit+':'+f.path])):currentBytes(w.root,f.path,sha);
  if((bytes===null?null:contentHash(bytes))!==sha)fail('FILE_CONFLICT');
  this.checked(p);
  const value=decode(bytes),base={schema:1,task_id:p.task_id,preview_id:p.id,fingerprint:p.fingerprint,path:f.path,side:a.side,sha256:sha,bytes:bytes?.length??null,read_only:true,grants_execution:false,checked_at:this.g.now(),cursor_unit:'unicode_codepoints',executable_patch:false};
  if(value===null)return {...base,state:'binary_or_invalid_utf8',text:null,next_offset:null};
  const points=Array.from(value);if(a.offset>points.length)fail('INVALID_PAGE');
  const end=Math.min(a.offset+a.limit,points.length);
  return {...base,state:bytes===null?'absent':'text',text:points.slice(a.offset,end).join(''),offset:a.offset,end_offset:end,total_codepoints:points.length,next_offset:end<points.length?end:null};
 }
 approvalSnapshot(task,revision,reference,repository,policy){
  const p=this.stored(task,reference.preview_id,reference.fingerprint);
  if(p.spec_revision!==revision||canonical(p.repository)!==canonical(repository))fail('APPROVAL_REFERENCE_MISMATCH');
  const checked=this.checked(p);
  if(canonical(checked.a.proposal.model_policy)!==canonical(policy))fail('APPROVAL_MODEL_MISMATCH');
  if(!p.files.some(f=>f.changed))fail('CHANGES_REQUIRED');
  // Bind an independently reviewable exact commit plan, not general commit scope.
  // No commit exists or is executed here. Push/publish/deploy are separate future gates.
  return {kind:'commit-preview-v1',preview_id:p.id,fingerprint:p.fingerprint,development_request_id:p.request_id,source_approval_hash:p.source_approval.proposal_hash,task_revision:p.spec_revision,repository_fingerprint:p.repository.fingerprint,workspace_branch:p.workspace_branch,baseline_commit:p.baseline_commit,tested_content_sha256:p.tested_content.sha256,tested_content_kind:p.tested_content.kind,files_digest:digest(p.files.map(f=>({path:f.path,action:f.approved_action,before:f.before_sha256,after:f.after_sha256}))),file_count:p.files.length,changed_files:p.files.filter(f=>f.changed).length,commit_message:reference.commit_message,execution:'disabled',push:false,publish:false,deploy:false};
 }
 matches(task,revision,plan){
  // Pure ledger check for rendering/confirmation. No implicit filesystem refresh.
  try{const p=this.stored(task,plan.preview_id,plan.fingerprint);return plan.kind==='commit-preview-v1'&&plan.task_revision===revision&&p.spec_revision===revision&&plan.development_request_id===p.request_id&&plan.source_approval_hash===p.source_approval.proposal_hash&&plan.repository_fingerprint===p.repository.fingerprint&&plan.workspace_branch===p.workspace_branch&&plan.baseline_commit===p.baseline_commit&&plan.tested_content_sha256===p.tested_content.sha256&&plan.files_digest===digest(p.files.map(f=>({path:f.path,action:f.approved_action,before:f.before_sha256,after:f.after_sha256})))&&plan.execution==='disabled'&&plan.push===false&&plan.publish===false&&plan.deploy===false;}catch{return false;}
 }
 inspect(task,revision,request){
  const g=this.g,gate=g.development?.gate;
  const bindings=gate?.bindings??g.c?.development?.bindings;
  if(!bindings||!has(this.db,'development_requests'))fail('CAPABILITY_REQUIRED');
  const h=this.db.prepare('SELECT * FROM task_catalog WHERE task_id=?').get(task);
  if(!h||h.legacy||h.spec_revision!==revision)fail('TASK_REVISION_CONFLICT');
  const t=g.store.task(task);if(t.busy||t.blocked)fail('TASK_BUSY');
  g.assertTaskQuiescent(task);
  let r;
  if(request){r=this.db.prepare('SELECT * FROM development_requests WHERE id=?').get(request);if(!r)fail('REQUEST_NOT_FOUND');}
  else{
   const rows=this.db.prepare("SELECT r.* FROM development_requests r JOIN approval_requests a ON a.id=r.approval_id WHERE r.task_id=? AND a.spec_revision=? AND r.state='completed' ORDER BY r.seq DESC LIMIT 2").all(task,revision);
   if(rows.length!==1)fail(rows.length?'REQUEST_AMBIGUOUS':'COMPLETED_REQUEST_REQUIRED');
   r=rows[0];
  }
  if(r.task_id!==task||r.state!=='completed')fail('COMPLETED_REQUEST_REQUIRED');
  if(this.db.prepare("SELECT 1 FROM development_requests WHERE resource=? AND state IN ('queued','active','needs_review')").get(r.resource))fail('RESOURCE_BUSY');
  if(gate?.inflight.has(r.id)||this.db.prepare("SELECT 1 FROM development_operations WHERE request_id=? AND state<>'closed'").get(r.id)||this.db.prepare("SELECT 1 FROM development_writes WHERE request_id=? AND state<>'applied'").get(r.id))fail('DRAIN_REQUIRED');
  // Completed development is historical evidence, not a fresh execution grant.
  // Expired/superseded approval may be inspected without being revived.
  const record=g.approvals.row(r.approval_id),a=g.approvals.view(r.approval_id),spec=developmentSpec(a.proposal.development),binding=bindings[task];
  const authority=digest({approval:a.id,proposal_hash:a.proposal_hash,spec});
  if(a.task_id!==task||a.spec_revision!==revision||digest({task_id:a.task_id,spec_revision:a.spec_revision,task_hash:record.task_hash,proposal:a.proposal,repository_revision:a.repository_revision,expires:a.expires})!==a.proposal_hash||canonical(a.proposal.scopes)!==canonical(['develop'])||r.authority_hash!==authority||binding?.approval_hash!==authority||canonical(JSON.parse(r.policy))!==canonical(a.proposal.model_policy))fail('SOURCE_EVIDENCE_MISMATCH');
  if(!g.repositories.matches(task,a.repository_revision,a.proposal.repository))fail('REPOSITORY_BINDING_MISMATCH');
  const w=new (spec.kind==='workspace-v1'?DevelopmentFiles:DevelopmentWorkspace)(binding,spec,a.proposal.repository);
  if(!r.workspace_identity||r.workspace_identity!==canonical(w.identity()))fail('WORKSPACE_IDENTITY_MISMATCH');const state=w.check(r.expected_hash),test=JSON.parse(r.test_result??'null');
  if(!r.expected_hash||!test?.passed||test.file_hash!==r.expected_hash)fail('TEST_EVIDENCE_REQUIRED');
  const safe=this.db.prepare("SELECT data FROM development_events WHERE request_id=? AND type='safe_point' ORDER BY seq DESC LIMIT 1").get(r.id);
  if(!safe||canonical(JSON.parse(safe.data))!==canonical({node:r.node,epoch:r.epoch,hash:r.expected_hash}))fail('HANDOFF_EVIDENCE_REQUIRED');
  if(spec.kind==='workspace-v1'){
   if(test.validator!=='approved-commands-v1'||test.commands?.length!==spec.commands.length)fail('TEST_EVIDENCE_REQUIRED');
   for(const c of spec.commands){
    const row=this.db.prepare('SELECT * FROM development_commands WHERE request_id=? AND command_id=? ORDER BY rowid DESC LIMIT 1').get(r.id,c.id),result=row?.result?JSON.parse(row.result):null;
    const operation=row?this.db.prepare('SELECT request_id,state,exit_code FROM development_operations WHERE id=?').get(row.operation_id):null;
    if(operation?.request_id!==r.id||operation.state!=='closed'||operation.exit_code!==0||row?.state!=='completed'||!result?.passed||!result.drained||result.file_hash!==r.expected_hash||result.command_hash!==digest(c)||canonical(test.commands.find(x=>x.command_id===c.id))!==canonical(result))fail('TEST_EVIDENCE_REQUIRED');
   }
  }else if(test.validator!=='task-summary-v1'||test.cases!==6)fail('TEST_EVIDENCE_REQUIRED');
  return {r,a,spec,w,state,test,h};
 }
 create(node,a){
  if(!['local','cloud'].includes(node)||!a||Object.keys(a).some(k=>!['task_id','expected_revision','request_id','event_id'].includes(k))||typeof a.task_id!=='string'||!Number.isSafeInteger(a.expected_revision)||a.expected_revision<1||typeof a.event_id!=='string'||!a.event_id||a.event_id.length>256||a.request_id!==undefined&&(typeof a.request_id!=='string'||!a.request_id))fail('INVALID_PREVIEW');
  const fp=digest({node,...a}),old=this.db.prepare('SELECT * FROM delivery_previews WHERE event_id=?').get(a.event_id);
  if(old){if(old.event_fingerprint!==fp)fail('EVENT_CONFLICT');return {snapshot:JSON.parse(old.snapshot),replayed:true,filesystem_checked_now:false,grants_execution:false};}
  const {r,spec,w,state,a:approval,test,h}=this.inspect(a.task_id,a.expected_revision,a.request_id);
  const planned=spec.kind==='workspace-v1'?spec.files:[{path:spec.file,action:'create',base_sha256:null}];
  const files=planned.map(f=>{
   const before=f.action==='create'?null:Buffer.from(w.git(['show',w.b.base_sha+':'+f.path]));
   const sha=spec.kind==='workspace-v1'?state.manifest[f.path]?.sha256??null:state.hash;
   const after=currentBytes(w.root,f.path,sha);
   if((before?contentHash(before):null)!==f.base_sha256||(after?contentHash(after):null)!==sha)fail('FILE_CONFLICT');
   return {path:f.path,approved_action:f.action,changed:f.base_sha256!==sha,before_sha256:f.base_sha256,after_sha256:sha,before_bytes:before?.length??null,after_bytes:after?.length??null,comparison:compareText(before,after)};
  });
  // Detect a concurrent edit while reading; the result remains a point-in-time
  // snapshot, never a lease preventing edits after this check.
  this.inspect(a.task_id,a.expected_revision,r.id);
  const snapshot={schema:1,id:'delivery-'+randomUUID(),task_id:a.task_id,title:h.title,spec_revision:a.expected_revision,request_id:r.id,created:this.g.now(),repository:{...approval.proposal.repository},workspace_branch:spec.branch,baseline_commit:w.b.base_sha,tested_content:{kind:spec.kind==='workspace-v1'?'workspace_manifest_sha256':'file_sha256',sha256:r.expected_hash,test:{validator:test.validator,passed:true,required_commands:spec.commands?.map(c=>c.id)??null,cases:test.cases??null},bound_commit:null},files,source_approval:{id:approval.id,proposal_hash:approval.proposal_hash,observed_state:approval.state,scopes:approval.proposal.scopes,historical_evidence_only:true},delivery:{candidate_commit:null,commit:'not_created',remote_acceptance:'not_observed',runtime_adoption:'not_observed',enabled:actions},local_checked_at:this.g.now(),remote_checked_now:false,grants_execution:false};
  snapshot.fingerprint=digest(snapshot);
  this.db.prepare('INSERT INTO delivery_previews VALUES (?,?,?,?,?,?,?)').run(snapshot.id,a.event_id,fp,a.task_id,r.id,canonical(snapshot),snapshot.created);
  return {snapshot,replayed:false,filesystem_checked_now:true,grants_execution:false};
 }
}
