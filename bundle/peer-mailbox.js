import {retryBarrierErrors} from './link-contract.js';
import {createHash} from 'node:crypto';
const kinds=new Set(['task_notice','context','question','answer','progress','result']);
const other=r=>r==='local'?'cloud':'local';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const validId=x=>typeof x==='string'&&/^[a-zA-Z0-9:_-]{1,160}$/.test(x);
const taskId=x=>typeof x==='string'&&/^task-[0-9a-f-]{36}$/.test(x);
function envelope(x,namespace,from){
 if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!['v','namespace','from','to','id','task_id','kind','text','reply_to','created_at'].includes(k)))throw Error('INVALID_PEER_MESSAGE');
 if(x.v!==1||x.namespace!==namespace||x.from!==from||x.to!==other(from)||!validId(x.id)||!taskId(x.task_id)||!kinds.has(x.kind)||typeof x.text!=='string'||!x.text.trim()||Buffer.byteLength(x.text)>16384||!Number.isSafeInteger(x.created_at)||x.created_at<0||(x.reply_to!==null&&!validId(x.reply_to)))throw Error('INVALID_PEER_MESSAGE');
 return {v:1,namespace,from,to:other(from),id:x.id,task_id:x.task_id,kind:x.kind,text:x.text,reply_to:x.reply_to,created_at:x.created_at};
}
function ids(value){if(!Array.isArray(value)||value.length>20||!value.every(validId))throw Error('INVALID_PEER_IDS');return [...new Set(value)];}

