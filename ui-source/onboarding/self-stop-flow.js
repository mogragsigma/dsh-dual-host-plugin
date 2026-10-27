// A browser stores a query reference only, never consent or a runnable plan.
const KEY='dsh-self-stop-reference-v1';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const int=v=>Number.isSafeInteger(v)&&v>=0;
const version=v=>typeof v==='string'&&/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(v)&&v.length<=128;
const scope='current_host_public_app_exit_with_loss_risk';
const receipt=v=>v===null||v&&uuid(v.id)&&['intent','not_dispatched','reconciled'].includes(v.state)&&version(v.version)&&int(v.createdAt)&&int(v.updatedAt)&&v.updatedAt>=v.createdAt&&(v.state!=='reconciled'||v.review?.ownerProcessExited===true&&v.review?.requestOutcomeProven===false&&uuid(v.review?.observerInstanceId)&&int(v.review?.at));
const pending=r=>r?.state==='intent';
const valid=v=>v&&v.contract===1&&v.queryContract===1&&v.scope===scope&&uuid(v.instanceId)&&int(v.revision)&&int(v.historyCount)&&v.historyCount<=32&&typeof v.operationInFlight==='boolean'&&typeof v.stopCapabilityAvailable==='boolean'&&receipt(v.receipt)&&v.pending===pending(v.receipt)&&v.hostStopped===false&&v.currentHostRunning===true&&v.automaticStop===false&&v.automaticRestart===false&&v.ingressFrozen===false&&v.externalSupervisorControlled===false&&v.executionAuthorized===false&&v.dataDeletionAuthorized===false;
export function selfStopActions(s,contract,allowStop,now=Date.now()){
 const c=s.current,ready=contract===1&&!s.busy&&s.fresh&&!s.uncertain&&!s.storageError&&valid(c)&&!c.operationInFlight;
 return {stop:!!(ready&&allowStop&&c.stopCapabilityAvailable&&!c.pending),review:!!(ready&&c.pending),confirm:!!(ready&&s.plan?.canApply===true&&s.plan.expiresAt>now&&(s.plan.action==='record_exit_observation_only'||allowStop&&c.stopCapabilityAvailable))};
}
export function selfStopRecoveryGuide(operationId,currentVersion){
 return `大肥鱼 · 本端 Host 停机恢复说明\n\n仅适用于当前这台 Host、当前 profile；不会停止另一端。\n插件版本：${version(currentVersion)?currentVersion:'以当前计划为准'}\n\n1. 停机前保存所有草稿和本说明，确认知道此 Host 原有的启动方式。插件只请求官方 appExit，不清空配置、规则、Skill、凭据、任务、队列或成果，不释放 ECS。\n2. 本插件界面和回执连接可能消失；断开不是停机成功证明。最后时刻到达的原生或 IM 输入可能中止；外部守护程序可能重启，原生输入和第三方 IM 不受自有恢复屏障控制。未知结果不要重复发送停机。\n3. 若需要重新启动，由你另行确认并使用原有官方启动方式。不要重装、覆盖配置或删除数据来消除待核对状态。本页不自动启动。\n4. 返回配置导览 → 维护会话 → 停止本端 Host，手动核对停机账本。原进程确已退出后，另行确认仅补记退出观察；不追认退出一定由原请求造成，也不自动恢复任务。\n5. 在组件维护区单独预览并收尾旧维护记录，再单独确认恢复自有受理入口；不重发历史任务。\n\n诊断引用：${uuid(operationId)?operationId:'尚未生成；恢复后手动查询当前账本'}\n本说明不含访问 token、密钥、批准指纹或可重放命令。\n`;
}
export function createSelfStopFlow(request,changed,contract,allowStop,storage,now=Date.now){
 let reference=null,storageError=false;
 try{if(!storage)throw Error();const v=JSON.parse(storage.getItem(KEY)??'null');if(v!==null){if(!v||Object.keys(v).join()!=='operationId'||!uuid(v.operationId))throw Error();reference=v;}}catch{storageError=true;}
 let s={current:null,receipt:null,reference,storageError,plan:null,busy:false,fresh:false,uncertain:!!reference||storageError,error:'',observedAt:null};
 const emit=p=>{s={...s,...p};changed(s);},invalid=()=>{throw Error('ONBOARDING_TRANSPORT_RESPONSE_INVALID');};
 function observe(v,ref){
  if(!valid(v))invalid();if(ref&&(v.requestedOperationId!==ref.operationId||!Object.hasOwn(v,'requestedReceipt')||!receipt(v.requestedReceipt)||v.requestedReceipt&&v.requestedReceipt.id!==ref.operationId))invalid();
  const r=ref?v.requestedReceipt:v.receipt;return {current:v,receipt:r,fresh:true,uncertain:s.storageError||!!ref&&!r,observedAt:now()};
 }
 async function act(action,confirmed=false,guideSaved=false){
  if(s.busy||contract!==1||!['refresh','stop','review','confirm'].includes(action))return false;
  const g=selfStopActions(s,contract,allowStop,now()),p=s.plan;if(action!=='refresh'&&(!g[action]||action==='confirm'&&(confirmed!==true||p.action==='request_current_host_exit'&&guideSaved!==true)))return false;
  emit({busy:true,error:'',plan:null});
  try{
   if(action==='refresh')emit(observe(await request('self_stop_status',s.reference??{}),s.reference));
   else if(action==='confirm'){
    const ref={operationId:p.action==='request_current_host_exit'?p.id:p.operationId};
    try{storage.setItem(KEY,JSON.stringify(ref));if(storage.getItem(KEY)!==JSON.stringify(ref))throw Error();}catch{throw Error('ONBOARDING_SELF_STOP_REFERENCE_UNAVAILABLE');}
    emit({reference:ref,uncertain:true,fresh:false});
    const v=await request('self_stop_'+(p.action==='request_current_host_exit'?'apply':'reconcileApply'),{id:p.id,fingerprint:p.fingerprint,confirm:true,acceptRisk:true});
    if(!valid(v)||v.instanceId!==p.instanceId||v.revision<=p.revision||v.receipt?.id!==ref.operationId||p.action==='record_exit_observation_only'&&(v.exitRequests!==0||v.receipt.state!=='reconciled'))invalid();
    emit(observe({...v,requestedOperationId:ref.operationId,requestedReceipt:v.receipt},ref));
   }else{
    const c=s.current,p=await request('self_stop_'+(action==='stop'?'preview':'reconcilePreview'),{});
    if(p.contract!==1||p.instanceId!==c.instanceId||p.revision!==c.revision||!uuid(p.id)||!hash(p.fingerprint)||!int(p.expiresAt)||p.expiresAt<=now()||p.canApply!==true||p.automaticRestart!==false)invalid();
    if(action==='stop'?(p.action!=='request_current_host_exit'||p.scope!==scope||!version(p.version)||p.hostStopAuthorized!==true||p.automaticStop!==false||p.dataDeletionAuthorized!==false||!Array.isArray(p.risks)||!['late_native_or_im_input_may_abort','own_ui_and_rpc_may_disappear','external_supervisor_may_restart','native_inputs_not_persistently_fenced','official_shutdown_may_force_exit'].every(x=>p.risks.includes(x))||JSON.stringify(p.retained)!==JSON.stringify(['package','global_rules','skills','credentials','sessions','tasks','artifacts','backups'])):(p.action!=='record_exit_observation_only'||p.scope!=='ledger_only'||p.ownerProcessExited!==true||p.currentHostRunning!==true||p.requestOutcomeProven!==false||p.operationId!==c.receipt?.id))invalid();
    emit({plan:p});
   }return true;
  }catch(e){emit({fresh:false,error:/^ONBOARDING_[A-Z_]+$/.test(e?.message)?e.message:'ONBOARDING_UNAVAILABLE'});return false;}
  finally{emit({busy:false});}
 }
 return {get:()=>s,act,cancel:()=>{if(!s.busy)emit({plan:null});}};
}
