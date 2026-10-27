// Private, explicit operator reconciliation. Never resets, retries, repairs an index or closes an unknown child.
import {constants,lstatSync,fstatSync,realpathSync,openSync,readSync,closeSync,unlinkSync,fsyncSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {canonical,digest} from './approval-ledger.js';
import {DeliveryGitRead,validateGitBaseline} from './delivery-git-read.js';
const same=(a,b)=>canonical(a)===canonical(b),sha=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Error('DELIVERY_RECOVERY_'+code);};
const safe=e=>/^DELIVERY_(?:RECOVERY|GIT)_[A-Z_]+$/.test(e?.message)?e.message:'DELIVERY_RECOVERY_EVIDENCE_UNKNOWN';
const names=['config.lock','index.lock'];
const stamp=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
const statId=s=>({device:String(s.dev),inode:String(s.ino)});
const absent=p=>{try{return lstatSync(p,{bigint:true});}catch(e){if(e.code==='ENOENT')return null;throw e;}};
export class DeliveryRecoveryLocks {
 constructor(identity,tag,records,index=null){this.identity=structuredClone(identity);this.tag=structuredClone(tag);this.records=structuredClone(records);this.index=index;this.gd=join(identity.root,'.git');}
 checkRoot(){for(const [p,id] of [[this.identity.root,this.identity.directory],[this.gd,this.identity.git_directory]]){const s=lstatSync(p,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(p)!==p||!same(statId(s),id))fail('DIRECTORY_CHANGED');}}
 read(name){
  if(!names.includes(name))fail('LOCK_NAME_DENIED');this.checkRoot();const path=join(this.gd,name),before=absent(path);if(!before)return {name,state:'absent'};
  const expected=this.records[name];if(!expected||!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>8388608n||!same(statId(before),expected))fail('FOREIGN_LOCK');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   if(stamp(fstatSync(fd,{bigint:true}))!==stamp(before))fail('LOCK_CHANGED');
   const b=Buffer.alloc(Number(before.size)+1);let n=0,count;while(n<b.length&&(count=readSync(fd,b,n,b.length-n,null))>0)n+=count;
   if(n!==Number(before.size)||stamp(fstatSync(fd,{bigint:true}))!==stamp(before)||stamp(lstatSync(path,{bigint:true}))!==stamp(before))fail('LOCK_CHANGED');
   const data=b.subarray(0,n),hash=sha(data),marker=Buffer.from(canonical(this.tag)+'\n');
   const kind=data.equals(marker)?'owner-marker':name==='index.lock'&&this.index?.sha256===hash&&this.index.bytes===n?'prepared-index':null;
   if(!kind)fail('LOCK_CONTENT_UNKNOWN');
   return {name,state:'owned',identity:expected,sha256:hash,bytes:n,stamp:stamp(before),kind};
  }finally{closeSync(fd);}
 }
 scan(){this.checkRoot();return names.map(n=>this.read(n));}
 release(expected,beforeEach=()=>{}){
  if(!same(this.scan(),expected))fail('STALE_LOCK_EVIDENCE');
  // No mkdir/open-for-write/rename. Delete only exact ledger-owned files, never another Git lock.
  for(const e of [...expected].reverse()){
   if(e.state!=='owned')continue;beforeEach(e.name);if(!same(this.read(e.name),e))fail('LOCK_CHANGED');this.checkRoot();
   unlinkSync(join(this.gd,e.name));const fd=openSync(this.gd,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
  }
 }
}
export function classifyDelivery(intent,before,current,index=null){
 validateGitBaseline(intent,before);const {fingerprint,...body}=current??{},p=intent.plan;
 if(!fingerprint||digest(body)!==fingerprint||current.kind!=='git-state-v1'||current.intent_fingerprint!==intent.fingerprint||
  !same(current.workspace_identity,intent.workspace_identity)||current.branch!==p.branch||current.manifest_sha256!==p.manifest_sha256||
  current.parent_tree_oid!==before.parent_tree_oid||!Array.isArray(current.objects_present)||
  new Set(current.objects_present).size!==current.objects_present.length||!same(current.objects_present,[...current.objects_present].sort())||current.objects_present.some(o=>!p.objects.some(x=>x.oid===o)))fail('SNAPSHOT_INVALID');
 if(!current.metadata||!same(Object.keys(current.metadata).sort(),Object.keys(before.metadata).sort())||
  Object.entries(current.metadata).some(([k,v])=>k==='index_sha256'&&v===null?false:typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v)))fail('SNAPSHOT_INVALID');
 if(current.metadata.config_sha256!==before.metadata.config_sha256||current.metadata.head_sha256!==before.metadata.head_sha256)return 'metadata_conflict';
 if(before.objects_present.some(o=>!current.objects_present.includes(o)))return 'object_store_conflict';
 if(current.head_oid!==current.ref_oid)return 'reference_conflict';
 const original=current.head_oid===p.parent,committed=current.head_oid===p.computed_commit_oid,all=current.objects_present.length===p.objects.length;
 if(!original&&!committed)return 'reference_conflict';
 if(same(current,before))return 'no_effect';
 const oldIndex=current.index_tree_oid===before.index_tree_oid&&current.metadata.index_sha256===before.metadata.index_sha256;
 if(committed&&all&&current.index_tree_oid===p.tree_oid)return 'commit_complete';
 if(committed&&all&&oldIndex)return 'reference_applied_index_pending';
 if(original&&oldIndex&&current.objects_present.length>before.objects_present.length)return 'objects_present_no_commit';
 if(original&&current.index_tree_oid===p.tree_oid&&index&&current.metadata.index_sha256===index.sha256)return 'index_without_reference';
 return 'state_conflict';
}
export class DeliveryRecovery {
 constructor({journal,binding,enabled=false,quiescent=()=>false},io={}){
  this.j=journal;this.db=journal.db;this.binding=structuredClone(binding);this.enabled=enabled;this.quiescent=quiescent;this.active=false;
  this.makeLocks=io.makeLocks??((...a)=>new DeliveryRecoveryLocks(...a));
  this.makeReader=io.makeReader??(proofs=>new DeliveryGitRead({binding:this.binding,drained:()=>this.quiescent()===true,ownedLocks:()=>proofs}));
  this.db.exec(`CREATE TABLE IF NOT EXISTS delivery_recoveries(event_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,action_id TEXT NOT NULL,epoch INTEGER NOT NULL,
   decision TEXT NOT NULL,evidence_hash TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,result TEXT);`);
 }
 guard(id,epoch){if(this.enabled!==true)fail('DISABLED');return this.j.fence(id,epoch,['needs_review']);}
 evidenceRows(id,epoch){
  const operations=this.db.prepare('SELECT * FROM delivery_operations WHERE action_id=? ORDER BY rowid').all(id);
  if(operations.some(o=>o.epoch!==epoch))fail('OPERATION_EPOCH_CHANGED');
  const records={},events=this.db.prepare("SELECT seq,type,data,created FROM delivery_events WHERE action_id=? AND type IN ('lock_owned','index_planned') ORDER BY seq").all(id);let index=null;
  for(const e of events){const p=JSON.parse(e.data);if(p.epoch!==epoch)fail('LOCK_EPOCH_CHANGED');
   if(e.type==='lock_owned'){
    if(!names.includes(p.name)||records[p.name]||!p.identity||Object.keys(p.identity).sort().join(',')!=='device,inode'||Object.values(p.identity).some(x=>typeof x!=='string'||!/^[0-9]{1,30}$/.test(x)))fail('LOCK_RECORD_INVALID');
    records[p.name]=p.identity;
   }else{if(index)fail('INDEX_RECORD_INVALID');index=p;}
  }
  if(Object.keys(records).length&&operations.filter(o=>o.kind==='lock').length!==1)fail('LOCK_RECORD_INVALID');
  return {operations,events,records,index};
 }
 inspect(id,epoch){
  const row=this.guard(id,epoch),intent=this.j.intent(row),before=row.before_snapshot?JSON.parse(row.before_snapshot):null;
  if(!before)fail('BASELINE_REQUIRED');validateGitBaseline(intent,before);
  if(!same(this.binding,{root:intent.workspace_identity.root,url:intent.resource,branch:intent.plan.branch,base_sha:intent.plan.parent}))fail('BINDING_CHANGED');
  const records=this.evidenceRows(id,epoch),task=this.j.store.task(row.task_id);if(task.revision!==intent.task_revision)fail('TASK_REVISION_CHANGED');
  const base={schema:1,action_id:id,epoch,intent_fingerprint:intent.fingerprint,before_fingerprint:before.fingerprint,
   task:{owner:task.owner,epoch:task.epoch,busy:!!task.busy,blocked:!!task.blocked,revision:task.revision},
   dispatched:!!row.dispatched,state:row.state,operations:records.operations,ownership_events:records.events,
   external_quiescent:this.quiescent()===true,classification:'drain_unknown',locks:null,current:null,error:null,allowed:[],grants_execution:false};
  if(!base.external_quiescent||records.operations.some(o=>o.state!=='closed'))return {evidence:base,fingerprint:digest(base)};
  try{
   if(records.index&&(records.index.plan_fingerprint!==intent.plan.fingerprint||records.index.tree_oid!==intent.plan.tree_oid||
    !/^[a-f0-9]{64}$/.test(records.index.sha256??'')||!Number.isSafeInteger(records.index.bytes)||records.index.bytes<1||records.index.bytes>8388608))fail('INDEX_RECORD_INVALID');
   const set=this.makeLocks(intent.workspace_identity,{action_id:id,epoch,intent_fingerprint:intent.fingerprint},records.records,records.index),locks=set.scan();
   const proofs=Object.fromEntries(locks.filter(l=>l.state==='owned').map(l=>[l.name,l.identity]));
   const reader=this.makeReader(proofs),current=reader.capture(intent);
   if(!same(set.scan(),locks)||this.quiescent()!==true)fail('EVIDENCE_CHANGED');this.guard(id,epoch);
   if(!same(this.evidenceRows(id,epoch),records))fail('EVIDENCE_CHANGED');
   base.classification=classifyDelivery(intent,before,current,records.index);base.locks=locks;base.current=current;
   const owned=locks.some(l=>l.state==='owned');
   if(owned&&['no_effect','objects_present_no_commit','reference_applied_index_pending','commit_complete'].includes(base.classification))base.allowed=['clean_owned_locks'];
   if(!owned&&base.classification==='no_effect')base.allowed=['settle_not_applied'];
   if(!owned&&base.classification==='commit_complete')base.allowed=['settle_completed'];
  }catch(e){base.classification='evidence_unknown';base.error=safe(e);base.allowed=[];}
  return {evidence:base,fingerprint:digest(base)};
 }
 result(row){return row.result?{...JSON.parse(row.result),replayed:true,checked_now:false}:{event_id:row.event_id,action_id:row.action_id,state:'needs_review',replayed:true,checked_now:false,retry_authorized:false};}
 apply(a){
  if(!a||Object.keys(a).sort().join(',')!=='decision,epoch,event_id,evidence_fingerprint,id'||typeof a.id!=='string'||!a.id||a.id.length>128||typeof a.event_id!=='string'||!a.event_id||a.event_id.length>256||
   !Number.isSafeInteger(a.epoch)||a.epoch<1||!/^[a-f0-9]{64}$/.test(a.evidence_fingerprint??'')||!['clean_owned_locks','settle_not_applied','settle_completed'].includes(a.decision))fail('INVALID_REQUEST');
  if(this.enabled!==true)fail('DISABLED');this.j.owner();const fingerprint=digest(a),old=this.db.prepare('SELECT * FROM delivery_recoveries WHERE event_id=?').get(a.event_id);
  if(old){if(old.fingerprint!==fingerprint)fail('EVENT_CONFLICT');return this.result(old);}if(this.active)fail('IN_FLIGHT');this.active=true;
  try{
   const snapshot=this.inspect(a.id,a.epoch);if(snapshot.fingerprint!==a.evidence_fingerprint)fail('STALE_EVIDENCE');
   if(!snapshot.evidence.allowed.includes(a.decision))fail('DECISION_DENIED');
   this.db.prepare("INSERT INTO delivery_recoveries VALUES (?,?,?,?,?,?,'intent',?,NULL)").run(a.event_id,fingerprint,a.id,a.epoch,a.decision,a.evidence_fingerprint,this.j.now());
   let value;
   try{
    if(a.decision==='clean_owned_locks'){
     const row=this.guard(a.id,a.epoch),intent=this.j.intent(row),r=this.evidenceRows(a.id,a.epoch);
     const set=this.makeLocks(intent.workspace_identity,{action_id:a.id,epoch:a.epoch,intent_fingerprint:intent.fingerprint},r.records,r.index);
     const op=this.j.startOperation(a.id,a.epoch,'unlock',{review_event:a.event_id,evidence_hash:a.evidence_fingerprint});let code=1,async=false;
     try{const result=set.release(snapshot.evidence.locks,name=>{this.guard(a.id,a.epoch);if(this.quiescent()!==true)fail('DRAIN_UNKNOWN');this.j.event(a.id,'recovery_lock_remove',{epoch:a.epoch,name,operation:op});});if(result&&typeof result.then==='function'){async=true;fail('ASYNC_CLEANUP_DENIED');}code=0;}
     finally{if(!async)this.j.closed(op,{code});}
     value={action:this.j.view(a.id),released_task:false,locks_cleaned:true,requires_fresh_review:true};
    }else{
     this.guard(a.id,a.epoch);if(this.quiescent()!==true)fail('DRAIN_UNKNOWN');
     // Journal performs a separate fresh observer call, not a caller-provided success flag.
     const action=a.decision==='settle_completed'?this.j.finish(a.id,a.epoch):this.j.settleUnapplied(a.id,a.epoch);
     value={action,released_task:['completed','not_applied'].includes(action.state),locks_cleaned:false};
    }
    const result={event_id:a.event_id,action_id:a.id,decision:a.decision,state:value.action.state==='needs_review'&&!value.locks_cleaned?'needs_review':'recorded',...value,retry_authorized:false};
    this.db.prepare('UPDATE delivery_recoveries SET state=?,result=? WHERE event_id=?').run(result.state,canonical(result),a.event_id);return result;
   }catch(e){
    const result={event_id:a.event_id,action_id:a.id,state:'needs_review',error:safe(e),retry_authorized:false,released_task:null,current_task_state:'query_ledger'};
    this.db.prepare("UPDATE delivery_recoveries SET state='needs_review',result=? WHERE event_id=?").run(canonical(result),a.event_id);return result;
   }
  }finally{this.active=false;}
 }
}
