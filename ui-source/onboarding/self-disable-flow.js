// Persist only a diagnostic reference, never an authorization or executable plan.
const KEY='dsh-self-disable-reference-v1';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const int=v=>Number.isSafeInteger(v)&&v>=0;
const phases=['intent','unknown','not_dispatched','saved_restart_required','manager_applied','manager_rejected','reconciled'];
const receipt=v=>v===null||v&&uuid(v.id)&&phases.includes(v.state)&&typeof v.version==='string'&&v.version.length<=128&&int(v.createdAt)&&int(v.updatedAt)&&v.updatedAt>=v.createdAt&&(v.state!=='reconciled'||v.review?.originalOutcomeProven===false&&v.review?.bundleEnabled===true&&int(v.review?.at));
const pending=r=>!!r&&['intent','unknown'].includes(r.state);
const scoped=v=>v&&v.hostStopped===false&&v.packageRemoved===false&&v.rulesOrSkillsRemoved===false&&v.executionAuthorized===false&&v.automaticRestart===false;
const valid=v=>scoped(v)&&v.contract===1&&v.queryContract===1&&v.scope==='current_host_own_bundle_selection_only'&&v.externalRecovery==='official_plugin_manager'&&uuid(v.instanceId)&&int(v.revision)&&int(v.historyCount)&&v.historyCount<=32&&typeof v.operationInFlight==='boolean'&&receipt(v.receipt)&&v.pending===pending(v.receipt);
export function selfDisableActions(s,contract,now=Date.now()){
 const c=s.current,ready=contract===1&&!s.busy&&s.fresh&&!s.uncertain&&!s.storageError&&valid(c)&&!c.operationInFlight;
 return {disable:!!(ready&&!c.pending&&c.receipt?.state!=='saved_restart_required'),review:!!(ready&&c.pending),confirm:!!(ready&&s.plan?.canApply===true&&s.plan.expiresAt>now)};
}
export function selfDisableRecoveryGuide(operationId){
 return `大肥鱼 · 本端插件停用恢复说明\n\n仅适用于你刚才操作的同一台 Host、同一 profile。\n1. 停用后本插件的面板和回执通道可能立即消失。这不证明原请求成功，也不表示 Host 已停止。不要重复停用请求。\n2. 使用该 Host 的 DSH 官方插件管理，找到 @mogragsigma/dsh-dual-host-plugin，核对当前状态。需要恢复时，另行决定重新启用；不要移除包或覆盖用户配置。官方要求重启时，先保存草稿、确认会话空闲并了解最后到达的原生输入可能中止，再由你明确重启。\n3. 重新进入配置导览 → 维护会话 → 本端插件停用，点击“手动核对停用账本”。未知记录不会自动重发；原 Host 进程仍在时不能收尾。\n4. 原进程退出后，可另行确认“补记当前观察”；这不追认原操作成功。组件维护旧记录的收尾、自有执行入口恢复，也分别预览确认。\n5. 包、全局规则、Skills、凭据、任务与成果保留。此操作不是完整卸载，不授权开发或发布。\n\n诊断引用：${uuid(operationId)?operationId:'尚未生成；恢复后手动查询当前账本'}\n此说明不含密钥、访问地址、批准指纹或可重放命令。\n`;
}
export function createSelfDisableFlow(request,changed,contract,storage,now=Date.now){
 let reference=null,storageError=false;
 try{if(!storage)throw Error();const v=JSON.parse(storage.getItem(KEY)??'null');if(v!==null){if(!v||Object.keys(v).join()!=='operationId'||!uuid(v.operationId))throw Error();reference=v;}}catch{storageError=true;}
 let s={current:null,receipt:null,reference,storageError,plan:null,busy:false,fresh:false,uncertain:!!reference||storageError,error:'',observedAt:null};
 const emit=p=>{s={...s,...p};changed(s);},invalid=()=>{throw Error('ONBOARDING_TRANSPORT_RESPONSE_INVALID');};
 function observe(v,ref){
  if(!valid(v))invalid();if(ref&&(v.requestedOperationId!==ref.operationId||!Object.hasOwn(v,'requestedReceipt')||!receipt(v.requestedReceipt)||v.requestedReceipt&&v.requestedReceipt.id!==ref.operationId))invalid();
  const r=ref?v.requestedReceipt:v.receipt;return {current:v,receipt:r,fresh:true,uncertain:s.storageError||!!ref&&!r,observedAt:now()};
 }
 async function act(action,confirmed=false,guideSaved=false){
  if(s.busy||contract!==1||!['refresh','disable','review','confirm'].includes(action))return false;
  const g=selfDisableActions(s,contract,now()),p=s.plan;if(action!=='refresh'&&(!g[action]||action==='confirm'&&(confirmed!==true||p.action==='disable_own_bundle'&&guideSaved!==true)))return false;
  emit({busy:true,error:'',plan:null});
  try{
   if(action==='refresh')emit(observe(await request('self_disable_status',s.reference??{}),s.reference));
   else if(action==='confirm'){
    const ref={operationId:p.action==='disable_own_bundle'?p.id:p.operationId};
    try{storage.setItem(KEY,JSON.stringify(ref));if(storage.getItem(KEY)!==JSON.stringify(ref))throw Error();}catch{throw Error('ONBOARDING_SELF_DISABLE_REFERENCE_UNAVAILABLE');}
    emit({reference:ref,uncertain:true,fresh:false});
    const v=await request('self_disable_'+(p.action==='disable_own_bundle'?'apply':'reconcileApply'),{id:p.id,fingerprint:p.fingerprint,confirm:true,acceptRisk:true});
    if(!valid(v)||v.instanceId!==p.instanceId||v.revision<=p.revision||v.receipt?.id!==ref.operationId||p.action==='record_observation_only'&&(v.managerActions!==0||v.receipt.state!=='reconciled'))invalid();
    emit(observe({...v,requestedOperationId:ref.operationId,requestedReceipt:v.receipt},ref));
   }else{
    const c=s.current,p=await request('self_disable_'+(action==='disable'?'preview':'reconcilePreview'),{});
    if(p.contract!==1||p.instanceId!==c.instanceId||p.revision!==c.revision||!uuid(p.id)||!hash(p.fingerprint)||!int(p.expiresAt)||p.expiresAt<=now()||p.canApply!==true||p.hostStopAuthorized!==false||p.automaticRestart!==false)invalid();
    if(action==='disable'?(p.action!=='disable_own_bundle'||p.scope!=='current_host_own_bundle_selection_only'||typeof p.version!=='string'||!Array.isArray(p.risks)||!['own_ui_and_rpc_may_disappear','late_native_or_im_input_may_abort','restart_may_be_required'].every(x=>p.risks.includes(x))||![['package','global_rules','skills','credentials','tasks','artifacts','other_plugins'],['package','global_rules','skills','credentials','sessions','tasks','artifacts','other_declared_plugins']].some(x=>JSON.stringify(p.retained)===JSON.stringify(x))):(p.action!=='record_observation_only'||p.scope!=='ledger_only'||p.originalOutcomeProven!==false||p.operationId!==c.receipt?.id))invalid();
    emit({plan:p});
   }return true;
  }catch(e){emit({fresh:false,error:/^ONBOARDING_[A-Z_]+$/.test(e?.message)?e.message:'ONBOARDING_UNAVAILABLE'});return false;}
  finally{emit({busy:false});}
 }
 return {get:()=>s,act,cancel:()=>{if(!s.busy)emit({plan:null});}};
}
