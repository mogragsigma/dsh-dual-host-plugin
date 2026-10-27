// Presentation contract derived from existing, sanitized source observations.
// Actions describe future choices, not callable endpoints or execution grants.
const actions=(...names)=>names.map(key=>({key,label:{approve:'同意当前方案',reject:'拒绝当前方案',hold:'稍后决定',amend:'提出修改意见',answer:'补充信息',review:'核对原记录',proposal:'形成处理建议',end:'讨论结束任务',maintenance:'检查所需配置'}[key],available:false,reason:'INTERVENTION_ACTION_NOT_CONNECTED'}));
const terminal=/^(?:completed|cancelled|rejected|revoked|invalidated|superseded|expired|stale_revision|identity_revoked|schedule_closed|schedule_cancelled|workflow_completed|workflow_cancelled|a2a_completed|a2a_revoked|a2a_invalidated|development_completed|development_stopped|development_handed_off|delivery_completed|delivery_pushed|closed)$/;
function guidance(kind,state,error,historical){
 if(kind==='approval'){
  if(['pending','held','clarification_required'].includes(state))return {category:'decision',owner:'user',title:state==='held'?'这份方案已暂缓':state==='clarification_required'?'请说明你的决定':'有一份方案需要你决定',reason:state==='held'?'你之前选择稍后决定；没有因此重启或暂停执行。':'当前方案尚未获得有效、明确的决定。',next:'核对方案后，同意、拒绝、暂缓，或写下修改意见。',effect:'有条件同意会要求修改后重审；批准只记入账本，不等于已执行。',actions:actions('approve','reject','hold','amend')};
  if(state==='changes_requested')return {category:'amendment',owner:'system',title:'先按你的意见修改方案',reason:'已记录修改条件，旧方案不能继续执行。',next:'核对已记录的意见，形成修订方案，再请你决定。',effect:'保留旧方案与意见，不擅自修改范围或重置预算。',actions:actions('proposal','end')};
  if(state==='confirmation_review')return {category:'verification',owner:'system',title:'先核对上次确认是否记账',reason:'审批证据尚未核验完，不能判定为批准失败。',next:'核对原消息、原方案与账本；不要重复批准。',effect:'核对前不执行；证据不足时转维护处理，不重放旧消息。',actions:actions('review')};
  return null;
 }
 if(kind==='job'&&state==='paused')return {category:'exception',owner:'user',title:'本批次已暂停',reason:'保留检查点和原预算；不会自动恢复。',next:'核对已有材料，明确确认新的只读建议，或结束本批次。',effect:'新批次单独确认；不重复旧操作。',actions:actions('review','proposal','end')};
 if(/waiting_input$/.test(state))return {category:'input',owner:'user',title:'需要你补充信息',reason:'本批次正在等待具体信息，而不是新的开发授权。',next:'查看下方问题，再补充信息；不再继续时可讨论结束范围。',effect:'只补充对应批次的输入，不扩大权限；历史批次不能直接恢复。',actions:actions('answer','end')};
 if(/capability|configuration|adapter_not_enabled/i.test(state+' '+error))return {category:'configuration',owner:'operator',title:'先补齐所需能力',reason:'当前配置或执行能力不足；再次批准不能补齐能力。',next:'核对缺失能力及配置，完成维护后重新检查原授权。',effect:'保留任务与审批历史，不自动开启开发、提交或推送。',actions:actions('maintenance','end')};
 if(kind==='notification'&&state==='needs_review')return {category:'delivery',owner:'system',title:'先核对通知是否已经送达',reason:'平台发送结果未知；没看到消息不等于发送失败。',next:'核对原消息与发送回执，必要时请你说明是否看到。',effect:'只核对这条通知，不自动重发、不取消任务。',actions:actions('review')};
 if(/review|unknown|unavailable|failed|interrupted|blocked|exhausted|deadline|evidence_missing|evidence_invalid|control_pending/.test(state))return {category:'exception',owner:'system',title:historical?'历史批次仍需核对':'先核对执行问题',reason:error==='WORKER_REPORT_REQUIRED'?'该批次没有完整报告，不能把检查点当成果。':error==='WORKER_MODEL_OUTPUT_LIMIT'?'模型输出达到上限，报告未完整生成。':/exhausted|deadline/.test(state)?'原额度或期限已到，不可直接沿用旧预算继续。':'现有执行证据不足，不能用一次批准代替异常核对。',next:'核对已有成果、停止证据与原授权，再给出继续、修改或结束的建议。',effect:'不自动重试、解锁或重置预算；额外工作须另行确认。',actions:actions('review','proposal','end')};
 if(/waiting_approval$/.test(state))return {category:'verification',owner:'system',title:'先定位待确认方案',reason:'批次显示等待批准，但当前窗口没有可核验的对应方案。',next:'读取原批次所绑定的方案；不把其他方案或空白确认当作批准。',effect:'定位前不执行，不重复创建审批请求。',actions:actions('review')};
 return null;
}
export function interventionFacts(item,now){
 const out=[],revision=item.spec_revision;
 const add=(kind,row,state,rev=Object.hasOwn(row,'spec_revision')?row.spec_revision:row.workspace_revision??null)=>{
  const historical=rev===null||rev!==revision,info=guidance(kind,state,row.error??row.reason,historical);
  let lifecycle=info?'open':terminal.test(state)||state==='approved'?'resolved':'inactive';
  if(kind==='approval'&&(historical||state==='superseded'||state==='stale_revision'))lifecycle='superseded';
  else if(kind==='approval'&&(state==='expired'||Number.isFinite(row.expires)&&row.expires<=now))lifecycle='expired';
  const outcome=kind==='approval'&&row.decision?{action:row.decision.action,at:row.decision.created,text:{approve:'批准已记账；执行另行核验。',reject:'已拒绝该方案；这不等于整个任务已取消。',hold:'已暂缓决定。',amend:'已记录修改意见；旧方案不可执行。',revoke:'原批准已撤销。',clarify:'仍需澄清。'}[row.decision.action]??'原账本已记录决定。'}:lifecycle==='resolved'?{text:'来源记录已离开待处理状态；不代表整个任务已完成。'}:null;
  out.push({source_kind:kind,source_id:row.id,source_revision:Number.isSafeInteger(rev)?rev:null,source_state:state,lifecycle,historical,
   ...(info??{category:kind,owner:'none',title:'来源已不要求此项处理',reason:'保留来源记录供核对。',next:'查看原记录。',effect:'不产生新的执行授权。',actions:[]}),
   question:typeof row.input_question==='string'?row.input_question:null,summary:typeof row.summary==='string'?row.summary:null,
   user_opinion:typeof row.feedback?.user_text==='string'?row.feedback.user_text:null,result:outcome});
 };
 for(const a of item.approvals??[])add('approval',a,a.state,a.spec_revision);
 for(const j of item.jobs??[])add('job',j,j.status);
 for(const n of item.notifications?.deliveries??[])add('notification',n,n.review?.state==='closed'?'closed':n.state);
 for(const [kind,rows] of [['development',item.development?.items],['delivery',item.delivery?.execution?.items],['a2a',item.a2a?.items],['workflow',item.planning?.workflows],['schedule',item.planning?.schedules]])for(const row of rows??[])add(kind,row,row.state??row.status??'unknown');
 const active=out.some(x=>x.lifecycle==='open'&&!x.historical);
 // Aggregate fallback cannot hide an unsupported state behind an empty list.
 const info=guidance('task',item.display_state,'',false);
 if(info&&!active)add('task',{id:'state',spec_revision:revision},item.display_state);
 else add('task',{id:'state',spec_revision:revision},'inactive');
 return out;
}
