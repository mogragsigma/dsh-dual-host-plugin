// Persist only a diagnostic reference, never an authorization or executable plan.
const KEY='dsh-self-remove-reference-v1';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const int=v=>Number.isSafeInteger(v)&&v>=0;
const phases=['intent','unknown','not_dispatched','saved_restart_required','manager_applied','manager_rejected','reconciled'];
const receipt=v=>v===null||v&&uuid(v.id)&&phases.includes(v.state)&&typeof v.version==='string'&&v.version.length<=128&&int(v.createdAt)&&int(v.updatedAt)&&v.updatedAt>=v.createdAt&&(v.state!=='reconciled'||v.review?.originalOutcomeProven===false&&v.review?.bundleEnabled===true&&int(v.review?.at));
const pending=r=>!!r&&['intent','unknown'].includes(r.state);
const scoped=v=>v&&v.hostStopped===false&&v.packageRemoved===false&&v.rulesOrSkillsRemoved===false&&v.executionAuthorized===false&&v.automaticRestart===false;
const valid=v=>scoped(v)&&v.contract===1&&v.queryContract===1&&v.scope==='current_host_own_bundle_dependency_only'&&v.externalRecovery==='official_reinstall_verified_source'&&uuid(v.instanceId)&&int(v.revision)&&int(v.historyCount)&&v.historyCount<=32&&typeof v.operationInFlight==='boolean'&&receipt(v.receipt)&&v.pending===pending(v.receipt);
export function selfRemoveActions(s,contract,now=Date.now()){
 const c=s.current,ready=contract===1&&!s.busy&&s.fresh&&!s.uncertain&&!s.storageError&&valid(c)&&!c.operationInFlight;
 return {remove:!!(ready&&!c.pending&&c.receipt?.state!=='saved_restart_required'),review:!!(ready&&c.pending),confirm:!!(ready&&s.plan?.canApply===true&&s.plan.expiresAt>now)};
}
export function selfRemoveRecoveryGuide(operationId,version){
 const v=typeof version==='string'&&/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)&&version.length<=128?version:'以刚才的计划及官方清单为准';
 return `大肥鱼 · 本端插件包移除恢复说明\n\n仅适用于你刚才操作的同一台 Host、同一 profile。\n目标包：@mogragsigma/dsh-dual-host-plugin\n计划版本：${v}\n\n1. 先保留该版本已验证的插件包或原安装来源。本候选是未发布的私有包，不能假定市场可按包名下载；没有可用包源，请取消移除。\n2. 移除会经 DSH 官方包管理卸载本包；其未使用的 profile 依赖可能被修剪。面板及回执通道可能立即消失；不证明请求成功，不表示 Host 已停止。不要重复发送。\n3. 需要恢复时，在同一 Host/profile 使用 DSH 官方插件管理或官方 CLI，从保留的已验证包源重新安装，不覆盖用户规则或数据。不要直接改写 node_modules。若官方要求重启，保存草稿、核验空闲并单独确认最后到达输入可能中止的风险。\n4. 重新进入配置导览 → 维护会话 → 移除插件包，点击“手动核对移除账本”。原进程退出后才可另行确认补记当前观察；不追认原请求成功、不自动重发。\n5. 组件维护旧记录的收尾、自有任务入口恢复分别确认；不重放旧任务。全局规则、Skill、凭据、会话、任务、成果及备份保留；不是完整清理数据或释放 ECS，不授权开发或发布。\n\n诊断引用：${uuid(operationId)?operationId:'尚未生成；恢复后手动查询当前账本'}\n此说明不含密钥、访问地址、批准指纹或可重放命令。\n`;
}
export function createSelfRemoveFlow(request,changed,contract,storage,now=Date.now){
 let reference=null,storageError=false;
 try{if(!storage)throw Error();const v=JSON.parse(storage.getItem(KEY)??'null');if(v!==null){if(!v||Object.keys(v).join()!=='operationId'||!uuid(v.operationId))throw Error();reference=v;}}catch{storageError=true;}
 let s={current:null,receipt:null,reference,storageError,plan:null,busy:false,fresh:false,uncertain:!!reference||storageError,error:'',observedAt:null};
 const emit=p=>{s={...s,...p};changed(s);},invalid=()=>{throw Error('ONBOARDING_TRANSPORT_RESPONSE_INVALID');};
 function observe(v,ref){
  if(!valid(v))invalid();if(ref&&(v.requestedOperationId!==ref.operationId||!Object.hasOwn(v,'requestedReceipt')||!receipt(v.requestedReceipt)||v.requestedReceipt&&v.requestedReceipt.id!==ref.operationId))invalid();
  const r=ref?v.requestedReceipt:v.receipt;return {current:v,receipt:r,fresh:true,uncertain:s.storageError||!!ref&&!r,observedAt:now()};
 }
 async function act(action,confirmed=false,guideSaved=false){
  if(s.busy||contract!==1||!['refresh','remove','review','confirm'].includes(action))return false;
  const g=selfRemoveActions(s,contract,now()),p=s.plan;if(action!=='refresh'&&(!g[action]||action==='confirm'&&(confirmed!==true||p.action==='remove_own_bundle'&&guideSaved!==true)))return false;
  emit({busy:true,error:'',plan:null});
  try{
   if(action==='refresh')emit(observe(await request('self_remove_status',s.reference??{}),s.reference));
   else if(action==='confirm'){
    const ref={operationId:p.action==='remove_own_bundle'?p.id:p.operationId};
    try{storage.setItem(KEY,JSON.stringify(ref));if(storage.getItem(KEY)!==JSON.stringify(ref))throw Error();}catch{throw Error('ONBOARDING_SELF_REMOVE_REFERENCE_UNAVAILABLE');}
    emit({reference:ref,uncertain:true,fresh:false});
    const v=await request('self_remove_'+(p.action==='remove_own_bundle'?'apply':'reconcileApply'),{id:p.id,fingerprint:p.fingerprint,confirm:true,acceptRisk:true});
    if(!valid(v)||v.instanceId!==p.instanceId||v.revision<=p.revision||v.receipt?.id!==ref.operationId||p.action==='record_observation_only'&&(v.managerActions!==0||v.receipt.state!=='reconciled'))invalid();
    emit(observe({...v,requestedOperationId:ref.operationId,requestedReceipt:v.receipt},ref));
   }else{
    const c=s.current,p=await request('self_remove_'+(action==='remove'?'preview':'reconcilePreview'),{});
    if(p.contract!==1||p.instanceId!==c.instanceId||p.revision!==c.revision||!uuid(p.id)||!hash(p.fingerprint)||!int(p.expiresAt)||p.expiresAt<=now()||p.canApply!==true||p.hostStopAuthorized!==false||p.automaticRestart!==false)invalid();
    if(action==='remove'?(p.action!=='remove_own_bundle'||p.scope!=='current_host_own_bundle_dependency_only'||typeof p.version!=='string'||!Array.isArray(p.risks)||!['own_ui_and_rpc_may_disappear','late_native_or_im_input_may_abort','restart_may_be_required','official_package_manager_may_prune_unused_profile_dependencies','verified_source_required_to_reinstall'].every(x=>p.risks.includes(x))||JSON.stringify(p.retained)!==JSON.stringify(['global_rules','skills','credentials','sessions','tasks','artifacts','other_declared_plugins'])||p.dataDeletionAuthorized!==false):(p.action!=='record_observation_only'||p.scope!=='ledger_only'||p.originalOutcomeProven!==false||p.operationId!==c.receipt?.id))invalid();
    emit({plan:p});
   }return true;
  }catch(e){emit({fresh:false,error:/^ONBOARDING_[A-Z_]+$/.test(e?.message)?e.message:'ONBOARDING_UNAVAILABLE'});return false;}
  finally{emit({busy:false});}
 }
 return {get:()=>s,act,cancel:()=>{if(!s.busy)emit({plan:null});}};
}
