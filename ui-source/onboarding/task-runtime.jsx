import React,{useEffect,useRef,useState} from 'react';
import {Panel,Button,InfoRow,Callout,CheckRow} from './components';
const states={active:'受理已启用 · 不执行任务',disabled:'已停用 · 数据保留',not_configured:'尚未启用',activation_pending:'授权已记录 · 尚未启动',needs_review:'需核对 · 不自动重试'};
const phases={not_started:'尚无本轮操作',sending:'发送意图已保存 · 待核对',needs_review:'结果未知 · 不重发',recovering:'关闭结果待核对',applied:'原授权回执已确认',closed:'原操作已关闭或版本已推进'};
const errors={ONBOARDING_TASK_RUNTIME_PAIR_WORKER_DISABLE_REQUIRED:'请先停用只读执行，再变更双端配对；原队列和数据保留。',ONBOARDING_TASK_RUNTIME_AUTHORIZATION_REVIEW:'授权存储结果需核对；自有运行时已关闭，不会继续按不确定授权执行。',ONBOARDING_TASK_RUNTIME_WORKER_PRESET_REVIEW:'只读 worker 的原生预设未通过加载核验，未启动调度。',ONBOARDING_TASK_RUNTIME_PAIR_REVOKE_REQUIRED:'双端仍有配对授权，请先在本地直连面板撤销配对，再停用受理。',ONBOARDING_TASK_RUNTIME_RECOVERY_REQUIRED:'原请求结果尚未确认，请先刷新原回执；不能用新计划覆盖。',ONBOARDING_TASK_RUNTIME_BUSY:'受理器或任务尚未空闲。未停用，请稍后手动核对。',ONBOARDING_TASK_RUNTIME_PLAN_EXPIRED:'计划已过期或已消耗；若点过确认，请先核对回执。',ONBOARDING_TASK_RUNTIME_ALREADY_APPLIED:'原请求已获确认，请刷新查看实际运行状态，不必关闭或重发。',ONBOARDING_TASK_RUNTIME_PATH_REVIEW:'受管目录或文件归属需核对，不会自动覆盖或放宽权限。',ONBOARDING_CLOUD_TASK_RUNTIME_UNSUPPORTED:'旧云端归档不支持这个合同。保留原环境，不替换旧控制器。',ONBOARDING_CLOUD_HANDOFF_TASK_RUNTIME_UNSUPPORTED:'目标不支持受理启停和恢复合同，不回退旧接口。',ONBOARDING_CLOUD_HANDOFF_HOST_NOT_READY:'云端 Host 尚未就绪，请先手动核对安装与进程状态。'};
export function TaskRuntime({request,cloud=false}){
 const [state,setState]=useState(null),[plan,setPlan]=useState(null),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[unknown,setUnknown]=useState(false),[error,setError]=useState('');
 const live=useRef(true),flight=useRef(false),prefix=cloud?'cloud_task_runtime_':'task_runtime_',side=cloud?'云端':'当前端';
 useEffect(()=>{live.current=true;request(prefix+'status',cloud?{refresh:false}:{}).then(v=>{if(live.current)setState(v);}).catch(()=>{if(live.current)setError('读取本端记录失败，请手动刷新核对。');});return()=>{live.current=false;};},[cloud]);
 const runtime=cloud?state?.runtime:state,op=cloud?state?.operation:null,waiting=unknown||cloud&&['sending','needs_review','recovering'].includes(op?.state);
 async function act(action,enabled,workerEnabled=false){
  if(flight.current)return;flight.current=true;setBusy(true);setError('');const p=plan;
  if(['apply','recoveryApply'].includes(action)){setPlan(null);setConfirm(false);setUnknown(true);}
  try{
   const args=action==='status'?(cloud?{refresh:true}:{}):action==='preview'?{enabled,workerEnabled}:action==='recoveryPreview'?{}:{id:p.id,fingerprint:p.fingerprint,confirm:true};
   if(action==='status'){setPlan(null);setConfirm(false);}
   const v=await request(prefix+action,args);if(!live.current)return;
   if(['preview','recoveryPreview'].includes(action)){setPlan({...v,recovery:action==='recoveryPreview'});setConfirm(false);}else{setState(v);setUnknown(false);}
  }catch(e){if(live.current){setError(errors[e.message]??'操作结果未确认，请核对原回执。不会自动重试、改投其他 Host 或启动任务。');if(action==='status')setState(v=>cloud&&v?{...v,runtime:null,freshness:'check_failed'}:null);}}
  finally{flight.current=false;if(live.current)setBusy(false);}
 }
 return <Panel className="connection-panel" title={side+'任务受理'} icon="cloud" sub="任务受理与只读后台执行分开授权；仓库写入仍关闭。">
  <InfoRow label="操作范围" value={cloud?'仅本导览绑定的 ECS，不改本端':'仅当前云端 Host，不操作其他设备'}/>
  <InfoRow label="当前受理状态" value={runtime?runtime.workerEnabled?'只读 worker 运行中 · 仓库写入关闭':states[runtime.state]??'待核对':'尚未查询目标端'}/>
  {runtime&&<><InfoRow label="只读后台执行" value={(runtime.workerDesiredEnabled?'已授权':'未授权')+' / '+(runtime.workerEnabled?'调度器已挂载':'未执行')}/><InfoRow label="授权与进程" value={(runtime.desiredEnabled?'授权已启用':'授权未启用')+' / '+(runtime.configured?'受理进程已挂载':'受理进程未挂载')}/><p className="fine-print">授权修订 {runtime.revision}。这是本次观察，不持续监控。</p></>}
  <div className="connection-actions" role="group" aria-label={side+'任务受理操作'}>
   <Button kind="primary" icon="cloud" disabled={busy||!!waiting||runtime?.configured} onClick={()=>act('preview',true)}>预览启用{side}受理</Button>
   <Button kind="secondary" icon="pause" disabled={busy||!!waiting||!runtime?.desiredEnabled} onClick={()=>act('preview',false)}>预览停用{side}受理</Button>
   <Button kind="secondary" icon="reset" disabled={busy} onClick={()=>act('status')}>手动刷新{side}受理</Button>
  </div>
  {runtime?.contract===4&&runtime?.configured&&<section className="connection-result worker-runtime" aria-label="只读后台执行">
   <h3>只读任务 Worker</h3>
   <p>独立后台执行，不占用入口会话。模型按每个任务选择；重启恢复同一检查点。停用会保留队列，重新启用后继续符合原授权的待执行任务。</p>
   <div className="connection-actions" role="group" aria-label="只读 worker 操作">
    <Button kind="primary" icon="cloud" disabled={busy||!!waiting||runtime.workerDesiredEnabled} onClick={()=>act('preview',true,true)}>预览启用只读执行</Button>
    <Button kind="secondary" icon="pause" disabled={busy||!!waiting||!runtime.workerDesiredEnabled} onClick={()=>act('preview',true,false)}>预览停用只读执行</Button>
   </div>
   <p className="fine-print">不开放 shell、任意文件、开发、commit、push 或发布。配对变更前先停用只读执行；受理和原生 DSH 不受该授权扩大。</p>
  </section>}
  {op&&<div className="connection-result" role="status"><InfoRow label="原操作回执" value={phases[op.state]??'待核对'}/><p className="fine-print">{state.freshness==='remote_checked'?'已手动查询目标端；授权确认与实际运行分开显示。':state.freshness==='check_failed'?'查询失败。历史回执不证明当前进程在线。':'本端缓存；尚未连接云端查询。'}</p></div>}
  {runtime?.error&&<p className="connection-error" role="status">{errors[runtime.error]??'授权与实际进程状态不一致，需要核对；不自动启动或修复。'}</p>}
  {cloud&&waiting&&<div className="connection-utility"><p>先核对原回执；仍无法确认时，可另行关闭旧请求并阻断迟到应用。保留当前授权、密钥和任务数据，不等于停用。</p><Button kind="soft" icon="shield" disabled={busy} onClick={()=>act('recoveryPreview')}>预览关闭未知受理操作</Button></div>}
  {plan&&<section className="connection-confirm" aria-label={side+'任务受理确认'}><h3>{plan.recovery?'关闭未知请求，保留当前状态':plan.workerEnabled?'确认启用只读执行':plan.enabled?'确认仅启用受理 · 只读执行关闭':'确认停用受理'}</h3>
   {!plan.recovery&&<InfoRow label="实际 Host" value={plan.target.name+' / '+plan.target.platform}/>}
   <Callout>{plan.recovery?'仅推进版本屏障或核对已推进版本。原请求若已成功，会报告成功而不是假报撤销。':plan.workerEnabled?'挂载本项目独立只读 worker，可按任务模型调用产生费用；重启后自动恢复已授权的只读队列和检查点。只向插件私有成果区写报告，不授权仓库写入、开发或提交推送。':plan.enabled?'只挂载本项目受理与仓库读取；停止只读调度并保留队列。不会启动 worker、调用模型、配对双端、写仓库或提交推送。':'仅在受理空闲时撤下本项目服务与工具，保留配置和任务数据；不关闭原生 DSH。'}</Callout>
   <CheckRow checked={confirm} disabled={busy} onChange={setConfirm} title={plan.workerEnabled&&!plan.recovery?'我同意只读模型执行、费用及重启恢复，不授权仓库写入':'我已核对范围，不新增模型执行或仓库写入授权'}/>
   <div className="connection-actions" role="group" aria-label={side+'受理最终确认'}><Button kind="primary" icon="check" disabled={busy||!confirm} onClick={()=>act(plan.recovery?'recoveryApply':'apply')}>{plan.recovery?'确认关闭未知受理操作':plan.workerEnabled?'确认启用只读执行':plan.enabled?'确认仅保留'+side+'受理':'确认停用'+side+'受理'}</Button><Button kind="secondary" disabled={busy} onClick={()=>{setPlan(null);setConfirm(false);}}>取消</Button></div>
  </section>}
  {error&&<p className="connection-error" role="alert">{error}</p>}
  <Callout>受理、模型接入、任务执行和 A2A 不是同一项授权。页面不自动刷新，也不表示六页配置已全部验收。</Callout>
 </Panel>;
}