// The cloud broker persists messages, not model execution or user approval.
// Recipient ACK means durable inbox storage; reading and acting are separate operations.
export class PeerMailbox {
 constructor(db,{role,namespace,now=Date.now}){
  if(!['local','cloud'].includes(role)||typeof namespace!=='string'||!namespace||namespace.length>128)throw Error('INVALID_PEER_CONFIG');
  this.db=db;this.role=role;this.namespace=namespace;this.now=now;
  db.exec(`CREATE TABLE IF NOT EXISTS peer_outbox(id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,last_error TEXT);
   CREATE TABLE IF NOT EXISTS peer_broker(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,origin TEXT NOT NULL,destination TEXT NOT NULL,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,received_at INTEGER,UNIQUE(origin,id));
   CREATE TABLE IF NOT EXISTS peer_inbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,origin TEXT NOT NULL,task_id TEXT NOT NULL,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,saved_at INTEGER NOT NULL,UNIQUE(origin,id));
   CREATE TABLE IF NOT EXISTS peer_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),role TEXT NOT NULL,namespace TEXT NOT NULL);`);
  if(!db.prepare('PRAGMA table_info(peer_outbox)').all().some(x=>x.name==='created_at'))db.exec('ALTER TABLE peer_outbox ADD COLUMN created_at INTEGER');
  db.prepare('INSERT OR IGNORE INTO peer_identity VALUES (1,?,?)').run(role,namespace);
  const identity=db.prepare('SELECT role,namespace FROM peer_identity WHERE singleton=1').get();
  if(identity.role!==role||identity.namespace!==namespace)throw Error('PEER_STATE_IDENTITY_MISMATCH');
 }
 enqueue(a){
  const prior=this.db.prepare('SELECT * FROM peer_outbox WHERE id=?').get(a.id);
  const value=envelope({v:1,namespace:this.namespace,from:this.role,to:other(this.role),id:a.id,task_id:a.task_id,kind:a.kind,text:a.text,reply_to:a.reply_to??null,created_at:prior?JSON.parse(prior.payload).created_at:this.now()},this.namespace,this.role);
  const payload=JSON.stringify(value);
  if(prior&&prior.payload!==payload)throw Error('PEER_ID_CONFLICT');
  this.db.prepare("INSERT OR IGNORE INTO peer_outbox(id,payload,status,created_at) VALUES (?,?,'queued',?)").run(value.id,payload,this.now());
  return {message_id:value.id,status:prior?.status??'queued',meaning:'transport only; no execution or approval'};
 }
 accept(node,a,assertTask){
  const value=envelope(a,this.namespace,node);assertTask(value.task_id);const fp=digest(value);
  const row=this.db.prepare('SELECT * FROM peer_broker WHERE origin=? AND id=?').get(node,value.id);
  if(row&&row.fingerprint!==fp)throw Error('PEER_ID_CONFLICT');
  this.db.prepare('INSERT OR IGNORE INTO peer_broker(id,origin,destination,fingerprint,payload) VALUES (?,?,?,?,?)').run(value.id,node,value.to,fp,JSON.stringify(value));
  return {message_id:value.id,status:row?.received_at!=null?'peer_saved':'broker_saved'};
 }
 pull(node){return {messages:this.db.prepare('SELECT payload FROM peer_broker WHERE destination=? AND received_at IS NULL ORDER BY seq LIMIT 20').all(node).map(r=>JSON.parse(r.payload))};}
 acknowledge(node,a){
  for(const id of ids(a.ids))this.db.prepare('UPDATE peer_broker SET received_at=COALESCE(received_at,?) WHERE origin=? AND destination=? AND id=?').run(this.now(),other(node),node,id);
  return {acknowledged:true};
 }
 status(node,a){return {messages:ids(a.ids).map(id=>{const r=this.db.prepare('SELECT received_at FROM peer_broker WHERE origin=? AND id=?').get(node,id);return {id,status:!r?'unknown':r.received_at==null?'broker_saved':'peer_saved'};})};}
 save(a){
  const value=envelope(a,this.namespace,other(this.role)),fp=digest(value);
  const old=this.db.prepare('SELECT fingerprint FROM peer_inbox WHERE origin=? AND id=?').get(value.from,value.id);
  if(old&&old.fingerprint!==fp)throw Error('PEER_ID_CONFLICT');
  this.db.prepare('INSERT OR IGNORE INTO peer_inbox(id,origin,task_id,fingerprint,payload,saved_at) VALUES (?,?,?,?,?,?)').run(value.id,value.from,value.task_id,fp,JSON.stringify(value),this.now());
  return value.id;
 }
 read(task,after=0){
  if(!taskId(task)||!Number.isSafeInteger(after)||after<0)throw Error('INVALID_PEER_QUERY');
  const rows=this.db.prepare('SELECT seq,payload,saved_at FROM peer_inbox WHERE task_id=? AND seq>? ORDER BY seq LIMIT 20').all(task,after);
  return {messages:rows.map(r=>({...JSON.parse(r.payload),cursor:r.seq,saved_at:r.saved_at})),next_cursor:rows.at(-1)?.seq??after,advisory_only:true};
 }
 snapshot(){return {version:1,outbox:this.db.prepare('SELECT status,count(*) AS count FROM peer_outbox GROUP BY status').all(),inbox:this.db.prepare('SELECT count(*) AS count FROM peer_inbox').get().count};}
 async sync(call){
  for(const row of this.db.prepare("SELECT * FROM peer_outbox WHERE status='queued' AND next_at<=? ORDER BY rowid LIMIT 20").all(this.now())){
   try{const result=await call('peer_send',JSON.parse(row.payload));if(result.message_id!==row.id||!['broker_saved','peer_saved'].includes(result.status))throw Error('UNCONFIRMED_PEER_RECEIPT');this.db.prepare('UPDATE peer_outbox SET status=?,last_error=NULL WHERE id=?').run(result.status,row.id);}
   catch(e){if(retryBarrierErrors.has(e.message)){this.db.prepare("UPDATE peer_outbox SET next_at=?,last_error=? WHERE status='queued'").run(this.now()+30000,e.message);throw e;}const code=['INVALID_PEER_MESSAGE','PEER_ID_CONFLICT','TASK_NOT_FOUND','AUTH_DENIED'].includes(e.message)?e.message:'PEER_UNAVAILABLE';const n=row.attempts+1;this.db.prepare('UPDATE peer_outbox SET status=?,attempts=?,next_at=?,last_error=? WHERE id=?').run(code==='PEER_UNAVAILABLE'?'queued':'needs_review',n,this.now()+Math.min(300000,1000*2**Math.min(n,10)),code,row.id);if(code==='PEER_UNAVAILABLE')throw Error(code);}
  }
  // A failed pull/ACK cannot undo the durable insert; next poll deduplicates the replay.
  const batch=await call('peer_pull',{});if(!Array.isArray(batch.messages)||batch.messages.length>20)throw Error('INVALID_PEER_BATCH');
  for(const message of batch.messages){const id=this.save(message);await call('peer_ack',{ids:[id]});}
  const pending=this.db.prepare("SELECT id FROM peer_outbox WHERE status='broker_saved' LIMIT 20").all().map(r=>r.id);
  if(pending.length){const r=await call('peer_status',{ids:pending});for(const m of r.messages??[])if(pending.includes(m.id)&&m.status==='peer_saved')this.db.prepare("UPDATE peer_outbox SET status='peer_saved' WHERE id=?").run(m.id);}
 }
}
