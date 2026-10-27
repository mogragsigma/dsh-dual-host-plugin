// Optional, public same-Host contract only. No IM imports, credentials or storage.
import {bounded,outboxInsert,tx} from './recovery.js';
const retryable=new Set(['account-unverified','capability-unavailable']);
const refused=new Set([...retryable,'account-changed','target-changed','unknown-target','unknown-bot','bad-request']);
function binding(c){
 const {botId,targetId,expectedFingerprint,expectedTargetDigest,conversationId}=c;
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(botId??'')||!/^[A-Za-z0-9._:@-]{1,128}$/.test(targetId??'')||
   !/^[a-f0-9]{64}$/.test(expectedFingerprint??'')||!/^[a-f0-9]{64}$/.test(expectedTargetDigest??'')||
   typeof conversationId!=='string'||!conversationId||conversationId.length>512)throw Error('INVALID_IM_DELIVERY_BINDING');
 return JSON.stringify({botId,targetId,expectedFingerprint,expectedTargetDigest,conversationId});
}
export class ImDelivery {
 constructor(g,c){
  this.g=g;this.route=binding(c);this.lastError=null;this.lastCheckedAt=null;this.available=false;
  g.db.exec('CREATE TABLE IF NOT EXISTS im_receipt_bindings(id TEXT PRIMARY KEY,route TEXT NOT NULL)');
 }
 enqueue(id,text){
  const g=this.g;
  tx(g.db,()=>{
   // Historical receipts do not acquire a new destination implicitly.
   if(g.db.prepare('SELECT id FROM receipts WHERE id=?').get(id))return;
   outboxInsert(g.db,'receipts',id,text,g.now());
   g.db.prepare('INSERT INTO im_receipt_bindings(id,route) VALUES (?,?)').run(id,this.route);
  });
 }
 async sendPending(){
  const g=this.g;
  g.db.prepare("UPDATE receipts SET status='needs_review',last_error='SEND_RESULT_UNKNOWN',lease_until=NULL WHERE status='sending' AND lease_until<=?").run(g.now());
  let service;try{service=g.ctx.get('dshIm');}catch{}
  this.lastCheckedAt=g.now();this.available=false;
  if(service?.contractVersion!==1||service?.receiptVersion!==1||typeof service.sendChecked!=='function'){
   this.lastError='IM_CONTRACT_UNAVAILABLE';return;
  }
  this.lastError=null;this.available=true;
  for(const row of g.db.prepare("SELECT r.*,b.route FROM receipts r LEFT JOIN im_receipt_bindings b ON r.id=b.id WHERE r.status='queued' AND r.next_attempt_at<=? ORDER BY r.rowid LIMIT 10").all(g.now())){
   if(g.closed)return;
   if(row.route!==this.route){g.db.prepare("UPDATE receipts SET status='needs_review',last_error='IM_ROUTE_REVIEW_REQUIRED' WHERE id=?").run(row.id);continue;}
   const pins=JSON.parse(row.route),attempt=row.attempts+1;
   // Durable attempt BEFORE invoking provider. Crash or ambiguous cancellation is not retried.
   g.db.prepare("UPDATE receipts SET status='sending',attempts=?,lease_until=? WHERE id=?").run(attempt,g.now()+g.retry.sendTimeoutMs+1000,row.id);
   const controller=new AbortController();let result;
   try{
    result=await bounded(Promise.resolve().then(()=>service.sendChecked(pins.botId,pins.targetId,row.text,{
     expectedFingerprint:pins.expectedFingerprint,expectedTargetDigest:pins.expectedTargetDigest,
     signal:controller.signal,format:'plain',receipt:true,
    })),g.retry.sendTimeoutMs,'SEND_TIMEOUT');
    if(result?.sent!==true||result.receipt?.version!==1||typeof result.receipt.messageId!=='string'||!result.receipt.messageId||result.receipt.messageId.length>512||result.receipt.conversationId!==pins.conversationId)throw Error('SEND_RESULT_UNKNOWN');
   }catch(e){
    controller.abort();
    const code=refused.has(e?.code)?e.code:'SEND_RESULT_UNKNOWN';
    const status=retryable.has(code)&&attempt<g.retry.maxAttempts?'queued':'needs_review';
    g.db.prepare('UPDATE receipts SET status=?,last_error=?,next_attempt_at=?,lease_until=NULL WHERE id=?').run(status,code,g.now()+g.backoff(attempt),row.id);
    continue;
   }
   // A persistence failure here must remain uncertain, not be caught as safe to retry.
   g.db.prepare("UPDATE receipts SET status='sent',message_id=?,last_error=NULL,lease_until=NULL WHERE id=?").run(result.receipt.messageId,row.id);
  }
 }
 snapshot(){return {contract:1,receipt:1,state:this.lastCheckedAt===null?'unknown':this.available?'available':'unavailable',last_checked_at:this.lastCheckedAt,source:'same-host-public-contract',lastError:this.lastError};}
}
