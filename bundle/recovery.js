// Shared durable-queue primitives; no model tools or network admin endpoint.
import {randomUUID} from 'node:crypto';
export const permanentErrors=new Set(['INGRESS_ID_CONFLICT','TASK_CONTENT_CONFLICT','INVALID_TASK_ENVELOPE','INVALID_TASK_TITLE','INVALID_CONTEXT_SOURCE','CONTEXT_ORIGIN_MISMATCH','REFERENCE_NOT_IN_USER_CONTEXT','UNSUPPORTED_REFERENCE','CONTEXT_LIMIT','INVALID_INGRESS','INVALID_GOAL','INVALID_SUBMISSION','AUTH_DENIED','METHOD_DENIED']);
export function safeError(e){const s=e?.message;return permanentErrors.has(s)?s:['DELIVERY_TIMEOUT','SEND_TIMEOUT'].includes(s)?s:'TRANSIENT_FAILURE';}
export function bounded(p,ms,code){let t;return Promise.race([p,new Promise((_,reject)=>{t=setTimeout(()=>reject(Error(code)),ms);})]).finally(()=>clearTimeout(t));}
export function tx(db,fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}
export function migrateRecovery(db){
 tx(db,()=>{
  for(const table of ['submissions','receipts','notices']){
   const names=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name));
   const columns={created_at:'INTEGER',next_attempt_at:'INTEGER NOT NULL DEFAULT 0',last_error:'TEXT',...(table==='submissions'?{}:{attempts:'INTEGER NOT NULL DEFAULT 0',send_uuid:'TEXT',message_id:'TEXT',lease_until:'INTEGER'})};
   for(const [name,type] of Object.entries(columns))if(!names.has(name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
   if(table!=='submissions'){
    // v0.3 sends had no UUID/lease. Their outcome is unknown: never blindly replay.
    db.prepare(`UPDATE ${table} SET status='needs_review',last_error='LEGACY_SEND_UNCERTAIN' WHERE status='sending' AND lease_until IS NULL`).run();
   }
  }
  db.exec('CREATE TABLE IF NOT EXISTS recovery_audit(seq INTEGER PRIMARY KEY,type TEXT,target TEXT,at INTEGER)');
 });
}
export function outboxInsert(db,table,id,text,now){
 if(!['receipts','notices'].includes(table))throw Error('TABLE_DENIED');
 const fields=table==='notices'?',created':'';
 const values=table==='notices'?',?':'';
 db.prepare(`INSERT OR IGNORE INTO ${table}(id,text,status,send_uuid,created_at${fields}) VALUES (?,?,'queued',?,?${values})`).run(id,text,randomUUID(),now,...(table==='notices'?[now]:[]));
}
// Restricted operator API: an exact row and an explicit acknowledgement only.
// Does not alter task ownership, write locks, approvals, or payload text.
export function resolveOutbox(db,{table,id,outcome,messageId,acknowledgeDuplicateRisk},now=Date.now()){
 if(!['receipts','notices'].includes(table)||typeof id!=='string'||!id||acknowledgeDuplicateRisk!==true||!['sent','retry'].includes(outcome))throw Error('REVIEW_REQUIRED');
 return tx(db,()=>{
  const row=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  if(row?.status!=='needs_review')throw Error('RETRY_TARGET_NOT_FOUND');
  if(outcome==='sent'&&(typeof messageId!=='string'||!/^om_[A-Za-z0-9_-]+$/.test(messageId)))throw Error('MESSAGE_ID_REQUIRED');
  if(outcome==='retry'&&table==='notices'&&now-row.created>=300000)throw Error('NOTICE_EXPIRED');
  db.prepare(`UPDATE ${table} SET status=?,attempts=0,next_attempt_at=0,last_error=NULL,lease_until=NULL,send_uuid=COALESCE(send_uuid,?),message_id=? WHERE id=?`).run(outcome==='sent'?'sent':'queued',randomUUID(),outcome==='sent'?messageId:null,id);
  db.prepare('INSERT INTO recovery_audit(type,target,at) VALUES (?,?,?)').run('outbox-'+outcome,table+':'+id,now);
  return {id,status:outcome==='sent'?'sent':'queued'};
 });
}
