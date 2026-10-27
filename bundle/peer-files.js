import fs from 'node:fs';
import {join} from 'node:path';
import {FileRoot,fileHash,fileName,sourceFile} from './peer-file-fs.js';
export const FILE_CHUNK=48*1024,FILE_MAX=2*1024*1024;
const other=r=>r==='local'?'cloud':'local',jid=x=>typeof x==='string'&&/^file-[a-f0-9]{64}$/.test(x),task=x=>typeof x==='string'&&/^task-[a-f0-9-]{36}$/.test(x);
const json=JSON.stringify,fail=c=>{throw Error('PEER_FILE_'+c);};
const same=(a,b)=>json(a)===json(b);
export function fileMetadata(a,namespace,origin,max){
 const keys=['v','namespace','id','task_id','from','to','name','size','sha256','created_at'];
 if(!a||typeof a!=='object'||Object.keys(a).some(k=>!keys.includes(k))||a.v!==1||a.namespace!==namespace||!jid(a.id)||!task(a.task_id)||a.from!==origin||a.to!==other(origin)||!Number.isSafeInteger(a.size)||a.size<0||a.size>max||!(/^[a-f0-9]{64}$/.test(a.sha256??''))||!Number.isSafeInteger(a.created_at)||a.created_at<0)fail('METADATA_INVALID');
 fileName(a.name);return Object.fromEntries(keys.map(k=>[k,a[k]]));
}
const metadata=fileMetadata;
function decode(s){if(typeof s!=='string'||s.length>FILE_CHUNK*4/3||!s.length)fail('CHUNK_INVALID');const b=Buffer.from(s,'base64');if(b.toString('base64')!==s||b.length>FILE_CHUNK)fail('CHUNK_INVALID');return b;}
export class PeerFiles {
 constructor(g,c){
  if(!c||c.enabled!==true||Object.keys(c).some(k=>!['enabled','sendRoots','receiveRoot','maxBytes'].includes(k))||!Array.isArray(c.sendRoots)||!c.sendRoots.length||c.sendRoots.length>8)fail('CONFIG_INVALID');
  this.g=g;this.db=g.db;this.role=g.c.role;this.namespace=g.c.namespace;this.max=c.maxBytes??FILE_MAX;
  if(!['local','cloud'].includes(this.role)||typeof this.namespace!=='string'||!this.namespace||this.namespace.length>128)fail('CONFIG_INVALID');
  if(!Number.isSafeInteger(this.max)||this.max<1||this.max>FILE_MAX)fail('CONFIG_INVALID');
  this.roots=c.sendRoots.map(p=>new FileRoot(p));this.receive=new FileRoot(c.receiveRoot);
  const dir=join(g.c.stateDir,'peer-files');fs.mkdirSync(dir,{recursive:true,mode:0o700});this.spool=new FileRoot(dir);
  this.db.exec(`CREATE TABLE IF NOT EXISTS peer_file_owner(id INTEGER PRIMARY KEY,config TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS peer_file_out(id TEXT PRIMARY KEY,meta TEXT NOT NULL,source TEXT NOT NULL,state TEXT NOT NULL,error TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS peer_file_in(id TEXT PRIMARY KEY,meta TEXT NOT NULL,state TEXT NOT NULL,path TEXT,error TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS peer_file_broker(id TEXT NOT NULL,origin TEXT NOT NULL,meta TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(id,origin));`);
  const cfg=json({role:this.role,namespace:this.namespace,max:this.max,send:this.roots.map(r=>[r.path,r.id]),receive:[this.receive.path,this.receive.id]});
  this.db.prepare('INSERT OR IGNORE INTO peer_file_owner VALUES(1,?)').run(cfg);if(this.db.prepare('SELECT config FROM peer_file_owner WHERE id=1').get().config!==cfg)fail('CONFIG_CHANGED');
  for(const row of this.db.prepare("SELECT * FROM peer_file_out WHERE state='preparing'").all()){
   try{this.blob('send',JSON.parse(row.meta));this.setOut(row.id,'queued');}catch{this.setOut(row.id,'needs_review','PEER_FILE_SNAPSHOT_UNCERTAIN');}
  }
 }
 setOut(id,state,error=null){this.db.prepare('UPDATE peer_file_out SET state=?,error=? WHERE id=?').run(state,error,id);}
 blob(kind,m){const b=this.spool.read([kind,m.from,m.id+'.blob'],this.max);if(b.length!==m.size||fileHash(b)!==m.sha256)fail('HASH_MISMATCH');return b;}
 enqueue({id,task_id,file}){
  this.g.maintenance?.assertOpen();
  if(!jid(id)||!task(task_id))fail('REQUEST_INVALID');const old=this.db.prepare('SELECT * FROM peer_file_out WHERE id=?').get(id);
  if(old){if(old.source!==file||JSON.parse(old.meta).task_id!==task_id)fail('ID_CONFLICT');return this.receipt(old);}
  if(this.db.prepare('SELECT count(*) n FROM peer_file_out').get().n>=64)fail('QUEUE_FULL');
  const source=sourceFile(this.roots,file,this.max),m=metadata({v:1,namespace:this.namespace,id,task_id,from:this.role,to:other(this.role),name:source.name,size:source.bytes.length,sha256:fileHash(source.bytes),created_at:this.g.now()},this.namespace,this.role,this.max);
  this.db.prepare("INSERT INTO peer_file_out(id,meta,source,state) VALUES(?,?,?,'preparing')").run(id,json(m),file);
  try{this.spool.publish(['send',m.from,m.id+'.blob'],source.bytes,m.sha256);this.setOut(id,'queued');}catch(e){this.setOut(id,'needs_review',this.code(e));throw e;}
  return this.receipt(this.db.prepare('SELECT * FROM peer_file_out WHERE id=?').get(id));
 }
 receipt(row){const m=JSON.parse(row.meta);return {transfer_id:m.id,task_id:m.task_id,from:m.from,to:m.to,name:m.name,size:m.size,sha256:m.sha256,state:row.state,error:row.error??null,grants_execution:false,meaning:'received means peer durable file receipt, not model read or execution'};}
 brokerRow(node,id,receiver=false){if(!jid(id)||!['local','cloud'].includes(node))fail('REQUEST_INVALID');const r=this.db.prepare('SELECT * FROM peer_file_broker WHERE id=? AND origin=?').get(id,receiver?other(node):node);if(!r)fail('NOT_FOUND');return {...r,m:JSON.parse(r.meta)};}
 offset(m){const n=this.spool.size(['broker',m.from,m.id+'.part']);if(n>m.size||n!==m.size&&n%FILE_CHUNK)fail('OFFSET_CONFLICT');return n;}
 call(method,a,node){
  this.g.maintenance?.assertOpen();
  if(this.role!=='cloud')fail('BROKER_REQUIRED');
  if(!['local','cloud'].includes(node)||!a||typeof a!=='object')fail('REQUEST_INVALID');
  if(method==='peer_file_offer'){
   const m=metadata(a,this.namespace,node,this.max);this.g.store.task(m.task_id);
   const old=this.db.prepare('SELECT * FROM peer_file_broker WHERE id=? AND origin=?').get(m.id,node);
   if(old&&!same(JSON.parse(old.meta),m))fail('ID_CONFLICT');
   if(!old&&this.db.prepare('SELECT count(*) n FROM peer_file_broker').get().n>=64)fail('QUEUE_FULL');
   this.db.prepare("INSERT OR IGNORE INTO peer_file_broker VALUES(?,?,?,'receiving')").run(m.id,node,json(m));
   return {meta:m,state:old?.state??'receiving',offset:old&&old.state!=='receiving'?m.size:this.offset(m)};
  }
  if(method==='peer_file_pull')return {files:this.db.prepare("SELECT meta FROM peer_file_broker WHERE origin=? AND state='available' ORDER BY rowid LIMIT 64").all(other(node)).map(r=>JSON.parse(r.meta))};
  const receiver=['peer_file_read','peer_file_ack'].includes(method),r=this.brokerRow(node,a.id,receiver),m=r.m;
  if(method==='peer_file_status')return {meta:m,state:r.state};
  if(method==='peer_file_chunk'){
   if(r.state!=='receiving')return {offset:m.size,state:r.state};
   const b=decode(a.base64);if(!Number.isSafeInteger(a.offset)||a.offset<0||a.offset%FILE_CHUNK||b.length!==Math.min(FILE_CHUNK,m.size-a.offset))fail('CHUNK_INVALID');
   return {offset:this.spool.append(['broker',m.from,m.id+'.part'],a.offset,b,m.size),state:r.state};
  }
  if(method==='peer_file_commit'){
   if(r.state!=='receiving')return {state:r.state};
   const b=m.size?this.spool.read(['broker',m.from,m.id+'.part'],this.max):Buffer.alloc(0);
   if(b.length!==m.size||fileHash(b)!==m.sha256)fail('HASH_MISMATCH');
   this.spool.publish(['broker',m.from,m.id+'.blob'],b,m.sha256,{recover:true});this.db.prepare("UPDATE peer_file_broker SET state='available' WHERE id=? AND origin=?").run(m.id,node);return {state:'available'};
  }
  if(method==='peer_file_read'){
   if(!['available','received'].includes(r.state)||!Number.isSafeInteger(a.offset)||a.offset<0||a.offset>=m.size||a.offset%FILE_CHUNK)fail('READ_INVALID');
   return {id:m.id,offset:a.offset,base64:this.blob('broker',m).subarray(a.offset,a.offset+FILE_CHUNK).toString('base64')};
  }
  if(method==='peer_file_ack'){
   if(!['available','received'].includes(r.state)||a.sha256!==m.sha256||a.size!==m.size)fail('ACK_INVALID');
   this.db.prepare("UPDATE peer_file_broker SET state='received' WHERE id=? AND origin=?").run(m.id,m.from);return {state:'received'};
  }
  fail('METHOD_DENIED');
 }
 code(e){if(e.message==='PROTOCOL_MAINTENANCE_ACTIVE')return 'PEER_FILE_MAINTENANCE_WAIT';return /^PEER_FILE_[A-Z_]+$/.test(e.message)?e.message:['ENOENT','ENOTDIR'].includes(e.code)?'PEER_FILE_MISSING':['EACCES','EPERM'].includes(e.code)?'PEER_FILE_PERMISSION_DENIED':'PEER_FILE_UNAVAILABLE';}
 async upload(row){
  const m=JSON.parse(row.meta),call=(op,a)=>this.g.call('peer_file_'+op,a),o=await call('offer',m);
  // A peer's retained queue is not permission to reopen it. Wait without burning
  // our retry budget; its own operator must approve that side independently.
  if(same(o.meta,m)&&o.state==='needs_review')fail('PEER_REVIEW_REQUIRED');
  if(!same(o.meta,m)||!Number.isSafeInteger(o.offset)||o.offset<0||o.offset>m.size||o.offset!==m.size&&o.offset%FILE_CHUNK||!['receiving','available','received'].includes(o.state))fail('RECEIPT_INVALID');
  if(o.state==='received'){this.setOut(m.id,'received');return;}
  if(o.state==='available'){this.setOut(m.id,'broker_saved');return;}
  const b=this.blob('send',m);let offset=o.offset;
  for(let i=0;i<4&&offset<m.size;i++){
   const part=b.subarray(offset,offset+FILE_CHUNK),r=await call('chunk',{id:m.id,offset,base64:part.toString('base64')});
   if(r.offset!==offset+part.length)fail('RECEIPT_INVALID');offset=r.offset;
  }
  if(offset===m.size){const r=await call('commit',{id:m.id});if(!['available','received'].includes(r.state))fail('RECEIPT_INVALID');this.setOut(m.id,r.state==='received'?'received':'broker_saved');}
 }
 async download(value){
  const m=metadata(value,this.namespace,other(this.role),this.max),old=this.db.prepare('SELECT * FROM peer_file_in WHERE id=?').get(m.id);
  if(old&&!same(JSON.parse(old.meta),m))fail('ID_CONFLICT');if(old?.state==='needs_review'||old?.next_at>this.g.now())return;
  if(!old&&this.db.prepare('SELECT count(*) n FROM peer_file_in').get().n>=64)fail('QUEUE_FULL');
  this.db.prepare("INSERT OR IGNORE INTO peer_file_in(id,meta,state) VALUES(?,?,'receiving')").run(m.id,json(m));
  const call=(op,a)=>this.g.call('peer_file_'+op,a);
  if(old?.state==='received'){await call('ack',{id:m.id,sha256:m.sha256,size:m.size});return;}
  try{
   const parts=['receive',m.from,m.id+'.part'];let offset=this.spool.size(parts);if(offset>m.size||offset!==m.size&&offset%FILE_CHUNK)fail('OFFSET_CONFLICT');
   for(let i=0;i<4&&offset<m.size;i++){
    const r=await call('read',{id:m.id,offset}),b=decode(r.base64);if(r.id!==m.id||r.offset!==offset||b.length!==Math.min(FILE_CHUNK,m.size-offset))fail('CHUNK_INVALID');
    offset=this.spool.append(parts,offset,b,m.size);
   }
   if(offset!==m.size)return;
   const b=m.size?this.spool.read(parts,this.max):Buffer.alloc(0);if(fileHash(b)!==m.sha256)fail('HASH_MISMATCH');
   // Refuse collisions before persisting the publishing intent. Recovery may only
   // accept exactly matching bytes after a previously persisted intent.
   const dest=[m.task_id,m.id,m.name];if(!old||old.state!=='publishing'){
    if(fs.existsSync(this.receive.at(dest,true)))fail('DESTINATION_EXISTS');
    this.db.prepare("UPDATE peer_file_in SET state='publishing' WHERE id=?").run(m.id);
   }
   const path=this.receive.publish(dest,b,m.sha256,{recover:old?.state==='publishing'});
   this.db.prepare("UPDATE peer_file_in SET state='received',path=?,error=NULL WHERE id=?").run(path,m.id);
   await call('ack',{id:m.id,sha256:m.sha256,size:m.size});
  }catch(e){const code=this.code(e);if(code==='PEER_FILE_MAINTENANCE_WAIT'){this.db.prepare('UPDATE peer_file_in SET error=?,next_at=? WHERE id=?').run(code,this.g.now()+30000,m.id);throw e;}const attempts=(old?.attempts??0)+1,permanent=code!=='PEER_FILE_UNAVAILABLE'||attempts>=16;
   this.db.prepare("UPDATE peer_file_in SET state=CASE WHEN state='received' THEN state WHEN ? THEN 'needs_review' ELSE state END,error=?,attempts=?,next_at=? WHERE id=?").run(+permanent,code,attempts,this.g.now()+Math.min(300000,1000*2**Math.min(attempts,10)),m.id);throw e;}
 }
 async sync(){
  if(this.g.maintenance?.blocked)return;
  if(this.pending)return this.pending;
  this.pending=this.syncOnce().finally(()=>{this.pending=null;});return this.pending;
 }
 async syncOnce(){
  this.lastError=null;
  for(const r of this.db.prepare("SELECT * FROM peer_file_out WHERE state IN ('queued','broker_saved') AND next_at<=? ORDER BY next_at,rowid LIMIT 4").all(this.g.now())){
   if(this.g.closed)return;
   try{await this.upload(r);this.db.prepare('UPDATE peer_file_out SET error=NULL,next_at=? WHERE id=?').run(this.g.now()+1000,r.id);}
   catch(e){const code=this.code(e);if(['PEER_FILE_PEER_REVIEW_REQUIRED','PEER_FILE_MAINTENANCE_WAIT'].includes(code)){this.db.prepare('UPDATE peer_file_out SET error=?,next_at=? WHERE id=?').run(code,this.g.now()+30000,r.id);this.lastError=code;continue;}const n=r.attempts+1,permanent=code!=='PEER_FILE_UNAVAILABLE'||n>=16;
    this.db.prepare('UPDATE peer_file_out SET state=?,error=?,attempts=?,next_at=? WHERE id=?').run(permanent?'needs_review':r.state,code,n,this.g.now()+Math.min(300000,1000*2**Math.min(n,10)),r.id);this.lastError=code;}
  }
  const batch=await this.g.call('peer_file_pull',{});if(!Array.isArray(batch.files)||batch.files.length>64)fail('BATCH_INVALID');
  let processed=0;for(const m of batch.files){if(this.g.closed)return;const row=this.db.prepare('SELECT state,next_at FROM peer_file_in WHERE id=?').get(m.id);if(row?.state==='needs_review'||row?.next_at>this.g.now())continue;if(processed++>=4)break;try{await this.download(m);}catch(e){this.lastError=this.code(e);}}
 }
 scope(){
  for(const root of [...this.roots,this.receive])root.check();
  return {contract:1,host:this.role,scope:'current_host_only',send_roots:this.roots.map(r=>r.path),receive_root:this.receive.path,max_bytes:this.max,checked_at:this.g.now(),observation_only:true,peer_receipt_verified:false,grants_execution:false,repository_write_authorized:false};
 }
 list(task_id){
  if(!task(task_id))fail('REQUEST_INVALID');
  const out=this.db.prepare('SELECT * FROM peer_file_out').all().filter(r=>JSON.parse(r.meta).task_id===task_id).map(r=>this.receipt(r));
  const incoming=this.db.prepare('SELECT * FROM peer_file_in').all().filter(r=>JSON.parse(r.meta).task_id===task_id).map(r=>{
   const m=JSON.parse(r.meta);let availability='not_received';
   if(r.state==='received'){try{const b=this.receive.read([m.task_id,m.id,m.name],FILE_MAX);availability=b.length===m.size&&fileHash(b)===m.sha256?'available':'changed';}catch{availability='missing_or_unsafe';}}
   return {...this.receipt(r),path:r.path,availability,checked_at:this.g.now()};
  });return {host:this.role,sent:out,received:incoming,grants_execution:false};
 }
 snapshot(){return {enabled:true,max_bytes:this.max,last_error:this.lastError??null,outbox:this.db.prepare('SELECT state,count(*) count FROM peer_file_out GROUP BY state').all(),inbox:this.db.prepare('SELECT state,count(*) count FROM peer_file_in GROUP BY state').all()};}
}
