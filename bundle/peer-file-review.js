// Per-item, disabled-only queue decisions. No network, source reads or deletion.
// A migration hold proves the prior transfer phase; a review receipt and the
// queue update share one SQLite transaction, so a lost reply is never a resend.
import fs from 'node:fs';
import path from 'node:path';
import {FileRoot,fileHash} from './peer-file-fs.js';
import {FILE_MAX,FILE_CHUNK,fileMetadata} from './peer-files.js';
import {fileScopeConfig} from './peer-file-migration.js';
import {digest} from './onboarding-ssh.js';
const json=JSON.stringify,fail=c=>{throw Error('ONBOARDING_FILES_'+c);};
const tables={outgoing:'peer_file_out',incoming:'peer_file_in',broker:'peer_file_broker'};
const phases={outgoing:['preparing','queued','broker_saved'],incoming:['receiving','publishing'],broker:['receiving','available']};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.slice().sort().join();
const exists=(db,table)=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
export function fileQueueItem(item){
 if(!exact(item,['queue','id','origin'])||!Object.hasOwn(tables,item.queue)||!/^file-[a-f0-9]{64}$/.test(item.id)||!(item.queue==='broker'?['local','cloud'].includes(item.origin):item.origin===''))fail('ARGUMENTS');return item;
}
function owner(db,scope){const cfg=fileScopeConfig(scope),rows=db.prepare('SELECT * FROM peer_file_owner').all();if(rows.length!==1||rows[0].id!==1||rows[0].config!==cfg)fail('QUEUE_OWNER_REVIEW');return digest(cfg);}
function get(db,item){fileQueueItem(item);const row=db.prepare(`SELECT * FROM ${tables[item.queue]} WHERE id=?${item.queue==='broker'?' AND origin=?':''}`).get(...(item.queue==='broker'?[item.id,item.origin]:[item.id]));if(!row||row.state!=='needs_review')fail('QUEUE_NOT_HELD');return row;}
function hold(db,item){return exists(db,'peer_file_hold')?db.prepare('SELECT * FROM peer_file_hold WHERE queue=? AND id=? AND origin=?').get(item.queue,item.id,item.origin)??null:null;}
function metadata(row,item,scope){const m=JSON.parse(row.meta),origin=item.queue==='outgoing'?scope.role:item.queue==='incoming'?(scope.role==='local'?'cloud':'local'):item.origin;
 const checked=fileMetadata(m,scope.namespace,origin,FILE_MAX);if(m.id!==item.id||json(checked)!==row.meta||item.queue==='broker'&&scope.role!=='cloud')fail('QUEUE_METADATA_REVIEW');return checked;
}
function prior(db,row,h,item){
 if(!h||h.held_hash!==digest(row)||!exists(db,'peer_file_migration')||!db.prepare('SELECT operation FROM peer_file_migration WHERE operation=?').get(h.operation))fail('QUEUE_HISTORY_MISSING');let original;try{original=JSON.parse(h.original);}catch{fail('QUEUE_HISTORY_MISSING');}
 if(!original||!phases[item.queue].includes(original.state)||json({...original,state:'needs_review',...(item.queue==='broker'?{}:{error:'PEER_FILE_SCOPE_CHANGED'})})!==json(row))fail('QUEUE_HISTORY_MISSING');
 if(item.queue!=='broker'&&(!Number.isSafeInteger(row.attempts)||row.attempts<0||row.attempts>=16||!Number.isSafeInteger(row.next_at)||row.next_at<0))fail('QUEUE_RETRY_BUDGET');return original;
}
function complete(root,parts,m){const b=root.read(parts,FILE_MAX);if(b.length!==m.size||fileHash(b)!==m.sha256)fail('QUEUE_BYTES_CHANGED');return {size:b.length,sha256:fileHash(b)};}
function partial(root,parts,m,required=false){
 let b;try{b=root.read(parts,FILE_MAX);}catch(e){if(e.code==='ENOENT'&&!required)return {size:0,sha256:fileHash(Buffer.alloc(0)),missing:true};throw e;}
 if(b.length>m.size||b.length!==m.size&&b.length%FILE_CHUNK||required&&b.length!==m.size||b.length===m.size&&fileHash(b)!==m.sha256)fail('QUEUE_BYTES_CHANGED');return {size:b.length,sha256:fileHash(b),missing:false};
}
function present(root,parts){try{return fs.lstatSync(root.at(parts)).isFile()?'file':'unsafe';}catch(e){if(e.code==='ENOENT')return 'missing';throw e;}}
function inspect(g,scope,item,row,h){
 const original=prior(g.db,row,h,item),m=metadata(row,item,scope);if(m.size>scope.maxBytes)fail('QUEUE_SIZE_LIMIT');if(m.size===0&&m.sha256!==fileHash(Buffer.alloc(0)))fail('QUEUE_BYTES_CHANGED');
 const spool=new FileRoot(path.join(g.c.stateDir,'peer-files')),stem=[m.from,m.id],evidence={};let state=original.state;
 if(item.queue==='outgoing'){
  evidence.snapshot=complete(spool,['send',stem[0],stem[1]+'.blob'],m);if(state==='preparing')state='queued';
 }else if(item.queue==='incoming'){
  evidence.partial=partial(spool,['receive',stem[0],stem[1]+'.part'],m,state==='publishing'&&m.size>0);
  const receive=new FileRoot(scope.receiveRoot),dest=[m.task_id,m.id,m.name],availability=present(receive,dest);evidence.destination=availability;
  if(availability!=='missing'){
   if(state!=='publishing'||availability!=='file')fail('QUEUE_DESTINATION_EXISTS');evidence.received=complete(receive,dest,m);
  }
 }else if(state==='available')evidence.snapshot=complete(spool,['broker',stem[0],stem[1]+'.blob'],m);
 else{
  evidence.partial=partial(spool,['broker',stem[0],stem[1]+'.part'],m);
  const blob=['broker',stem[0],stem[1]+'.blob'];if(present(spool,blob)!=='missing')evidence.snapshot=complete(spool,blob,m);
 }
 return {state,filesHash:digest(evidence)};
}
function safe(e){return /^ONBOARDING_FILES_[A-Z_]+$/.test(e?.message)?e.message:'ONBOARDING_FILES_QUEUE_BYTES_UNAVAILABLE';}
export function fileQueueList(g,scope){
 owner(g.db,scope);const items=[];
 for(const [queue,table] of Object.entries(tables)){
  const all=g.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();if(all.length>64)fail('QUEUE_LIMIT');
  for(const row of all.filter(r=>r.state==='needs_review')){
   const item={queue,id:row.id,origin:queue==='broker'?row.origin:''};fileQueueItem(item);const h=hold(g.db,item);let m=null,reason=null;
   try{m=metadata(row,item,scope);prior(g.db,row,h,item);}catch(e){reason=safe(e);}
   const retained=exists(g.db,'peer_file_review')&&!!g.db.prepare("SELECT operation FROM peer_file_review WHERE queue=? AND id=? AND origin=? AND row_hash=? AND decision='retain' LIMIT 1").get(queue,item.id,item.origin,digest(row));
   items.push({item,name:m?.name??null,from:m?.from??null,to:m?.to??null,size:m?.size??null,sha256:m?.sha256??null,taskId:m?.task_id??null,state:'needs_review',reason:row.error??'PEER_FILE_SCOPE_CHANGED',recoveryCheck:reason??'requires_byte_validation',retained,attempts:row.attempts??null,nextAt:row.next_at??null});
  }
 }
 return {contract:1,role:scope.role,runtimeId:scope.runtimeId,items,writes:0,automaticRetry:false,automaticDeletion:false,executionAuthorized:false,repositoryWriteAuthorized:false};
}
export function fileQueuePlan(g,scope,{item,decision}){
 if(!['resume','retain'].includes(decision))fail('ARGUMENTS');const ownerHash=owner(g.db,scope),row=get(g.db,item),h=hold(g.db,item);
 const validation=decision==='resume'?inspect(g,scope,item,row,h):{state:'needs_review',filesHash:null};let m=null;try{m=metadata(row,item,scope);}catch{if(decision==='resume')fail('QUEUE_METADATA_REVIEW');}
 return {item,decision,name:m?.name??null,from:m?.from??null,to:m?.to??null,size:m?.size??null,sha256:m?.sha256??null,taskId:m?.task_id??null,restoreState:validation.state,snapshot:{ownerHash,rowHash:digest(row),holdHash:digest(h),filesHash:validation.filesHash},attempts:row.attempts??null,nextAt:row.next_at??null,snapshotOnly:item.queue==='outgoing',requiresSeparateEnable:true,preservesFiles:true,executionAuthorized:false,repositoryWriteAuthorized:false};
}
export function fileQueueReceipt(db,operation,fingerprint){
 if(!exists(db,'peer_file_review'))return null;const r=db.prepare('SELECT * FROM peer_file_review WHERE operation=?').get(operation);if(!r)return null;if(fingerprint&&r.fingerprint!==fingerprint)fail('QUEUE_RECEIPT_CONFLICT');let v;try{v=JSON.parse(r.receipt);}catch{fail('QUEUE_RECEIPT_REVIEW');}
 if(!exact(v,['contract','operation','fingerprint','runtimeId','role','item','decision','stateAtDecision','attempts','nextAt','requiresSeparateEnable','preservesFiles','executionAuthorized','repositoryWriteAuthorized'])||v.contract!==1||v.operation!==r.operation||v.fingerprint!==r.fingerprint||v.decision!==r.decision||!['retain','resume'].includes(v.decision)||!['local','cloud'].includes(v.role)||!/^[a-f0-9-]{36}$/.test(v.runtimeId)||v.item?.queue!==r.queue||v.item?.id!==r.id||v.item?.origin!==r.origin||v.requiresSeparateEnable!==true||v.preservesFiles!==true||v.executionAuthorized!==false||v.repositoryWriteAuthorized!==false)fail('QUEUE_RECEIPT_REVIEW');
 fileQueueItem(v.item);if(v.decision==='retain'?v.stateAtDecision!=='needs_review':!(phases[v.item.queue].includes(v.stateAtDecision)&&v.stateAtDecision!=='preparing'))fail('QUEUE_RECEIPT_REVIEW');return v;
}
export function fileQueueClosed(db,operation,fingerprint){
 if(!exists(db,'peer_file_review_closed'))return false;const r=db.prepare('SELECT fingerprint FROM peer_file_review_closed WHERE operation=?').get(operation);if(!r)return false;if(r.fingerprint!==fingerprint)fail('QUEUE_RECEIPT_CONFLICT');return true;
}
export function closeFileQueuePlan(db,operation,fingerprint){
 db.exec('BEGIN IMMEDIATE');try{
  // The first committed decision wins. Closing a lost apply cannot undo a
  // completed queue change; closing first prevents every late copy of that apply.
  const receipt=fileQueueReceipt(db,operation,fingerprint);if(receipt){db.exec('COMMIT');return;}
  db.exec('CREATE TABLE IF NOT EXISTS peer_file_review_closed(operation TEXT PRIMARY KEY,fingerprint TEXT NOT NULL)');
  if(!fileQueueClosed(db,operation,fingerprint))db.prepare('INSERT INTO peer_file_review_closed VALUES(?,?)').run(operation,fingerprint);
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
}
export function applyFileQueuePlan(g,scope,plan){
 const db=g.db;db.exec('BEGIN IMMEDIATE');try{
  db.exec('CREATE TABLE IF NOT EXISTS peer_file_review(operation TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,queue TEXT NOT NULL,id TEXT NOT NULL,origin TEXT NOT NULL,row_hash TEXT NOT NULL,decision TEXT NOT NULL,receipt TEXT NOT NULL)');
  const old=fileQueueReceipt(db,plan.id,plan.fingerprint);if(old){db.exec('COMMIT');return {...old,notReapplied:true};}
  if(fileQueueClosed(db,plan.id,plan.fingerprint))fail('QUEUE_CLOSED');
  const actual=fileQueuePlan(g,scope,plan.review);if(json(actual)!==json(plan.review))fail('QUEUE_CHANGED');
  if(db.prepare('SELECT count(*) n FROM peer_file_review').get().n>=1024)fail('QUEUE_REVIEW_LIMIT');
  const {item,decision,restoreState}=actual;
  if(decision==='resume'){
   const row=get(db,item),params=item.queue==='broker'?[restoreState,item.id,item.origin]:[restoreState,null,item.id];
   const changed=db.prepare(`UPDATE ${tables[item.queue]} SET state=?${item.queue==='broker'?'':',error=?'} WHERE id=?${item.queue==='broker'?' AND origin=?':''} AND state='needs_review'`).run(...params).changes;
   if(changed!==1||digest(row)!==actual.snapshot.rowHash)fail('QUEUE_CHANGED');
  }
  const receipt={contract:1,operation:plan.id,fingerprint:plan.fingerprint,runtimeId:scope.runtimeId,role:scope.role,item,decision,stateAtDecision:restoreState,attempts:actual.attempts,nextAt:actual.nextAt,requiresSeparateEnable:true,preservesFiles:true,executionAuthorized:false,repositoryWriteAuthorized:false};
  db.prepare('INSERT INTO peer_file_review VALUES(?,?,?,?,?,?,?,?)').run(plan.id,plan.fingerprint,item.queue,item.id,item.origin,actual.snapshot.rowHash,decision,json(receipt));
  db.exec('COMMIT');return receipt;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
