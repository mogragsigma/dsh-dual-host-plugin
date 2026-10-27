// Metadata only: never persist prompts, generated text, headers or credentials here.
const json=JSON.stringify;
const kinds=['stop','tool-calls','max-tokens','error','aborted','unknown'];
const stages=['dispatch_intent','stream_ended','stream_failed','stream_interrupted','unknown_after_restart'];
const safe=x=>typeof x==='string'&&/^[A-Z][A-Z_]{1,63}$/.test(x)?x:'STREAM_FAILED';
export function validateModelObservation(r){
 const keys=['dispatch_id','provider','model','reasoningEffort','maxTokens','started_at','ended_at','stage','chunks','finish_kind','error_code','http_status'];
 if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!keys.includes(k))||
  ![r.dispatch_id,r.provider,r.model].every(x=>typeof x==='string'&&!!x&&x.length<=256)||
  !(r.reasoningEffort===null||typeof r.reasoningEffort==='string'&&r.reasoningEffort.length<=64)||r.maxTokens!==2048||
  !Number.isSafeInteger(r.started_at)||!Number.isSafeInteger(r.ended_at)||r.ended_at<r.started_at||!stages.slice(1).includes(r.stage)||
  !Number.isSafeInteger(r.chunks)||r.chunks<0||!(r.finish_kind===null||kinds.includes(r.finish_kind))||
  !(r.error_code===null||safe(r.error_code)===r.error_code)||!(r.http_status===null||Number.isInteger(r.http_status)&&r.http_status>=100&&r.http_status<=599))throw Error('A2A_MODEL_OBSERVATION_INVALID');
 return r;
}
export class A2ADispatches {
 constructor(db,now){this.db=db;this.now=now;db.exec('CREATE TABLE IF NOT EXISTS endpoint_dispatches(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,record TEXT NOT NULL)');}
 list(request){return this.db.prepare('SELECT record FROM endpoint_dispatches WHERE request_id=? ORDER BY rowid').all(request).map(x=>JSON.parse(x.record));}
 save(id,r){this.db.prepare('UPDATE endpoint_dispatches SET record=? WHERE id=?').run(json(r),id);}
 recover(){for(const row of this.db.prepare('SELECT * FROM endpoint_dispatches').all()){const r=JSON.parse(row.record);if(r.stage==='dispatch_intent'){r.stage='unknown_after_restart';r.ended_at=Math.max(this.now(),r.started_at);this.save(row.id,r);}}}
 async *observe(request,id,options,next){
  const r={dispatch_id:id,provider:options.provider,model:options.model,reasoningEffort:options.reasoningEffort??null,maxTokens:options.maxTokens,started_at:this.now(),ended_at:null,stage:'dispatch_intent',chunks:0,finish_kind:null,error_code:null,http_status:null};
  this.db.prepare('INSERT INTO endpoint_dispatches VALUES (?,?,?)').run(id,request,json(r));
  try{
   for await(const chunk of next()){
    r.chunks++;
    if(chunk?.type==='finish'){
     r.finish_kind=kinds.includes(chunk.reason?.kind)?chunk.reason.kind:'unknown';
     if(['error','aborted'].includes(r.finish_kind)){r.error_code=safe(chunk.reason?.failure?.code);const s=chunk.reason?.failure?.status;if(Number.isInteger(s)&&s>=100&&s<=599)r.http_status=s;}
     this.save(id,r); // A crash after a finish but before loop teardown is still not completion.
    }
    yield chunk;
   }
   r.stage='stream_ended';
  }catch(e){r.stage='stream_failed';r.error_code=safe(e?.code);throw e;}
  finally{if(r.stage==='dispatch_intent')r.stage='stream_interrupted';r.ended_at=Math.max(this.now(),r.started_at);this.save(id,r);}
 }
}
