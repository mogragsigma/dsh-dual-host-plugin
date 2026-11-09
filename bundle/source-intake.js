// R1: durable facts only. No model, task, approval, transport or polling capability.
import {createHash} from 'node:crypto';
import {lstatSync} from 'node:fs';
import {join} from 'node:path';
import {tx} from './recovery.js';
export const SOURCE_INTAKE_LIMITS=Object.freeze({events:64,textBytes:65536,batchBytes:1048576,page:100,records:100000});
const owners=new WeakSet();
const fail=code=>{throw Error('SOURCE_INTAKE_'+code);};
const plain=x=>x!==null&&typeof x==='object'&&Object.getPrototypeOf(x)===Object.prototype;
const keys=(x,allowed,required=allowed)=>plain(x)&&Object.keys(x).every(k=>allowed.includes(k))&&required.every(k=>Object.hasOwn(x,k));
const text=(x,n)=>typeof x==='string'&&x.length<=n&&Buffer.byteLength(x)<=n&&!x.includes('\0');
const id=x=>text(x,256)&&x.length>0;
const sourceId=x=>id(x)&&/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(x);
const cursor=x=>x===null||text(x,2048)&&x.length>0;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function errorCode(e){
 if(/^SOURCE_INTAKE_[A-Z_]+$/.test(e?.message))return e.message;
 if(e?.message==='PROTOCOL_MAINTENANCE_ACTIVE')return 'SOURCE_INTAKE_MAINTENANCE';
 const code=(e?.errcode??0)&255;
 return 'SOURCE_INTAKE_'+({5:'BUSY',6:'BUSY',8:'READ_ONLY',10:'IO',11:'CORRUPT',13:'FULL',14:'IO',26:'CORRUPT'}[code]??'STORAGE_UNAVAILABLE');
}
// The owner still opens/closes its existing DB. Never open a second source DB.
export function assertSourceDatabasePath(stateDir){
 for(const [path,directory] of [[stateDir,true],...['gateway.sqlite','gateway.sqlite-wal','gateway.sqlite-shm'].map(f=>[join(stateDir,f),false])]){
  let s;try{s=lstatSync(path);}catch(e){if(e.code==='ENOENT')continue;fail('UNSAFE_PATH');}
  if(s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile()||s.nlink!==1))fail('UNSAFE_PATH');
 }
}
export class SourceIntake {
 #db;#resolve;#enabled;#run;#now;#closed=false;#errors=new Map();#limit;
 constructor(db,{resolveSource=()=>null,enabled=()=>false,run=(_label,fn)=>fn(),now=Date.now,limits={}}={}){
  if(owners.has(db))fail('DUPLICATE_OWNER');
  if(typeof resolveSource!=='function'||typeof enabled!=='function'||typeof run!=='function'||typeof now!=='function')fail('CONFIG');
  this.#limit={...SOURCE_INTAKE_LIMITS,...limits};
  for(const [k,v] of Object.entries(this.#limit))if(!Number.isSafeInteger(v)||v<1||v>SOURCE_INTAKE_LIMITS[k]||!(k in SOURCE_INTAKE_LIMITS))fail('CONFIG');
  this.#db=db;this.#resolve=resolveSource;this.#enabled=enabled;this.#run=run;this.#now=now;owners.add(db);
 }
 #open(){if(this.#closed)fail('CLOSED');}
 #config(s,a,receiving=false){
  this.#open();if(receiving&&this.#enabled()!==true)fail('DISABLED');
  const c=this.#resolve(s);
  if(!c||c.id!==s||c.adapterId!==a||!sourceId(c.namespace))fail('SOURCE_UNBOUND');
  if(!id(c.revision)||!Array.isArray(c.scopes)||!c.scopes.length||c.scopes.length>128||!c.scopes.every(id)||typeof c.enabled!=='boolean')fail('CONFIG');
  if(receiving&&!c.enabled)fail('DISABLED');
  return {id:s,adapterId:a,namespace:c.namespace,revision:c.revision,scopes:[...new Set(c.scopes)].sort(),enabled:c.enabled};
 }
 #hasSchema(){return !!this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_intake_state'").get();}
 #schema(create=false){
  if(!this.#hasSchema()){
   if(!create)return false;
   this.#db.exec(`CREATE TABLE source_intake_state(source_id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL,
    namespace TEXT,adapter_id TEXT,config_revision TEXT,cursor TEXT,last_success INTEGER,last_failure INTEGER,last_error TEXT);
    CREATE TABLE source_intake_events(seq INTEGER PRIMARY KEY,source_id TEXT NOT NULL,event_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,disposition TEXT NOT NULL,payload TEXT,received_at INTEGER NOT NULL,
    UNIQUE(source_id,event_id));
    CREATE INDEX source_intake_page ON source_intake_events(source_id,seq);
    INSERT INTO source_intake_state(source_id,schema_version) VALUES('@schema',1);`);
  }
  const versions=this.#db.prepare('SELECT DISTINCT schema_version FROM source_intake_state').all();
  if(versions.length!==1||versions[0].schema_version!==1||!this.#db.prepare("SELECT 1 FROM source_intake_state WHERE source_id='@schema'").get())fail('SCHEMA_UNSUPPORTED');
  return true;
 }
 #state(c){
  const row=this.#db.prepare('SELECT * FROM source_intake_state WHERE source_id=?').get(c.id);
  if(row&&(row.namespace!==c.namespace||row.adapter_id!==c.adapterId))fail('SOURCE_IDENTITY_CHANGED');
  return row;
 }
 // Only trusted assembly binds adapters. Neither this object nor bind is a model tool/RPC.
 bind(s,a){
  if(!sourceId(s)||!sourceId(a))fail('SOURCE_UNBOUND');
  this.#config(s,a);
  return Object.freeze({receiveBatch:b=>this.#receive(s,a,b),read:o=>this.#read(s,a,o),status:()=>this.#status(s,a)});
 }
 #event(e,c){
  if(!keys(e,['id','scope','occurredAt','actor','thread','text','url'],['id','scope','occurredAt','actor','thread','text'])||
   !id(e.id)||!id(e.scope)||!Number.isSafeInteger(e.occurredAt)||e.occurredAt<0||
   !keys(e.actor,['id','kind'])||!id(e.actor.id)||!['human','bot','unknown'].includes(e.actor.kind)||
   !keys(e.thread,['id'])||!id(e.thread.id)||!text(e.text,this.#limit.textBytes))fail('INVALID_EVENT');
  const url=e.url??null;
  if(url!==null){if(!text(url,2048))fail('INVALID_EVENT');let u;try{u=new URL(url);}catch{fail('INVALID_EVENT');}if(!['http:','https:'].includes(u.protocol)||u.username||u.password)fail('INVALID_EVENT');}
  const accepted=c.scopes.includes(e.scope);
  const normalized={id:e.id,scope:e.scope,occurredAt:e.occurredAt,actor:{id:e.actor.id,kind:e.actor.kind},thread:{id:e.thread.id},text:e.text,url};
  // Hash is independent of the current filter: changing scope cannot conflict with an unchanged event.
  // Filtered rows retain identity/hash/disposition/time, never text or actor/thread references.
  return {id:e.id,payload:accepted?JSON.stringify(normalized):null,fingerprint:digest(normalized),disposition:accepted?'stored':'filtered'};
 }
 #receive(s,a,b){
  let bound=false;
  try{
   const initial=this.#config(s,a,true);bound=true;
   if(!keys(b,['expectedCursor','nextCursor','configRevision','events'])||!cursor(b.expectedCursor)||!cursor(b.nextCursor)||b.nextCursor===null||
    b.expectedCursor===b.nextCursor||!id(b.configRevision)||!Array.isArray(b.events)||b.events.length>this.#limit.events)fail('INVALID_BATCH');
   if(initial.revision!==b.configRevision)fail('CONFIG_CHANGED');
   let bytes=0;const events=b.events.map(e=>{const v=this.#event(e,initial);bytes+=Buffer.byteLength(e.text);if(bytes>this.#limit.batchBytes)fail('BATCH_LIMIT');return v;});
   const result=this.#run('source_intake',()=>tx(this.#db,()=>{
    const c=this.#config(s,a,true);if(JSON.stringify(c)!==JSON.stringify(initial))fail('CONFIG_CHANGED');
    this.#schema(true);const state=this.#state(c);
    if((state?.cursor??null)!==b.expectedCursor)fail('CURSOR_CONFLICT');
    let stored=0,filtered=0,duplicates=0;
    let total=this.#db.prepare('SELECT count(*) n FROM source_intake_events').get().n;
    const at=this.#now();if(!Number.isSafeInteger(at)||at<0)fail('CONFIG');
    for(const e of events){
     const old=this.#db.prepare('SELECT fingerprint FROM source_intake_events WHERE source_id=? AND event_id=?').get(s,e.id);
     if(old){if(old.fingerprint!==e.fingerprint)fail('EVENT_CONFLICT');duplicates++;continue;}
     if(total>=this.#limit.records)fail('CAPACITY');
     this.#db.prepare('INSERT INTO source_intake_events(source_id,event_id,fingerprint,disposition,payload,received_at) VALUES(?,?,?,?,?,?)').run(s,e.id,e.fingerprint,e.disposition,e.payload,at);
     total++;if(e.disposition==='stored')stored++;else filtered++;
    }
    this.#db.prepare(`INSERT INTO source_intake_state(source_id,schema_version,namespace,adapter_id,config_revision,cursor,last_success)
     VALUES(?,1,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET config_revision=excluded.config_revision,cursor=excluded.cursor,last_success=excluded.last_success,last_error=NULL`).run(s,c.namespace,c.adapterId,c.revision,b.nextCursor,at);
    return {sourceId:s,cursor:b.nextCursor,stored,filtered,duplicates,committed:true,executionAuthorized:false};
   }));
   this.#errors.delete(s);return result; // ACK may only follow this COMMIT-complete return.
  }catch(e){
   const code=errorCode(e);
   if(bound){this.#errors.set(s,code);try{if(code!=='SOURCE_INTAKE_MAINTENANCE'&&this.#hasSchema())this.#db.prepare('UPDATE source_intake_state SET last_failure=?,last_error=? WHERE source_id=? AND schema_version=1').run(this.#now(),code,s);}catch{}}
   throw Error(code);
  }
 }
 #read(s,a,{after=0,limit=50}={}){
  try{
   const c=this.#config(s,a);if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>this.#limit.page)fail('PAGE_LIMIT');
   if(!this.#schema())return {events:[],after};this.#state(c);
   const rows=this.#db.prepare('SELECT seq,event_id,disposition,payload,received_at FROM source_intake_events WHERE source_id=? AND seq>? ORDER BY seq LIMIT ?').all(s,after,limit);
   return {events:rows.map(r=>({seq:r.seq,sourceId:s,namespace:c.namespace,id:r.event_id,disposition:r.disposition,event:r.payload===null?null:JSON.parse(r.payload),receivedAt:r.received_at})),after:rows.at(-1)?.seq??after};
  }catch(e){throw Error(errorCode(e));}
 }
 #status(s,a){
  try{
   const c=this.#config(s,a),exists=this.#schema(),r=exists?this.#state(c):null;
   const counts=exists?this.#db.prepare("SELECT count(*) records,sum(disposition='stored') stored,sum(disposition='filtered') filtered FROM source_intake_events WHERE source_id=?").get(s):{};
   return {sourceId:s,enabled:this.#enabled()===true&&c.enabled,schemaVersion:exists?1:null,cursor:r?.cursor??null,configRevision:r?.config_revision??null,
    records:counts.records??0,stored:counts.stored??0,filtered:counts.filtered??0,lastSuccess:r?.last_success??null,lastFailure:r?.last_failure??null,lastError:this.#errors.get(s)??r?.last_error??null,executionAuthorized:false};
  }catch(e){throw Error(errorCode(e));}
 }
 close(){if(this.#closed)return;this.#closed=true;this.#errors.clear();owners.delete(this.#db);}
}
