 // Preview adapters only simulate. The live adapter prepares an intent, then requires
 // verified existing identity in a later step; the legacy step 01 adapter only reports readiness.
 function TaskDecisionBox({item, entry, fresh, adapter, onRecorded}) {
  const draftKey=JSON.stringify([item.task_id,entry.id,item.spec_revision]);
  const [draft,setDraft]=React.useState(adapter?.drafts?.get(draftKey)||''),[busy,setBusy]=React.useState(false),[result,setResult]=React.useState(null),[error,setError]=React.useState('');
  const generation=React.useRef(0),alive=React.useRef(true),locked=React.useRef(false),review=React.useRef();
  const inputId=React.useId(),hintId=React.useId();
  const identity={task_id:item.task_id,request_id:entry.id,expected_revision:item.spec_revision};
  function saveDraft(value){setDraft(value);adapter?.drafts?.set(draftKey,value);}
  React.useEffect(()=>{setDraft(adapter?.drafts?.get(draftKey)||'');},[draftKey]);
  React.useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
  React.useEffect(()=>{generation.current++;setResult(null);setError('');},[entry.id,item.spec_revision,entry.approval?.state]);
  React.useEffect(()=>{if(result?.prepared)review.current?.focus();},[result?.operation_id,result?.prepared]);
  const available=!!adapter, enabled=available&&(fresh||adapter?.serverValidated)&&!busy, pending=adapter?.pending?.(identity), reviewing=result?.prepared&&!!adapter?.confirm;
  const errors={CHAT_LOCAL_IM_OFFLINE:'本地机器人接入端暂时离线；未发出新的身份确认。保留意见，连接恢复后再核对。',APPROVAL_BROWSER_CRYPTO_REQUIRED:'当前容器缺少安全随机数能力；审批未提交，其他工作台功能仍可使用。',APPROVAL_SNAPSHOT_CHANGED:'方案已变化，请刷新后查看；未提交决定。',APPROVAL_WORKBENCH_DISABLED:'两端工作台接线尚未就绪，未提交意见。',APPROVAL_PASSKEY_RETIRED:'旧身份入口已停用。无需注册新身份，请返回任务查看处理方式。',APPROVAL_IDENTITY_CONTRACT_CHANGED:'两端身份接线版本不一致；请核对版本，本次未提交意见。',CAPABILITY_VERSION_INCOMPATIBLE:'两端身份接线版本不一致；请核对版本，本次未提交意见。',APPROVAL_WORKBENCH_CHANGED:'方案或审批状态已变化；请刷新核对，原意见仍保留。',APPROVAL_IDENTITY_REQUIRED:'此窗口身份尚未核验或已失效；请在下方通过既有 IM 确认，不会提交决定。',APPROVAL_IM_BINDING_REQUIRED:'尚无可用的可信 IM 私聊绑定。机器人已安装不等于已绑定批准人；请先完成绑定。',APPROVAL_OPERATION_NOT_READY:'意见仍在核验，请查询本次结果，不重复提交。',APPROVAL_OPERATION_NOT_FOUND:'本次请求尚未找到。保留意见，先核对连接；不要重复批准。',APPROVAL_BROWSER_ORIGIN_REQUIRED:'此访问容器无法核验来源；未提交决定，请使用受支持的已登录工作台。'};
  async function perform(run){
   if(busy||locked.current)return;locked.current=true;setBusy(true);setError('');const seq=++generation.current;
   try{const reply=await run();if(alive.current&&seq===generation.current){setResult(reply);if(reply?.recorded===true){saveDraft('');adapter?.discard?.(identity);onRecorded?.(reply);}}}
   catch(e){if(alive.current&&seq===generation.current){setError(errors[e.message]??'未确认处理结果。请查询原操作，不要重复批准。');if(e.message==='APPROVAL_IDENTITY_REQUIRED')setResult(r=>({...r,identity:{state:'expired',verified:false}}));else if(adapter?.identity&&!errors[e.message])setResult(r=>({...r,uncertain:true}));}}
   finally{locked.current=false;if(alive.current)setBusy(false);}
  }
  function submit(shortcut){if(!enabled||pending)return;return perform(()=>adapter(decisionSelection(item,entry,draft,shortcut)));}
  const labels={approved:'批准已记账',rejected:'已拒绝',held:'已暂缓',changes_requested:'需修改后重新送审',clarification_required:'待澄清',identity_required:'请使用已绑定身份',connection_pending:'处理入口说明',not_received:'未收到意见核对',changed:'请重新核对方案'};
  const intentLabels={approve:'批准原方案',reject:'拒绝原方案',hold:'暂缓决定',amend:'提出修改，旧方案不可执行',clarify:'需要澄清，不视为同意',revoke:'撤销原授权'};
  return h('div',{className:'task-decision-box'},
   h('div',{className:'decision-context'},text('当前方案 · 第 '+item.spec_revision+' 版','small'),text('有效至 '+time(entry.approval.expires),'small')),
   h('label',{htmlFor:inputId},adapter?.readinessOnly?'你的意见（尚未提交）':'你的决定或意见'),
   h('textarea',{id:inputId,'aria-describedby':hintId,value:draft,maxLength:2000,rows:3,disabled:busy||!!pending,placeholder:'例如：就按这个方案执行；或可以，但请把报告改成两段。',onChange:e=>{saveDraft(e.target.value);setResult(null);setError('');}}),
   h('p',{id:hintId,className:'decision-hint'},!fresh&&!adapter?.serverValidated?(adapter?.readinessOnly?'历史快照：仍可查询最新处理方式；不会提交决定，已写意见仍保留。':'历史快照：刷新核对后才能提交，未提交意见仍保留。'):!available?'审批接线尚未启用：这里不会提交决定。':adapter.preview?'交互演示：只改变本页模拟数据，不产生真实批准。':adapter.readinessOnly?'工作台直接处理正在接线；可以先写下意见并查看当前处理方式，不会提交决定。':'核对意见与方案后保存；首次通过既有 IM 确认此窗口身份，10分钟内无需反复跳转。'),
   draft.trim()&&!pending&&!adapter?.readinessOnly?text('已填写文字时，以完整文字为准；快捷按钮不会覆盖你的意见。','decision-hint'):null,
   !pending&&!adapter?.readinessOnly?h('div',{className:'decision-actions'},button(busy?'正在核验…':adapter?.confirm?'核对我的意见':'提交意见',()=>submit(null),!enabled||!draft.trim(),'primary','message'),button('同意原方案',()=>submit('approve'),!enabled,'','shield'),button('暂缓',()=>submit('hold'),!enabled),button('拒绝',()=>submit('reject'),!enabled,'decision-reject')):null,
   adapter?.readinessOnly?button(busy?'正在检查…':'查看当前处理方式',()=>perform(()=>adapter.readiness(identity)),!available||busy,'primary','help'):null,
   reviewing?h('section',{className:'decision-review',ref:review,tabIndex:-1,'aria-label':'核对解释与方案'},
    h('h5',null,'系统理解：'+(intentLabels[result.interpretation?.intent]??'需要核对')),
    text(result.user_text,'decision-quote'),text(result.interpretation?.intent==='amend'&&result.interpretation?.engine==='unavailable'?'已识别修改条件，按需修改处理，不视为批准。详细条件以你的原文为准。':result.interpretation?.reason??result.interpretation?.summary??''),
    text(result.interpretation?.intent==='amend'?'保存后进入“需修改后重审”；不会修改或执行旧方案。':'仅记录对本份方案的决定，不等于已开始、已完成或已发布。','decision-hint'),
    h('details',{className:'decision-proposal',open:true},h('summary',null,'本次绑定的完整方案'),
     ...[['summary','方案'],['changes','拟变更'],['validation','验证'],['risks','风险'],['rollback','回滚']].map(([k,v])=>h('div',{key:k},h('strong',null,v),text(result.proposal?.[k]??'未提供'))),
     h('div',null,h('strong',null,'授权范围'),text((result.proposal?.scopes??[]).map(x=>({develop:'开发',commit:'提交',push:'推送',publish:'发布',deploy:'部署'}[x]??x)).join('、'))),
     h('div',null,h('strong',null,'任务模型'),text([result.proposal?.model_policy?.provider,result.proposal?.model_policy?.model,result.proposal?.model_policy?.reasoningEffort].filter(Boolean).join(' / '))),
     h('details',null,h('summary',null,'查看仓库、限额与交付绑定'),h('pre',null,JSON.stringify({repository:result.proposal?.repository,development:result.proposal?.development,delivery:result.proposal?.delivery},null,2)))),
    adapter?.identity?h('section',{className:'decision-identity','aria-label':'工作台身份'},
     h('strong',null,result.identity?.verified?'本窗口身份已核验':'先确认这个工作台窗口的身份'),
     text(result.identity?.verified?'10分钟内可逐项处理方案；这不是任何任务的批准。':result.identity?.host_role==='local'?'使用已绑定的本地机器人私聊；身份确认、方案和账本回执在同一对话，不依赖 DSH 会话。':'复用现有云端审批私聊；尚未配置本地统一入口，不新增账号。'),
     result.identity?.confirmation_code?text('窗口校验：'+result.identity.confirmation_code):null,
     result.identity?.message?text(result.identity.message):null,
     h('div',{className:'decision-actions'},
      !result.identity?.verified?button(['sending','sent','needs_review'].includes(result.identity?.state)?'已发起身份确认':'通过已绑定 IM 确认身份',()=>perform(async()=>({...result,identity:await adapter.identity('send')})),busy||['sending','sent','needs_review'].includes(result.identity?.state),'','shield'):null,
      button('我已回复，核对身份',()=>perform(async()=>({...result,identity:await adapter.identity('check')})),busy),
      result.identity?.verified?button('结束本窗口身份使用',()=>perform(async()=>({...result,identity:await adapter.identity('close')})),busy):null)):null,
    h('div',{className:'decision-actions'},button('保存这次决定',()=>perform(()=>adapter.confirm(identity,result)),!enabled||result.uncertain||!!adapter?.identity&&!result.identity?.verified,'primary','shield'),button('返回修改',()=>{adapter.discard(identity);setResult(null);setError('');},busy||result.uncertain))):null,
   pending&&adapter?.status?h('div',{className:'decision-query'},button('查询本次处理结果',()=>perform(()=>adapter.status(identity)),busy,'','refresh'),text(result?.uncertain?'结果尚未确认，只查询原操作，不重复提交。':'离开此任务再返回时，可查询本次处理结果。')):null,
   result&&!reviewing&&(!onRecorded||!result.recorded)?h('div',{className:'decision-result',role:'status'},h('strong',null,(adapter?.preview?'模拟结果 · ':'')+(labels[result.state]??'尚待核对')),text(result.message??'决定与执行分开；不会因此自动启动任务。'),result.next_action?h('div',null,h('strong',null,result.next_action.label),text(result.next_action.message)):null,pending&&!result.recorded&&!result.uncertain&&result.operation_state!=='processing'?button('返回修改意见',()=>{adapter.discard(identity);setResult(null);setError('');},busy):null):null,
   error?h('p',{className:'warning',role:'alert'},error):null);
 }
 function TaskAttention({item,fresh,adapter,inspect,discuss,onRecorded}) {
  const entries=taskAttention(item);
  if(!entries.length&&!item.interventions?.items.length){const a=(item.approvals??[]).find(x=>x.spec_revision===item.spec_revision);return text('当前快照没有待你处理的事项。'+(a?' 当前方案：'+label(a.state)+'；这不是执行结果。':''),'attention-clear');}
  return h('section',{className:'task-attention','aria-label':'待你处理'},h('header',{className:'attention-heading mascot-zone'},h('div',null,h('h3',null,icon('message'),'待你处理',h('span',{className:'count'},entries.length)),text('区分需要你决定、先核对和维护处理。')),companion('tasks')),
   ...entries.map(e=>h('article',{key:e.intervention_id??e.kind+e.id,className:'attention-item'},h('h4',null,e.title),e.owner?text(({user:'需要你决定',system:'需要先核对',operator:'需要维护处理',none:'历史记录'}[e.owner]??'待核对')+(e.historical?' · 历史／修订未确认':''),'intervention-owner'):null,text(e.description,'attention-description'),e.summary?text(e.summary,'decision-quote'):null,e.question?h('div',{className:'decision-quote'},h('strong',null,'需要补充的问题'),text(e.question)):null,e.next&&!(adapter?.intervention&&e.intervention_id&&e.kind!=='approval')?h('div',{className:'intervention-next'},h('strong',null,'下一步'),text(e.next),h('strong',null,'处理后的影响'),text(e.effect)):null,e.feedback?.user_text?h('div',{className:'decision-quote'},h('strong',null,'已记录的意见'),text(e.feedback.user_text)):null,
    e.kind==='approval'?h(TaskDecisionBox,{key:e.id,item,entry:e,fresh,adapter,onRecorded}):
     adapter?.intervention&&e.intervention_id?h(InterventionActionBox,{key:e.intervention_id,item,entry:e,adapter,onRecorded}):
     h('div',{className:'attention-inline-actions'},button(e.action==='discuss'?'查看修改意见':e.action==='answer'?'查看待补充问题':'查看原因',inspect,false,'','search'),discuss?button('在对话中讨论',()=>discuss(e),false,'','message'):text('当前只登记与展示处理事项；具体操作尚未接入，不会自动重试或执行。')))),item.interventions?h(InterventionHistory,{ledger:item.interventions}):null);
 }
 function TaskDiagnostics({item,children}) {
  const dialog=React.useRef(),trigger=React.useRef(),[open,setOpen]=React.useState(false),id=React.useId();
  function show(){setOpen(true);dialog.current.showModal();}
  return h(React.Fragment,null,
   h('button',{type:'button',ref:trigger,className:'button plain detail-more','aria-haspopup':'dialog','aria-controls':id,'aria-expanded':open,onClick:show},icon('help'),'任务信息与诊断'),
   h('dialog',{id,ref:dialog,className:'about-dialog task-diagnostics-dialog','aria-label':'任务信息与诊断',onClose:()=>{setOpen(false);trigger.current?.focus();},onClick:e=>{if(e.target===e.currentTarget)dialog.current.close();}},
    h('div',{className:'dialog-header'},h('h2',null,'任务信息与诊断'),h('button',{type:'button',className:'icon-button','aria-label':'关闭任务诊断',onClick:()=>dialog.current.close()},icon('close'))),text(item.title),open?children:null));
 }

 function InterventionHistory({ledger}){
  const rows=ledger.items;
  return h('details',{className:'intervention-history'},h('summary',null,'处理记录 · '+ledger.total+' 项'),
   text('以下是来源观测历史，不是新的批准或执行指令。'),ledger.has_more?text('当前仅显示前 '+ledger.display_limit+' 项；其他记录仍保留，未被当成已处理。'):null,
   ...rows.map(r=>h('details',{key:r.id},h('summary',null,(r.lifecycle==='open'?'待处理':r.lifecycle==='unverified'?'本次未核实':r.lifecycle==='expired'?'方案已过期':r.lifecycle==='superseded'?'旧方案已失效':'来源状态已更新')+' · '+r.title),
    text('最后读取：'+time(r.last_seen)),...(r.handling??[]).map(o=>h('div',{key:o.id,className:'intervention-event'},text(time(o.created)+' · '+({continue:'确认新建议',answer:'确认补充信息',end:'结束批次',hold:'稍后处理',maintenance:'维护请求'}[o.action]??'处理意见')),text(o.text||'未另填意见'),text(o.state==='recorded'?({queued:'新批次已排队',running:'新批次正在执行',completed:'新批次已完成',draining:'结束已请求，仍待排空',ended:'本批次已结束',notice_closed:'通知跟进已关闭，未重发',held:'意见已保留，稍后处理',maintenance_requested:'维护请求已登记，尚未修复'}[o.progress]??'处理已记账；不是整个任务完成'):o.state==='ready'?'建议尚未确认':o.state==='superseded'?'已被新建议替代，不能执行':'原操作仍待核对'))),...(r.events??[]).map(e=>h('div',{key:e.version,className:'intervention-event'},text(time(e.created)+' · '+({observed:'登记事项',source_updated:'来源内容更新',source_state_changed:'来源状态更新',source_not_observed:'本次未读取到原记录'}[e.event]??'观测记录')),e.user_opinion?h('div',null,h('strong',null,'已记账的意见'),text(e.user_opinion)):null,e.result?text(e.result.text):null)),r.events_total>(r.events??[]).length?text('显示最近 20 条；更早记录保留。'):null)));
 }
