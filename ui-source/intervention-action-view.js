 // User opinions are never silently replaced by a shortcut. Review prepares a
 // complete bounded plan; a separate identity-verified click confirms that plan.
 function InterventionActionBox({item,entry,adapter,onRecorded}){
  const api=adapter?.intervention,scope={task_id:item.task_id,intervention_id:entry.intervention_id,expected_revision:item.spec_revision},k=JSON.stringify(scope);
  const [draft,setDraft]=React.useState(api?.drafts.get(k)||''),[facts,setFacts]=React.useState(null),[result,setResult]=React.useState(null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
  const locked=React.useRef(false),alive=React.useRef(true),review=React.useRef(),id=React.useId();
  React.useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  React.useEffect(()=>{if(result?.prepared)review.current?.focus();},[result?.operation_id]);
  if(!api||!entry.intervention_id)return null;
  const pending=api.pending(scope),labels={continue:'形成补充报告建议',answer:'按我的补充形成建议',end:'查看结束范围',hold:'稍后处理',maintenance:'请求维护处理',close_notice:'结束这条通知跟进'};
  const codes={INTERVENTION_CHANGED:'原状态或建议已变化，未应用旧建议。请返回修改并重新核对。',INTERVENTION_EXPIRED:'本建议已过期，请重新核对。',INTERVENTION_ACTION_UNAVAILABLE:'这个动作当前不可用。请重新核对；不会绕过原门禁。',INTERVENTION_TEXT_REQUIRED:'请先写下补充信息或需要维护的问题。',INTERVENTION_MATERIAL_LIMIT:'已存材料超过本次安全限额，不能静默截断；请登记维护请求或结束本批次。',INTERVENTION_UNCERTAIN:'此前操作结果待核对，不会重复执行。',INTERVENTION_INTENT_CONFLICT:'意见中包含暂缓或拒绝，请使用相应处理入口；不会按继续执行。',APPROVAL_IDENTITY_REQUIRED:'窗口身份未核验或已失效。请通过已绑定 IM 核对，不会自动提交。',CHAT_LOCAL_IM_OFFLINE:'本地机器人暂时离线，意见保留；恢复后再核对身份。',APPROVAL_IM_BINDING_REQUIRED:'尚未绑定可核验的 IM 私聊身份；不会自动放行。'};
  async function run(fn,kind='result'){
   if(locked.current)return;locked.current=true;setBusy(true);setError('');
   try{const r=await fn();if(!alive.current)return;if(kind==='facts')setFacts(r);else{setResult(r);if(r.recorded){setDraft('');api.drafts.delete(k);onRecorded?.(r);}}}
   catch(e){if(alive.current){setError(codes[e.message]||'结果暂未确认。请查询原操作，不要重复提交。');if(api.pending(scope))setResult(r=>({...r,uncertain:true,identity:e.message==='APPROVAL_IDENTITY_REQUIRED'?{verified:false}:r?.identity}));}}
   finally{locked.current=false;if(alive.current)setBusy(false);}
  }
  const prepare=action=>run(()=>api.prepare({...scope,action,text:draft}));
  const reset=()=>{api.discard(scope);setResult(null);setError('');setFacts(null);};
  const identity=action=>run(async()=>({...result,identity:await api.identity(action)}));
  return h('div',{className:'task-decision-box intervention-action-box'},
   h('div',{className:'decision-actions'},button(busy?'正在核对…':'核对原因并查看建议',()=>run(()=>api.inspect(scope),'facts'),busy||!!pending,'','search')),
   facts?h('section',{'aria-label':'异常核对结果'},text(facts.advice,'decision-quote'),facts.summary?text(facts.summary):null,facts.question?text('待补充：'+facts.question):null,facts.budget?text('原批次 '+facts.budget.used+' / '+facts.budget.limit+' 次 · 不重置','small'):null,
    h('label',{htmlFor:id},'你的补充或修改意见'),h('textarea',{id,rows:3,maxLength:2000,disabled:busy||!!pending,value:draft,placeholder:'例如：只使用已有资料，不重新检索，报告分成两段。',onChange:e=>{setDraft(e.target.value);api.drafts.set(k,e.target.value);}}),
    text('先形成建议，再明确确认。输入的全部意见会保留；本页不新增开发、提交或推送权限。','decision-hint'),
    !pending?h('div',{className:'decision-actions'},...facts.choices.map(action=>button(labels[action],()=>prepare(action),busy||['answer','maintenance'].includes(action)&&!draft.trim(),['continue','answer'].includes(action)?'primary':''))):null,
    facts.history?.length?h('details',null,h('summary',null,'此前处理意见'),...facts.history.map(x=>h('div',{key:x.id},text(time(x.created)+' · '+(labels[x.action]??x.action)),text(x.text||'未另填意见'),text(x.result?.state==='held'?'意见已保留，尚待处理':x.result?.state==='maintenance_requested'?'维护请求已登记，尚未修复':({ready:'建议尚未确认',superseded:'已被新建议替代',recorded:'处理已记账',needs_review:'原操作仍待核对'}[x.state]??'尚待核对'))))):null):null,
   result?.prepared?h('section',{className:'decision-review',ref:review,tabIndex:-1,'aria-label':'核对处理建议'},h('h5',null,result.plan.title),text(result.plan.text||'未另填意见','decision-quote'),text(result.plan.effect),text(result.plan.boundary,'decision-hint'),
    result.plan.model?text('本次模型：'+[result.plan.model.provider,result.plan.model.model,result.plan.model.reasoningEffort].filter(Boolean).join(' / ')):null,
    result.plan.materials?text('复用检查点及 '+result.plan.materials.source_count+' 份已存资料；不读取新文件或重新检索。'):null,
    h('section',{className:'decision-identity','aria-label':'处理身份'},text(result.identity?.verified?'本窗口身份已核验，仍需确认下方本次建议。':'复用已绑定 IM 身份，无需新账号或设备专属认证。'),result.identity?.confirmation_code?text('窗口校验：'+result.identity.confirmation_code):null,
     h('div',{className:'decision-actions'},!result.identity?.verified?button('通过已绑定 IM 确认身份',()=>identity('send'),busy||['sent','sending','needs_review'].includes(result.identity?.state),'','shield'):null,button('核对窗口身份',()=>identity('check'),busy))),
    h('div',{className:'decision-actions'},button(['continue','answer'].includes(result.plan.action)?'确认这份新建议并排队':result.plan.action==='end'?'确认结束本批次':'保存这次处理意见',()=>run(()=>api.confirm(scope)),busy||result.uncertain||!result.identity?.verified,'primary','shield'),button('返回修改意见',reset,busy||result.uncertain))):null,
   pending?h('div',{className:'decision-query'},button('查询本次处理结果',()=>run(()=>api.status(scope)),busy,'','refresh'),text('仅查询原操作，不重复执行；刷新页面后仍可在处理记录查看。','small')):null,
   result&&!result.prepared?h('div',{className:'decision-result',role:'status'},text(result.recorded?({queued:'新报告已排队',running:'正在生成报告',completed:'报告批次已完成',needs_review:'新批次仍需核对',draining:'结束请求已记账，等待排空',ended:'本批次已结束',held:'已保留，稍后处理',maintenance_requested:'维护请求已登记',notice_closed:'通知跟进已结束（未重发）'}[result.progress]??'处理已记账'):'尚待核对'),text(result.message||'先查询原处理结果。'),!result.uncertain?button(result.recorded?'重新查看处理状态':'返回修改意见',reset,busy):null):null,
   error?h('p',{className:'warning',role:'alert'},error):null);
 }
