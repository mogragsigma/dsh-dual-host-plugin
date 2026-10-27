// Read-only navigation from UNTRUSTED quoted text to this coordinator's ledger.
// A match is neither provider identity proof nor evidence this reply was handled.
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const tables=[['proposal','approval_chat_deliveries'],['receipt','approval_receipts'],['guidance','approval_guidance']];
const has=(db,t)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const unresolved='本入口尚不能核验这条回复；这不等于审批失败。请以原方案对应的审批账本回执为准，无需重复批准。';
export function approvalReference(g,a){
 if(!object(a)||Object.keys(a).some(k=>k!=='quoted_text')||typeof a.quoted_text!=='string'||!a.quoted_text.trim()||a.quoted_text.length>20000)throw Error('APPROVAL_REFERENCE_INVALID');
 const db=g.approvals.db;
 const out={schema:1,authority:'current-cloud-ledger',namespace:g.c.namespace,observed_at:g.now(),match:'unresolved',
  quote_is_authority:false,current_reply_verified:false,execution_granted:false,provider_checked_now:false,
  creates_request:false,resend_confirmation:false,reply_policy:'one_brief_non_authoritative_status',suggested_reply:'本入口尚未核验这条回复；请以原方案的审批账本回执为准，无需重复批准。',guidance:unresolved};
 const matches=[];
 for(const [kind,table] of tables){
  if(!has(db,table))continue;
  const conditions=kind==='proposal'?"state IN ('sent','inactive') AND prompt_version IS NOT NULL":"state='sent'";
  for(const r of db.prepare('SELECT request_id,binding_hash FROM '+table+' WHERE text=? AND message_id IS NOT NULL AND '+conditions+' LIMIT 2').all(a.quoted_text))matches.push({kind,...r});
 }
 if(!matches.length)return out;
 if(matches.length!==1)return {...out,match:'ambiguous'};
 const {kind,request_id,binding_hash}=matches[0],r=db.prepare('SELECT task_id,spec_revision FROM approval_requests WHERE id=?').get(request_id);
 // Existing ledger reads may lazily initialize old catalog entries. This endpoint
 // must not do that: incomplete history is unavailable, never repaired by lookup.
 if(!r||!db.prepare('SELECT 1 FROM task_catalog c JOIN task_revisions h ON h.task_id=c.task_id AND h.revision=c.spec_revision WHERE c.task_id=?').get(r.task_id)||
  !db.prepare('SELECT 1 FROM task_revisions WHERE task_id=? AND revision=?').get(r.task_id,r.spec_revision))return {...out,match:'state_unavailable'};
 const v=g.approvals.view(request_id),binding=db.prepare('SELECT disabled FROM approval_chat_bindings WHERE id=?').get(binding_hash);
 const receipts=db.prepare('SELECT state,snapshot_state,snapshot_at,last_error FROM approval_receipts WHERE request_id=? AND binding_hash=? ORDER BY created DESC,decision_id LIMIT 5').all(request_id,binding_hash);
 const {suggested_reply,...matched}=out;
 return {...matched,match:kind,binding_active:binding?.disabled===0,
  approval:{id:v.id,task_id:v.task_id,title:v.title,spec_revision:v.spec_revision,state:v.state,expires:v.expires,scopes:v.proposal.scopes,execution:v.execution},receipts,
  guidance:kind==='proposal'?'这是本实例已登记方案的当前账本快照，不证明本条回复已核验或已执行。不要重新送审、代批或重复发送确认；回执投递状态与批准状态分开说明。':
  '引用的是结果通知或操作提示，不是待审批方案。定位原方案后再表达变更意见；本次查询不改变审批，也不证明这条回复已被观察器核验。'};
}
