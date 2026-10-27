import {randomUUID} from 'node:crypto';
import {canonical,digest} from './approval-ledger.js';
import {interpretApproval,ruleInterpretation} from './approval-semantics.js';
import {WorkbenchIMIdentity} from './workbench-im-identity.js';
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const base=r=>digest({proposal_hash:r.proposal_hash,state:r.state,decision:r.decision_id});
export class WorkbenchDecisions {
 constructor(ledger,getChat,{hold=()=>()=>{}}={}){this.l=ledger;this.db=ledger.db;this.chat=getChat;this.hold=hold;this.identity=new WorkbenchIMIdentity(ledger,getChat,{hold});this.pending=new Map();this.abort=new AbortController();this.closed=false;
  this.db.exec(`CREATE TABLE IF NOT EXISTS workbench_decision_operations(id TEXT PRIMARY KEY,client_hash TEXT NOT NULL,node TEXT NOT NULL,event_id TEXT NOT NULL,request_id TEXT NOT NULL,task_id TEXT NOT NULL,revision INTEGER NOT NULL,fingerprint TEXT NOT NULL,base TEXT NOT NULL,user_text TEXT NOT NULL,state TEXT NOT NULL,interpretation TEXT,created INTEGER NOT NULL,expires INTEGER NOT NULL,decision_id TEXT,error TEXT,UNIQUE(client_hash,event_id));
   CREATE TABLE IF NOT EXISTS workbench_im_proofs(challenge_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,credential_id TEXT NOT NULL,principal TEXT NOT NULL,action TEXT NOT NULL,proof_hash TEXT NOT NULL,session_id TEXT NOT NULL,binding_hash TEXT NOT NULL,user_text TEXT NOT NULL,interpretation TEXT NOT NULL,proof TEXT NOT NULL);`);
  this.db.prepare("UPDATE workbench_decision_operations SET state='needs_review',error='APPROVAL_INTERPRETATION_INTERRUPTED' WHERE state='processing'").run();
 }
 current(a){const r=this.l.row(a.request_id);if(r.task_id!==a.task_id||r.spec_revision!==a.expected_revision||this.l.catalog.head(r.task_id).spec_revision!==a.expected_revision)throw Error('APPROVAL_WORKBENCH_CHANGED');this.l.assertDecision(r.id,'hold',{workbenchEvaluation:true});return r;}
 row(node,a){const hash=this.identity.key(node,a.client_key);const r=this.db.prepare('SELECT * FROM workbench_decision_operations WHERE client_hash=? AND event_id=?').get(hash,a.event_id);if(!r)throw Error('APPROVAL_OPERATION_NOT_FOUND');return r;}
 status(node,a){const r=this.row(node,a),v=this.l.view(r.request_id);if(r.state==='ready'&&(r.expires<=this.l.now()||base(this.l.row(r.request_id))!==r.base||!['pending','approved','held','clarification_required'].includes(v.state)))r.state='changed';return {schema:1,operation_id:r.id,operation_state:r.state,prepared:r.state==='ready',recorded:r.state==='recorded',uncertain:r.state==='needs_review',state:r.state==='recorded'?v.state:r.state,task_id:r.task_id,request_id:r.request_id,expected_revision:r.revision,user_text:r.user_text,interpretation:r.interpretation?JSON.parse(r.interpretation):null,proposal:v.proposal,identity:this.identity.view(node,a.client_key),decision_id:r.decision_id,execution_granted:false,message:r.state==='recorded'?'决定已由审批账本保存；不代表任务已经执行。':r.state==='needs_review'?'处理结果需核对；只查原操作，不重新提交。':r.state==='changed'?'方案、审批状态或核对有效期已变化。原意见保留；请返回修改，刷新方案后重新核对。':'先核对完整意见与绑定方案，再保存决定。'};}
 async prepare(node,a){
  const hash=this.identity.key(node,a.client_key);if(typeof a.text!=='string'||a.text.length>2000||!a.text.trim()||!Number.isSafeInteger(a.expected_revision)||!a.task_id||!a.request_id||typeof a.task_id!=='string'||a.task_id.length>128||typeof a.request_id!=='string'||a.request_id.length>128)throw Error('APPROVAL_WORKBENCH_ARGUMENTS');
  const fp=digest({task_id:a.task_id,request_id:a.request_id,revision:a.expected_revision,text:a.text}),old=this.db.prepare('SELECT * FROM workbench_decision_operations WHERE client_hash=? AND event_id=?').get(hash,a.event_id);
  if(old){if(old.fingerprint!==fp)throw Error('APPROVAL_EVENT_CONFLICT');return this.status(node,a);}
  if(this.pending.size>=4)throw Error('APPROVAL_INTERPRETATION_BUSY');
  const row=this.current(a),id=randomUUID(),created=this.l.now(),c=this.chat(),leave=this.hold();
  try{
  this.db.prepare("INSERT INTO workbench_decision_operations(id,client_hash,node,event_id,request_id,task_id,revision,fingerprint,base,user_text,state,created,expires) VALUES (?,?,?,?,?,?,?,?,?,?,'processing',?,?)").run(id,hash,node,a.event_id,row.id,row.task_id,row.spec_revision,fp,base(row),a.text,created,Math.min(row.expires,created+600000));
  }catch(e){leave();throw e;}
  const run=(async()=>{try{const i=await interpretApproval(a.text,JSON.parse(row.proposal),c?.classify,this.abort.signal);if(this.closed)return;this.current(a);if(base(this.l.row(row.id))!==base(row))throw Error('APPROVAL_WORKBENCH_CHANGED');this.db.prepare("UPDATE workbench_decision_operations SET state='ready',interpretation=? WHERE id=? AND state='processing'").run(canonical(i),id);}catch(e){this.db.prepare("UPDATE workbench_decision_operations SET state='needs_review',error=? WHERE id=? AND state='processing'").run(e.message==='APPROVAL_WORKBENCH_CHANGED'?e.message:'APPROVAL_INTERPRETATION_UNAVAILABLE',id);}finally{leave();}})();this.pending.set(id,run);run.finally(()=>this.pending.delete(id));if(!c?.classify||ruleInterpretation(a.text))await run;return this.status(node,a);
 }
 async confirm(node,a){let op=this.row(node,a);if(op.state==='recorded')return this.status(node,a);if(op.state!=='ready')throw Error('APPROVAL_OPERATION_NOT_READY');if(op.expires<=this.l.now())throw Error('APPROVAL_WORKBENCH_CHANGED');
  const identity=await this.identity.authorize(node,a.client_key);if(this.closed)throw Error('APPROVAL_WORKBENCH_DISABLED');
  this.l.store.tx(()=>{
   op=this.row(node,a);if(op.state==='recorded')return;if(op.state!=='ready'||op.expires<=this.l.now()||this.identity.state(this.identity.current(node,a.client_key))!=='active'||this.identity.current(node,a.client_key).id!==identity.id)throw Error('APPROVAL_WORKBENCH_CHANGED');
   const r=this.current({task_id:op.task_id,request_id:op.request_id,expected_revision:op.revision});if(base(r)!==op.base)throw Error('APPROVAL_WORKBENCH_CHANGED');
   const c=this.identity.binding(),i=JSON.parse(op.interpretation),principal=`feishu:${c.binding.appId}:${c.binding.approverOpenId}`,credential_id='workbench-im:'+c.bindingHash,challenge_id='workbench-im-'+op.id;
   const proof={source:'workbench-existing-im',operation_id:op.id,proposal_hash:r.proposal_hash,base:op.base,user_text:op.user_text,interpretation:i,binding_hash:c.bindingHash,session_id:identity.id,identity_reply:JSON.parse(identity.reply_json),verified_at:this.l.now()},proof_hash=digest(proof);
   this.db.prepare('INSERT INTO workbench_im_proofs VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(challenge_id,r.id,credential_id,principal,i.intent,proof_hash,identity.id,c.bindingHash,op.user_text,canonical(i),canonical(proof));
   this.l.recordDecision({request_id:r.id,action:i.intent,principal,credential_id,proof_hash,challenge_id,workbenchIM:true});const decision=this.l.row(r.id).decision_id;if(c.hostRole==='local')this.l.enqueueReceipt(decision,c.bindingHash);
   this.db.prepare("UPDATE workbench_decision_operations SET state='recorded',decision_id=? WHERE id=?").run(decision,op.id);
  });return this.status(node,a);
 }
 async call(node,method,a){
  const fields={describe:[],prepare:['client_key','event_id','task_id','request_id','expected_revision','text'],status:['client_key','event_id'],confirm:['client_key','event_id'],identity_send:['client_key','event_id'],identity_check:['client_key'],identity_close:['client_key']};
  if(!Object.hasOwn(fields,method))throw Error('METHOD_DENIED');if(!object(a)||Object.keys(a).some(k=>!fields[method].includes(k)))throw Error('APPROVAL_WORKBENCH_ARGUMENTS');
  if(method==='describe')return {schema:1,identity_policy:'reuse-existing-im',registration_required:false,execution_granted:false,enabled:true,identity_minutes:10,im_route:this.chat()?.hostRole==='local'?'local_bound_private_chat':'existing_cloud_binding_not_yet_local_unified'};
  if(this.closed)throw Error('APPROVAL_WORKBENCH_DISABLED');this.identity.key(node,a.client_key);if(fields[method].includes('event_id')&&!/^[a-zA-Z0-9-]{8,80}$/.test(a.event_id??''))throw Error('APPROVAL_EVENT_REQUIRED');
  if(method==='identity_send')return this.identity.send(node,a);if(method==='identity_check')return this.identity.check(node,a.client_key);if(method==='identity_close')return this.identity.end(node,a.client_key);
  return this[method](node,a);
 }
 async close(){this.closed=true;this.abort.abort();await Promise.allSettled([...this.pending.values(),this.identity.close()]);}
}
