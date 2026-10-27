// Bounded fixed-destination platform requests. No user decision is accepted here.
// Local credentials never travel to cloud. The cloud still verifies platform objects.
import {randomUUID} from 'node:crypto';
import {canonical,digest} from './approval-ledger.js';
import {chatBinding,FeishuApprovalSource} from './approval-feishu.js';
const exact=(a,ks)=>a&&typeof a==='object'&&!Array.isArray(a)&&Object.keys(a).sort().join()===ks.slice().sort().join();
const id=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{8,128}$/.test(x);
const mid=x=>/^om_[A-Za-z0-9_-]{4,128}$/.test(x??'');
const text=x=>typeof x==='string'&&x.length>0&&Buffer.byteLength(x)<=24000;
const code=e=>/^CHAT_[A-Z0-9_]{1,80}$/.test(e?.message)?e.message:'CHAT_RELAY_PROVIDER_UNAVAILABLE';
export const localApprovalBinding=c=>chatBinding({...c,appSecretEnv:c?.appSecretEnv??'LOCAL_RELAY_NO_SECRET'});
function valid(method,a){
 const fields={verify:[],get:['message_id'],list:['since'],send:['text','uuid'],reply:['message_id','text','uuid']};
 if(!fields[method]||!exact(a,fields[method])||(['get','reply'].includes(method)&&!mid(a.message_id))||(['send','reply'].includes(method)&&(!text(a.text)||!id(a.uuid)))||method==='list'&&(!Number.isSafeInteger(a.since)||a.since<0))throw Error('CHAT_RELAY_ARGUMENTS');
}
function boundedResult(value){if(Buffer.byteLength(canonical(value))>90000)throw Error('CHAT_RELAY_RESULT_TOO_LARGE');return value;}
function project(m,b){
 if(m?.chat_id!==b.chatId)throw Error('CHAT_RELAY_MESSAGE_SCOPE');
 const fields=['message_id','chat_id','chat_type','parent_id','msg_type','deleted','updated','create_time','update_time','sender','body'];
 return Object.fromEntries(fields.filter(k=>m[k]!==undefined).map(k=>[k,m[k]]));
}
export class ApprovalRelayBroker {
 constructor(db,c,{now=Date.now,timeout=15000}={}){this.db=db;this.binding=localApprovalBinding(c);this.hash=digest(this.binding);this.now=now;this.timeout=timeout;this.online=0;this.closed=false;this.waiters=new Map();
  db.exec("CREATE TABLE IF NOT EXISTS approval_local_relay(id TEXT PRIMARY KEY,binding_hash TEXT NOT NULL,method TEXT NOT NULL,args TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,result TEXT,error TEXT)");
  // Restart does not allow a queued/claimed write to execute later or be repeated.
  db.prepare("UPDATE approval_local_relay SET state='needs_review',error='CHAT_RELAY_INTERRUPTED' WHERE state IN ('queued','claimed')").run();
 }
 assertAvailable(){if(this.closed||!this.online||this.now()-this.online>15000)throw Error('CHAT_LOCAL_IM_OFFLINE');}
 snapshot(){return {host_role:'local',transport:'paired_local_platform_relay',online:!this.closed&&!!this.online&&this.now()-this.online<=15000,same_dsh_session_required:false};}
 call(node,method,a){
  if(node!=='local')throw Error('CHAT_RELAY_ROLE_DENIED');
  if(method==='pull'){
   if(this.closed)throw Error('CHAT_RELAY_CLOSED');if(!exact(a,['binding_hash'])||a.binding_hash!==this.hash)throw Error('CHAT_RELAY_BINDING_CHANGED');this.online=this.now();
   this.expire();const rows=this.db.prepare("SELECT * FROM approval_local_relay WHERE binding_hash=? AND state IN ('queued','claimed') AND expires>? ORDER BY rowid LIMIT 4").all(this.hash,this.now());
   for(const r of rows)this.db.prepare("UPDATE approval_local_relay SET state='claimed' WHERE id=? AND state='queued'").run(r.id);
   return {binding_hash:this.hash,items:rows.map(r=>({id:r.id,method:r.method,args:JSON.parse(r.args),expires:r.expires}))};
  }
  if(method==='validate'){if(!exact(a,['binding_hash','id'])||a.binding_hash!==this.hash||!id(a.id))throw Error('CHAT_RELAY_ARGUMENTS');const r=this.db.prepare('SELECT * FROM approval_local_relay WHERE id=? AND binding_hash=?').get(a.id,this.hash);return {allowed:!this.closed&&r?.state==='claimed'&&r.expires>this.now()};}
  if(method!=='ack'||!exact(a,['binding_hash','id','result','error'])||a.binding_hash!==this.hash||!id(a.id)||a.error!==null&&(!/^CHAT_[A-Z0-9_]{1,80}$/.test(a.error)||a.result!==null))throw Error('CHAT_RELAY_ARGUMENTS');
  boundedResult(a.result);const r=this.db.prepare('SELECT * FROM approval_local_relay WHERE id=? AND binding_hash=?').get(a.id,this.hash);if(!r)throw Error('CHAT_RELAY_OPERATION_NOT_FOUND');
  if(r.state==='done'){if(r.result!==canonical(a.result)||r.error!==a.error)throw Error('CHAT_RELAY_ACK_CONFLICT');return {saved:true};}
  if(r.state!=='claimed'||r.expires<=this.now())return {saved:false,needs_review:true};
  this.db.prepare("UPDATE approval_local_relay SET state='done',result=?,error=? WHERE id=?").run(canonical(a.result),a.error,r.id);this.waiters.get(r.id)?.();return {saved:true};
 }
 expire(){this.db.prepare("UPDATE approval_local_relay SET state=CASE WHEN state='queued' THEN 'cancelled' ELSE 'needs_review' END,error='CHAT_RELAY_TIMEOUT' WHERE state IN ('queued','claimed') AND expires<=?").run(this.now());}
 async request(method,args){valid(method,args);this.assertAvailable();if(this.waiters.size>=4)throw Error('CHAT_RELAY_BUSY');const id=randomUUID(),created=this.now();this.db.prepare("INSERT INTO approval_local_relay(id,binding_hash,method,args,state,created,expires) VALUES (?,?,?,?,'queued',?,?)").run(id,this.hash,method,canonical(args),created,created+this.timeout);
  await new Promise(resolve=>{const timer=setTimeout(resolve,this.timeout);this.waiters.set(id,()=>{clearTimeout(timer);resolve();});}).finally(()=>this.waiters.delete(id));this.expire();const r=this.db.prepare('SELECT * FROM approval_local_relay WHERE id=?').get(id);if(r.state!=='done'||r.error)throw Error(r.error??'CHAT_RELAY_RESULT_UNKNOWN');return JSON.parse(r.result);
 }
 source(){return {assertAvailable:()=>this.assertAvailable(),verifyBot:()=>this.request('verify',{}),get:message_id=>this.request('get',{message_id}),list:since=>this.request('list',{since}),send:(text,uuid)=>this.request('send',{text,uuid}),reply:(message_id,text,uuid)=>this.request('reply',{message_id,text,uuid})};}
 close(){if(this.closed)return;this.closed=true;this.db.prepare("UPDATE approval_local_relay SET state='needs_review',error='CHAT_RELAY_CLOSED' WHERE state IN ('queued','claimed')").run();for(const done of this.waiters.values())done();}
}
export class LocalApprovalEndpoint {
 constructor(g,c,io={}){this.g=g;this.db=g.db;this.binding=localApprovalBinding(c);this.hash=digest(this.binding);this.source=io.source??new FeishuApprovalSource(c,io);this.closed=false;this.running=null;this.lastError=null;
  this.db.exec('CREATE TABLE IF NOT EXISTS approval_local_attempts(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,binding_hash TEXT NOT NULL,state TEXT NOT NULL,result TEXT,error TEXT)');
  this.db.prepare("UPDATE approval_local_attempts SET state='done',result='null',error='CHAT_RELAY_SEND_RESULT_UNKNOWN' WHERE state='running'").run();
 }
 async execute(r){valid(r.method,r.args);const fp=digest(r),old=this.db.prepare('SELECT * FROM approval_local_attempts WHERE id=?').get(r.id);
  if(old){if(old.fingerprint!==fp||old.binding_hash!==this.hash)throw Error('CHAT_RELAY_OPERATION_CHANGED');return old;}
  if(!id(r.id)||!Number.isSafeInteger(r.expires)||r.expires<=this.g.now())throw Error('CHAT_RELAY_EXPIRED');
  this.db.prepare("INSERT INTO approval_local_attempts VALUES (?,?,?,'running',NULL,NULL)").run(r.id,fp,this.hash);
  let result=null,error=null;try{
   await this.source.verifyBot();if(this.closed||this.g.closed||r.expires<=this.g.now())throw Error('CHAT_RELAY_EXPIRED');
   const a=r.args;
   if(r.method==='verify')result=true;
   if(r.method==='get')result=project(await this.source.get(a.message_id),this.binding);
   if(r.method==='list'){const rows=await this.source.list(a.since);result=rows.filter(m=>m.chat_id===this.binding.chatId).map(m=>project(m,this.binding));}
   if(r.method==='send'){if((await this.g.call('approval_local_validate',{binding_hash:this.hash,id:r.id})).allowed!==true||this.closed)throw Error('CHAT_RELAY_EXPIRED');result=await this.source.send(a.text,a.uuid);}
   if(r.method==='reply'){project(await this.source.get(a.message_id),this.binding);if((await this.g.call('approval_local_validate',{binding_hash:this.hash,id:r.id})).allowed!==true||this.closed)throw Error('CHAT_RELAY_EXPIRED');result=await this.source.reply(a.message_id,a.text,a.uuid);}
   boundedResult(result);
  }catch(e){result=null;error=code(e);}
  this.db.prepare("UPDATE approval_local_attempts SET state='done',result=?,error=? WHERE id=? AND state='running'").run(canonical(result),error,r.id);return this.db.prepare('SELECT * FROM approval_local_attempts WHERE id=?').get(r.id);
 }
 tick(){if(this.closed||this.g.closed||this.g.maintenance?.blocked)return Promise.resolve();if(this.running)return this.running;this.running=(async()=>{const leave=this.g.maintenance?.enter('local_approval_relay');try{const b=await this.g.call('approval_local_pull',{binding_hash:this.hash});if(b.binding_hash!==this.hash||!Array.isArray(b.items)||b.items.length>4)throw Error('CHAT_RELAY_BINDING_CHANGED');for(const r of b.items){if(this.closed||this.g.closed)break;const value=await this.execute(r);await this.g.call('approval_local_ack',{binding_hash:this.hash,id:r.id,result:JSON.parse(value.result),error:value.error});}this.lastError=null;}catch(e){this.lastError=code(e);}finally{leave?.();}})().finally(()=>this.running=null);return this.running;}
 start(){const loop=async()=>{await this.tick();if(!this.closed)this.timer=setTimeout(loop,200);};this.loop=loop();}
 async close(){this.closed=true;clearTimeout(this.timer);await this.running;}
}

// Static operator opt-in. Add the exact same private chat as an eligible result
// destination; this does not replace existing notification consent/defaults.
export function configureLocalApproval(c,targetFactory){
 if(!c.localApproval)return c;if(c.chatApproval)throw Error('CHAT_MULTIPLE_APPROVAL_ROUTES');
 const cfg={...c.localApproval,appSecretEnv:c.localApproval.appSecretEnv??'LOCAL_RELAY_NO_SECRET'};localApprovalBinding(cfg);
 const alias=cfg.notificationAlias??'local-approval',target=targetFactory(cfg,{host:'local',alias,label:cfg.notificationLabel??'本地 IM 审批与结果'});
 if((c.notificationTargets??[]).some(x=>x.host==='local'&&x.alias===alias)||(c.notificationFeishu??[]).some(x=>x.alias===alias))throw Error('CHAT_RELAY_NOTIFICATION_CONFLICT');
 return {...c,notificationTargets:[...(c.notificationTargets??[]),target],notificationFeishu:[...(c.notificationFeishu??[]),...(c.role==='local'?[{...cfg,alias}]:[])]};
}
