// Synchronous, transactional owner rebind. No source reads, transfers or deletion.
// Caller must persist disabled migration consent before invoking migrate().
import path from 'node:path';
import {FileRoot} from './peer-file-fs.js';
import {digest} from './onboarding-ssh.js';
const fail=c=>{throw Error('ONBOARDING_FILES_'+c);};
const json=JSON.stringify;
export function fileScopeConfig(s){
 const outbox=path.join(s.root,'files','outbox');
 return json({role:s.role,namespace:s.namespace,max:s.maxBytes,send:s.sendRoots.map(x=>[x.path,x.identity==='owned-outbox'&&x.path===outbox?new FileRoot(outbox).id:x.identity]),receive:[s.receiveRoot,new FileRoot(s.receiveRoot).id]});
}
const config=fileScopeConfig;
// Keep the exact pre-hold phase in the SAME transaction as the migration. Old
// needs_review rows have no such proof and must never be guessed back to queued.
function captureHolds(db,operation){
 db.exec('CREATE TABLE IF NOT EXISTS peer_file_hold(queue TEXT NOT NULL,id TEXT NOT NULL,origin TEXT NOT NULL,operation TEXT NOT NULL,original TEXT NOT NULL,held_hash TEXT NOT NULL,PRIMARY KEY(queue,id,origin))');
 const insert=db.prepare('INSERT OR REPLACE INTO peer_file_hold VALUES(?,?,?,?,?,?)');
 for(const [queue,table,states] of [['outgoing','peer_file_out',['preparing','queued','broker_saved']],['incoming','peer_file_in',['receiving','publishing']],['broker','peer_file_broker',['receiving','available']]]){
  for(const row of db.prepare(`SELECT * FROM ${table}`).all().filter(r=>states.includes(r.state))){
   const held={...row,state:'needs_review',...(queue==='broker'?{}:{error:'PEER_FILE_SCOPE_CHANGED'})};
   insert.run(queue,row.id,queue==='broker'?row.origin:'',operation,json(row),digest(held));
  }
 }
}
function rows(db){
 const out=db.prepare('SELECT * FROM peer_file_out ORDER BY id').all(),incoming=db.prepare('SELECT * FROM peer_file_in ORDER BY id').all(),broker=db.prepare('SELECT * FROM peer_file_broker ORDER BY id,origin').all();
 if([out,incoming,broker].some(x=>x.length>64))fail('MIGRATION_QUEUE_REVIEW');
 if(out.some(x=>!['preparing','queued','broker_saved','needs_review','received'].includes(x.state))||incoming.some(x=>!['receiving','publishing','needs_review','received'].includes(x.state))||broker.some(x=>!['receiving','available','needs_review','received'].includes(x.state)))fail('MIGRATION_QUEUE_REVIEW');
 return {out,incoming,broker};
}
function owner(db){
 if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='peer_file_owner'").get())fail('MIGRATION_OWNER_REVIEW');
 const a=db.prepare('SELECT * FROM peer_file_owner').all();if(a.length!==1||a[0].id!==1||typeof a[0].config!=='string')fail('MIGRATION_OWNER_REVIEW');return a[0].config;
}
export function migrationSnapshot(db,previous){
 const cfg=owner(db);if(cfg!==config(previous))fail('MIGRATION_OWNER_REVIEW');const r=rows(db);
 return {ownerHash:digest(cfg),queueHash:digest(r),held:{outgoing:r.out.filter(x=>x.state!=='received').length,incoming:r.incoming.filter(x=>x.state!=='received').length,broker:r.broker.filter(x=>x.state!=='received').length}};
}
export function migrateFileScope(db,{operation,planHash,previous,next,snapshot}){
 const before=config(previous),after=config(next);let result;
 db.exec('BEGIN IMMEDIATE');
 try{
  // This journal and the owner/queue changes share one SQLite commit. A matching
  // new owner without this receipt is never taken as evidence of our completion.
  db.exec('CREATE TABLE IF NOT EXISTS peer_file_migration(operation TEXT PRIMARY KEY,plan_hash TEXT NOT NULL,before_config TEXT NOT NULL,after_config TEXT NOT NULL,snapshot TEXT NOT NULL,held TEXT NOT NULL)');
  const old=db.prepare('SELECT * FROM peer_file_migration WHERE operation=?').get(operation);
  if(old){if(old.plan_hash!==planHash||old.before_config!==before||old.after_config!==after||old.snapshot!==json(snapshot)||owner(db)!==after)fail('MIGRATION_RECEIPT_REVIEW');result=JSON.parse(old.held);}
  else{
   const actual=migrationSnapshot(db,previous);if(json(actual)!==json(snapshot))fail('MIGRATION_CHANGED');
   captureHolds(db,operation);
   db.prepare("UPDATE peer_file_out SET state='needs_review',error='PEER_FILE_SCOPE_CHANGED' WHERE state IN ('preparing','queued','broker_saved')").run();
   db.prepare("UPDATE peer_file_in SET state='needs_review',error='PEER_FILE_SCOPE_CHANGED' WHERE state IN ('receiving','publishing')").run();
   db.prepare("UPDATE peer_file_broker SET state='needs_review' WHERE state IN ('receiving','available')").run();
   if(db.prepare('UPDATE peer_file_owner SET config=? WHERE id=1 AND config=?').run(after,before).changes!==1)fail('MIGRATION_OWNER_REVIEW');
   result=actual.held;db.prepare('INSERT INTO peer_file_migration VALUES(?,?,?,?,?,?)').run(operation,planHash,before,after,json(snapshot),json(result));
  }
  db.exec('COMMIT');return result;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
