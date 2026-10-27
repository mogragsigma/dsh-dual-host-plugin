import {canonical,digest} from './approval-ledger.js';
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
// Step 01: read-only evidence assessment, not an approval authority. Host login,
// bot inventory, notification delivery and model text cannot establish a person.
export class WorkbenchApprovals {
 constructor(ledger,getChat=()=>null){this.l=ledger;this.db=ledger.db;this.getChat=getChat;}
 describe(args={}){
  if(!object(args)||Object.keys(args).some(k=>!['task_id','request_id','expected_revision'].includes(k)))throw Error('APPROVAL_WORKBENCH_ARGUMENTS');
  const scoped=Object.keys(args).length>0;
  if(scoped&&(!(typeof args.task_id==='string'&&args.task_id.length<=128&&args.task_id)||!(typeof args.request_id==='string'&&args.request_id.length<=128&&args.request_id)||!Number.isSafeInteger(args.expected_revision)||args.expected_revision<1))throw Error('APPROVAL_WORKBENCH_ARGUMENTS');
  const chat=this.getChat(),binding=chat?.bindingHash?this.db.prepare('SELECT binding,disabled FROM approval_chat_bindings WHERE id=?').get(chat.bindingHash):null;
  const active=!!(binding?.disabled===0&&chat?.binding&&binding.binding===canonical(chat.binding)&&digest(chat.binding)===chat.bindingHash&&!chat.closed);
  const state=!chat?'not_configured':!active?'needs_review':chat.lastError?'unavailable':'configured';
  const result={schema:2,enabled:false,primary_entry:'local_workbench',auxiliary_entry:'local_im',identity_policy:'reuse-existing-im',registration_required:false,
   new_browser_credential_required:false,identity_verified:false,approval_granted:false,execution_granted:false,read_only:true,
   reason:'APPROVAL_WORKBENCH_LINK_PENDING',message:'工作台直接审批正在接线，不需要注册新身份。你的意见不会因这次查询被提交。',
   local_im:{state:'not_linked',same_conversation_required:true,same_dsh_session_required:false},
   existing_im:{state,host_role:chat?(chat.hostRole??'cloud'):null,provider:chat?'feishu':null,verified_now:false},
   next_action:{kind:'wait_for_connection',label:'等待工作台接线',message:'本轮先移除重复身份注册；完成工作台与本地机器人接线后，可在这个任务内直接处理。'}};
  if(chat?.hostRole==='local'){result.local_im.state=active?'configured':'needs_review';result.message='工作台已支持既有本地 IM 身份核验；此兼容查询本身不授予身份或批准。';result.next_action={kind:'use_task_workbench',label:'在任务工作台处理',message:'打开对应任务，在待你处理内核对并保存决定；必要时到已绑定的本地机器人私聊确认窗口身份。'};}
  if(state==='needs_review')result.next_action={kind:'review_existing_binding',label:'核对现有 IM 绑定',message:'现有绑定已停用或变化；需核对原绑定，不能仅凭机器人 App ID 自动恢复。'};
  else if(state==='unavailable')result.next_action={kind:'check_existing_connection',label:'检查现有 IM 连接',message:'现有审批私聊暂不可用，请先检查连接；不用重复批准，也不用重新注册身份。'};
  else if(state==='not_configured')result.next_action={kind:'configure_local_im',label:'本地 IM 尚未接入',message:'后续将使用配置导览中选择的本地机器人及已绑定对话；不会新建身份账号。'};
  if(scoped){
   const row=this.db.prepare('SELECT task_id,spec_revision,expires,state FROM approval_requests WHERE id=?').get(args.request_id);
   const revision=this.db.prepare('SELECT spec_revision FROM task_catalog WHERE task_id=?').get(args.task_id)?.spec_revision;
   if(!row||row.task_id!==args.task_id||row.spec_revision!==args.expected_revision||revision!==args.expected_revision)throw Error('APPROVAL_WORKBENCH_CHANGED');
   const unresolved=this.db.prepare("SELECT 1 FROM approval_chat_evaluations WHERE request_id=? AND state IN ('processing','needs_review') LIMIT 1").get(args.request_id);
   const delivery=this.db.prepare('SELECT binding_hash,state,message_id,prompt_version FROM approval_chat_deliveries WHERE request_id=?').get(args.request_id);
   // A delivered proposal tells users where they may reply; it is NOT identity
   // proof and does not bypass the observer's independent message verification.
   if(!unresolved&&active&&state==='configured'&&delivery?.binding_hash===chat.bindingHash&&delivery.state==='sent'&&delivery.message_id&&delivery.prompt_version&&row.expires>this.l.now()&&['pending','approved','held','clarification_required'].includes(row.state)){
    result.next_action={kind:'reply_existing_proposal',label:'仍可回复原有审批方案',message:'在原方案所在的已绑定飞书私聊，回复该方案表达同意、拒绝、暂缓或修改意见；不要回复结果通知。'+(chat.hostRole==='local'?'本地机器人确认与回执使用同一绑定私聊。':'此旧通道尚未迁移到本地机器人。')+''};
   }
  }
  return result;
 }
 async call(_node,method,args){
  if(method==='describe')return this.describe(args);
  // Retired client, queued challenge and forged owner fields cannot create a
  // new decision. Historical database rows remain untouched for audit/recovery.
  if(['prepare','begin','finish','status'].includes(method))throw Error('APPROVAL_PASSKEY_RETIRED');
  throw Error('METHOD_DENIED');
 }
}
