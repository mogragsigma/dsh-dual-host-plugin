// Browser controller: explicit clicks only. Mount/re-entry reads local receipts;
// network observations and every write remain separate user actions.
export const cloudStateLabels={reclamation_needs_review:'运行时回收待核对，请手动查询',runtime_reclaimed:'运行时已回收，数据与历史保留',plugin_uninstalled:'自有能力已卸载，数据保留',uninstall_needs_review:'卸载待核对，禁止重启',stop_outcome_unknown:'停止结果待核对',cleanup_running:'正在按登记清单清理',cleanup_pending:'清理已中断，待确认继续',not_started:'尚未执行',preparing:'准备文件中',prepared:'安装文件已准备',needs_review:'需核对，未自动重试',rolling_back:'正在回滚／结果待核对',rolled_back:'已回滚',retiring:'隔离处理中',retired:'旧请求已隔离，保留现场',launching:'启动安装进程',installing:'安装固定依赖',configuring:'保护性配置规则与 Skill',starting_host:'正在启动独立 Host',restart_needs_review:'重新启动已中断，需核对',restarting:'重新启动原生 Host',restart_outcome_unknown:'重新启动结果待核对',host_ready:'原生 Host 就绪',host_stopped:'原生 Host 已停止',runtime_ready:'依赖已安装',failed:'失败，保留现场',stopped:'安装进程已停止',outcome_unknown:'发送结果待核对',rollback_outcome_unknown:'回滚结果待核对'};
export function cloudRecovery(s){
 const source=s.source,remote=source?.remote,b=s.binding;
 const fenced=source?.state==='retired'&&typeof source.root==='string'&&remote?.state==='retired'&&remote.operationId===source.operationId&&remote.root===source.root&&remote.barrier==='regular-file-no-replace'&&remote.originalRequestIsolated===true&&remote.originalProcessTerminated===false;
 const bound=b?.configured===true&&Number.isSafeInteger(b.revision)&&b.revision>0&&typeof b.installationId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(b.installationId);
 return {fenced,replacement:!!(fenced&&bound&&!source.root.endsWith('/host-'+b.installationId)),originalBinding:!!(fenced&&bound&&source.root.endsWith('/host-'+b.installationId))};
}
const repairTargetUnavailable=r=>['plugin_uninstalled','runtime_reclaimed','uninstall_needs_review','reclamation_needs_review'].includes(r?.state);
const repairInventoryPending=r=>r?.state==='not_started'||r?.inventoryCount===0&&(r.workerActive===true||r.childActive===true);
const validResumePolicy=p=>p?.contract===1&&p.nativeWorkMayResume===true&&p.imMayReconnect===true&&p.configurationPreserved===true&&p.automaticTaskApproval===false&&p.automaticRetry===false&&p.requiresExplicitAcknowledgement===true;
const validStopRisk=p=>p?.contract===1&&p.lateNativeInputMayAbort===true&&p.imInFlightMayAbort===true&&p.ownQueuesRetained===true&&p.ingressFrozen===false&&p.automaticStop===false&&p.requiresExplicitAcknowledgement===true;
export function cloudActions(s,{preparation=false,runtime=false}={},now=Date.now()){
 const recovery=cloudRecovery(s),observed=s.fresh&&!s.uncertain&&now-s.observedAt<60000;
 const idle=!s.busy&&s.loaded,terminal=['not_started','rolled_back'].includes(s.source?.state)||recovery.replacement&&observed;
 const sourcePrepared=s.fresh&&s.source?.state==='prepared',prepared=sourcePrepared&&now-s.observedAt<60000,r=s.runtime,active=r&&(r.workerActive||r.childActive||r.hostActive||r.restartLauncherActive||r.cleanupActive);
 const stopPending=r?.state==='stop_outcome_unknown'||r?.stop?.reconcileRequired===true;
 const stopped=r&&r.workerActive===false&&r.childActive===false&&r.hostActive===false&&r.restartLauncherActive!==true&&r.cleanupActive!==true;
 const repairReady=idle&&runtime&&s.runtimeRecorded&&!repairInventoryPending(r)&&!repairTargetUnavailable(r)&&prepared&&!s.uncertain&&s.repairCapability?.supported,repairPending=s.repairPending===true;
 const actions={load:!s.busy,refresh:idle,preview:idle&&preparation&&terminal&&!s.uncertain,
  retire:idle&&preparation&&observed&&['needs_review','retiring'].includes(s.source?.state)&&s.source?.remote?.state==='absent',
  new_target:idle&&preparation&&observed&&recovery.originalBinding,
  // A successful plan has its own five-minute approval window. Elapsed observation
  // time does not invalidate it; failed refresh/load still clears the plan.
  stage:idle&&preparation&&!s.uncertain&&(terminal||recovery.replacement&&s.fresh)&&s.plan?.canStage===true&&s.plan.expiresAt>now,
  runtime_preview:idle&&runtime&&prepared&&!s.runtimeRecorded&&r?.state==='not_started',
  runtime_start:idle&&runtime&&sourcePrepared&&!s.uncertain&&!s.runtimeRecorded&&!!s.runtimePlan&&s.runtimePlan.expiresAt>now,
  runtime_restart_preview:idle&&runtime&&!stopPending&&prepared&&!s.uncertain&&stopped&&r.restartSupported&&r.restartConsentContract===1&&['host_stopped','failed','stopped'].includes(r.state),
  runtime_restart:idle&&runtime&&!stopPending&&sourcePrepared&&!s.uncertain&&stopped&&r.restartSupported&&r.restartConsentContract===1&&validResumePolicy(s.restartPlan?.resumePolicy)&&s.restartPlan?.expiresAt>now,
  runtime_reconcile_restart:idle&&runtime&&!stopPending&&prepared&&stopped&&r?.state==='restart_needs_review',
  runtime_stop_preview:idle&&runtime&&!stopPending&&r?.cleanupActive!==true&&prepared&&s.runtimeRecorded&&r?.stopPlanSupported===true&&!!active,
  runtime_stop:idle&&runtime&&!stopPending&&prepared&&!s.uncertain&&s.runtimeRecorded&&(r?.hostActive!==true||r?.hostStopSupported===true&&r.hostStopConsentContract===1&&s.stopPlan?.scope==='owned_host_with_loss_risk'&&validStopRisk(s.stopPlan.risk))&&s.stopPlan?.canApply===true&&s.stopPlan.expiresAt>now,
  runtime_stop_reconcile:idle&&runtime&&prepared&&r?.stop?.reconcileRequired===true&&r.stop.activeInstallerMembers===0&&r.stop.hostActive!==true,
  runtime_rollback:idle&&runtime&&prepared&&s.runtimeRecorded&&stopped&&r?.stop?.reconcileRequired!==true&&['host_stopped','runtime_ready','failed','stopped','needs_review'].includes(r?.state),
  runtime_rollback_resume:idle&&runtime&&!stopPending&&prepared&&s.runtimeRecorded&&stopped&&r?.state==='cleanup_pending'&&r.cleanupSupported===true&&typeof r.cleanupFingerprint==='string',
  runtime_reconcile_rollback:idle&&runtime&&!stopPending&&prepared&&s.runtimeRecorded&&r?.state==='rollback_outcome_unknown',
  runtime_repair_preview:repairReady&&!repairPending&&!stopPending&&stopped,
  runtime_repair_apply:idle&&runtime&&!repairTargetUnavailable(r)&&sourcePrepared&&!s.uncertain&&!repairPending&&!stopPending&&stopped&&s.repairCapability?.supported&&s.repairPlan?.canApply===true&&s.repairPlan.expiresAt>now,
  runtime_repair_recover:repairReady&&!stopPending&&stopped&&s.repairStatus?.repair?.recoveryRequired===true&&s.repairStatus.repair.id===s.repairOriginalId,
  runtime_repair_verify:s.repairStatus?.repair?.activationSupported!==false&&repairReady&&!repairPending&&!stopPending&&s.repairCapability?.activationSupported&&r?.nativeHostReady===true&&r.hostActive===true&&s.repairStatus?.repair?.state==='committed',
  rollback:idle&&prepared&&(!s.runtimeRecorded&&r?.state==='not_started'||r?.state==='rolled_back')};
 if(repairPending)for(const key of ['runtime_start','runtime_restart_preview','runtime_restart','runtime_reconcile_restart','runtime_stop_preview','runtime_stop','runtime_stop_reconcile','runtime_rollback','runtime_rollback_resume','runtime_reconcile_rollback','rollback'])actions[key]=false;
 return actions;
}
export function createCloudFlow(request,notify,capabilities={},now=Date.now){
 let s={loaded:false,busy:false,fresh:false,uncertain:false,source:null,binding:null,runtime:null,runtimeRecorded:false,plan:null,runtimePlan:null,restartPlan:null,stopPlan:null,repairPlan:null,repairFresh:false,error:null,observedAt:null,optionalIm:false,repairCapability:null,repairStatus:null,repairPending:false,repairOriginalId:null},live=true;
 const emit=change=>{s={...s,...change};if(live)notify(s);};
 async function record(source){
  if(source.state!=='prepared'||!capabilities.runtime)return {runtime:null,runtimeRecorded:false,repairCapability:null,repairStatus:null,repairPlan:null,repairPending:false,repairOriginalId:null,repairFresh:false};
  const r=await request('cloud_runtime',{action:'runtime_record',operationId:source.operationId});
  return {runtime:r.receipt??{state:r.recorded?'outcome_unknown':'not_started'},runtimeRecorded:r.recorded,repairCapability:r.pluginRepair??null,repairStatus:r.pluginRepair?.receipt??null,repairPending:r.pluginRepair?.pending===true,repairOriginalId:r.pluginRepair?.id??null,repairFresh:false};
 }
 const mutating=new Set(['runtime_repair_apply','runtime_repair_recover','stage','retire','new_target','runtime_start','runtime_stop','runtime_stop_reconcile','runtime_rollback','runtime_reconcile_rollback','runtime_restart','runtime_reconcile_restart','runtime_rollback_resume','rollback']);
 async function act(action,confirmed=false){
  if(!live||s.busy)return false;
  if(!cloudActions(s,capabilities,now())[action]){emit({error:'ACTION_REQUIRES_REFRESH'});return false;}
  if(mutating.has(action)&&confirmed!==true){emit({error:'CONFIRMATION_REQUIRED'});return false;}
  emit({busy:true,error:null});
  try{
   if(action==='load'){
    const source=await request('cloud_operation_status',{refresh:false});emit({source,binding:source.state==='retired'?await request('ssh_status',{}):null,...await record(source),loaded:true,fresh:false,plan:null,runtimePlan:null,restartPlan:null,stopPlan:null,repairPlan:null,repairFresh:false});
   }else if(action==='refresh'){
    // Invalidate both confirmations BEFORE I/O. A failed refresh must not leave
    // an earlier ready observation or a reusable approval on screen.
    emit({fresh:false,binding:null,plan:null,runtimePlan:null,restartPlan:null,stopPlan:null,repairPlan:null,repairFresh:false});
    const source=await request('cloud_operation_status',{refresh:true});emit({source,runtime:null,runtimeRecorded:false});
    if(source.state==='retired')emit({binding:await request('ssh_status',{})});
    if(source.state==='prepared'&&capabilities.runtime){
     const runtime=await request('cloud_runtime',{action:'runtime_status',operationId:source.operationId});
     const recorded=await record(source);emit({...recorded,runtime});
     // An uninstall/reclamation transaction makes repair unavailable, including
     // interrupted removal. Its cached
     // repair history remains visible, but querying that target now is rejected
     // by the authoritative backend and must not block read-only stop evidence.
     if(repairTargetUnavailable(runtime)&&!(runtime.managedRestartBlocked===true&&runtime.hostActive===false&&runtime.childActive===false&&runtime.workerActive===false&&runtime.restartLauncherActive!==true&&runtime.cleanupActive!==true))throw Error('ONBOARDING_TRANSPORT_RESPONSE_INVALID');
     // Archive capability is not runtime existence. Before the first start there
     // is no repair inventory to query; the installer publishes it on completion.
     // Preserve unresolved repair intent: a
     // conflicting not-started observation must not hide its error or unlock start.
     if(recorded.repairCapability?.supported&&!repairTargetUnavailable(runtime)&&(!repairInventoryPending(runtime)||recorded.repairPending)){const repairStatus=await request('cloud_runtime',{action:'runtime_repair_status',operationId:source.operationId});emit({repairStatus,repairPending:repairStatus.state==='repair_outcome_unknown'||repairStatus.repair?.recoveryRequired===true,repairOriginalId:repairStatus.originalRepairId??repairStatus.repair?.id??recorded.repairOriginalId,repairFresh:true});}
    }else if(source.state==='prepared')emit({runtime:{state:'not_started'}});
    emit({fresh:true,uncertain:false,observedAt:now()});
   }else if(action==='preview'){
    emit({plan:null,runtimePlan:null,restartPlan:null,stopPlan:null,repairPlan:null,repairFresh:false});const b=await request('ssh_status',{});if(!b.configured)throw Error('ONBOARDING_SSH_NOT_BOUND');
    emit({plan:await request('cloud_preview',{expectedRevision:b.revision}),uncertain:false});
   }else if(action==='stage'){
    const p=s.plan;emit({plan:null,fresh:false,uncertain:true});
    const source=await request('cloud_stage',{id:p.id,fingerprint:p.fingerprint,confirm:true});emit({source,runtime:null,runtimeRecorded:false,uncertain:source.state!=='prepared'});
   }else if(action==='retire'){
    const source=s.source;emit({fresh:false,uncertain:true,plan:null,runtimePlan:null,restartPlan:null,stopPlan:null,repairPlan:null,repairFresh:false});
    const done=await request('cloud_retire',{operationId:source.operationId,expectedRevision:source.revision,confirm:true});
    emit({source:done,binding:null,uncertain:done.state!=='retired'});
   }else if(action==='new_target'){
    const source=s.source,binding=s.binding;emit({fresh:false,uncertain:true,plan:null,runtimePlan:null,restartPlan:null,stopPlan:null,repairPlan:null,repairFresh:false});
    const next=await request('cloud_new_target',{operationId:source.operationId,expectedBindingRevision:binding.revision,confirm:true});
    // Never replace the old receipt with a fabricated not_started state. A lost
    // acknowledgement is reconciled by reading the binding, not by allocating twice.
    emit({binding:next,uncertain:false});
   }else if(action==='rollback'){
    const source=s.source;emit({fresh:false,uncertain:true});const done=await request('cloud_rollback',{operationId:source.operationId,expectedRevision:source.revision,confirm:true});
    emit({source:done,runtime:null,runtimeRecorded:false,uncertain:done.state!=='rolled_back'});
   }else{
    const args={action,operationId:s.source.operationId};
    if(mutating.has(action))args.confirm=true;
    if(action==='runtime_repair_apply'){args.repairId=s.repairPlan.id;args.fingerprint=s.repairPlan.fingerprint;}
    if(action==='runtime_repair_recover')args.repairId=s.repairOriginalId;
    if(action==='runtime_repair_verify')args.repairId=s.repairStatus.repair.id;
    if(action==='runtime_preview'&&s.optionalIm)args.im=true;
    if(action==='runtime_start'){args.fingerprint=s.runtimePlan.fingerprint;if(s.runtimePlan.optionalIm)args.im=true;}
    if(action==='runtime_restart'){args.fingerprint=s.restartPlan.fingerprint;args.acknowledgeNativeResume=true;}
    if(action==='runtime_stop'){args.stopPlan=s.stopPlan.stopPlan;if(args.stopPlan.schema===2)args.acknowledgeNativeInterruption=true;}
    if(action==='runtime_stop_reconcile')args.stopPlan=s.runtime.stop.stopPlan;
    if(action==='runtime_rollback_resume')args.fingerprint=s.runtime.cleanupFingerprint;
    if(mutating.has(action))emit({fresh:false,uncertain:true,runtimePlan:null,restartPlan:null,stopPlan:null,repairPlan:null,repairFresh:false});
    if(['runtime_repair_apply','runtime_repair_recover'].includes(action))emit({repairPending:true,repairOriginalId:args.repairId});
    const result=await request('cloud_runtime',args);
    if(action==='runtime_repair_preview'){if(!Array.isArray(result.changes)||result.scope!=='stopped_owned_plugin_files_only')throw Error('ONBOARDING_TRANSPORT_RESPONSE_INVALID');emit({repairPlan:result});}
    else if(['runtime_repair_apply','runtime_repair_recover','runtime_repair_verify'].includes(action)){const pending=result.state==='repair_outcome_unknown'||result.repair?.recoveryRequired===true;emit({repairStatus:result,repairFresh:true,repairPending:pending,uncertain:pending,repairOriginalId:result.originalRepairId??result.repair?.id??args.repairId});}
    else if(action==='runtime_preview'){if(s.optionalIm?(result.optionalIm?.package!=='@xmanrui/dsh-im'||result.optionalIm?.version!=='5.0.3'):!!result.optionalIm)throw Error('ONBOARDING_CLOUD_RUNTIME_OPTIONAL_IM_UNSUPPORTED');emit({runtimePlan:{...result,expiresAt:now()+300000}});}
    else if(action==='runtime_stop_preview')emit({stopPlan:result});
    else if(action==='runtime_restart_preview'){if(!validResumePolicy(result.resumePolicy))throw Error('ONBOARDING_TRANSPORT_RESPONSE_INVALID');emit({restartPlan:{...result,expiresAt:now()+300000}});}
    else emit({runtime:result,runtimeRecorded:true,uncertain:!['rolled_back','host_stopped','stopped','launching','installing','host_ready'].includes(result.state)});
   }
   return true;
  }catch(e){emit({fresh:false,plan:null,runtimePlan:null,restartPlan:null,stopPlan:null,repairPlan:null,repairFresh:false,uncertain:true,error:/^ONBOARDING_[A-Z_]+$/.test(e.message)?e.message:'OBSERVATION_UNCONFIRMED'});return false;}
  finally{emit({busy:false});}
 }
 return {act,get:()=>s,selectIm:enabled=>{if(typeof enabled!=='boolean'||!capabilities.optionalIm||s.busy||s.runtimeRecorded)return false;emit({optionalIm:enabled,runtimePlan:null,restartPlan:null,stopPlan:null,repairPlan:null,repairFresh:false,error:null});return true;},invalidate:()=>emit({fresh:false,plan:null,runtimePlan:null,restartPlan:null,stopPlan:null,repairPlan:null,repairFresh:false}),resume:()=>{live=true;},dispose:()=>{live=false;}};
}
