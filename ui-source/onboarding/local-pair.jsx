import React,{useEffect,useRef,useState} from 'react';
import {Panel,Button,InfoRow,Callout,CheckRow} from './components';
const phases={not_started:'尚未配对',sending:'发送意图已保存 · 待核对',needs_review:'结果未知 · 不重发',recovering:'关闭结果待核对',applied:'配对操作已确认',closed:'原操作已关闭或版本已推进'};
const errors={ONBOARDING_LOCAL_PAIR_OTHER_CONTROLLER:'该云端已绑定其他控制端。为保护历史邮箱，不会直接换绑。',ONBOARDING_LOCAL_PAIR_RECOVERY_REQUIRED:'原请求尚未核对，请先手动刷新；不能用新计划覆盖。',ONBOARDING_LOCAL_PAIR_BUSY:'本地传输尚在进行，请稍后手动核对。',ONBOARDING_LOCAL_PAIR_ALREADY_APPLIED:'原配对已获确认，请刷新查看，不需要重发或关闭。',ONBOARDING_LOCAL_PAIR_PLAN_EXPIRED:'预览已过期或已消耗；若点过确认，请先核对回执。',ONBOARDING_TASK_RUNTIME_PAIR_RUNTIME_NOT_READY:'请先确认云端任务受理已启用，再预览配对。',ONBOARDING_TASK_RUNTIME_PAIR_BUSY:'云端传输或受理尚未空闲，请稍后手动核对。',ONBOARDING_CLOUD_PAIR_UNSUPPORTED:'旧云端归档不支持受管配对。保留旧环境，不替换原控制器。',ONBOARDING_CLOUD_HANDOFF_HOST_NOT_READY:'云端尚未就绪，请先手动核对安装和进程状态。'};
export function LocalPair({request}){
 const [state,setState]=useState(null),[plan,setPlan]=useState(null),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[unknown,setUnknown]=useState(false),[error,setError]=useState('');const live=useRef(true),flight=useRef(false);
 useEffect(()=>{live.current=true;request('local_pair_status',{refresh:false}).then(v=>{if(live.current)setState(v);}).catch(()=>{if(live.current)setError('读取本地配对记录失败，请手动核对。');});return()=>{live.current=false;};},[]);
 const waiting=unknown||['sending','needs_review','recovering'].includes(state?.operation.state);
 async function act(action,enabled){
  if(flight.current)return;flight.current=true;setBusy(true);setError('');const p=plan;
  if(['apply','recoveryApply'].includes(action)){setPlan(null);setConfirm(false);setUnknown(true);}
  if(action==='status'){setPlan(null);setConfirm(false);}
  try{
   const args=action==='status'?{refresh:true}:action==='preview'?{enabled}:action==='recoveryPreview'?{}:{id:p.id,fingerprint:p.fingerprint,confirm:true};const v=await request('local_pair_'+action,args);if(!live.current)return;
   if(['preview','recoveryPreview'].includes(action)){setPlan({...v,recovery:action==='recoveryPreview'});setConfirm(false);}else{setState(v);setUnknown(false);}
  }catch(e){if(live.current){setError(errors[e.message]??'结果尚未确认。请核对同一配对回执，不重发、不改投其他 Host。');if(action==='status')setState(v=>v?{...v,remote:null,freshness:'check_failed'}:null);}}
  finally{flight.current=false;if(live.current)setBusy(false);}
 }
 return <Panel className="connection-panel" title="本地与云端直连" icon="cloud" sub="沿用已核对的 SSH 目标；不依赖 IM 群聊，也不复制云端内部令牌。">
  <InfoRow label="操作范围" value="当前本地大肥鱼 ↔ 本导览绑定的云端大肥鱼"/>
  <InfoRow label="本地授权" value={state?.localEnabled?'已允许连接':'尚未允许连接'}/>
  <InfoRow label="本地接入" value={state?.mounted?'接入器已挂载 · 不代表云端在线':'接入器未挂载'}/>
  <InfoRow label="云端观察" value={state?.remote?(state.remote.mounted?'接收通道已挂载':state.remote.enabled?'授权已记录 · 未挂载':'接收通道未启用'):'尚无本次云端观察'}/>
  <div className="connection-actions" role="group" aria-label="双端直连操作">
   <Button kind="primary" icon="cloud" disabled={busy||!!waiting||!!state?.localEnabled} onClick={()=>act('preview',true)}>预览双端配对</Button>
   <Button kind="secondary" icon="pause" disabled={busy||!!waiting||!state?.operation.target} onClick={()=>act('preview',false)}>预览撤销配对</Button>
   <Button kind="secondary" icon="reset" disabled={busy} onClick={()=>act('status')}>手动刷新直连状态</Button>
  </div>
  {state&&<div className="connection-result" role="status"><InfoRow label="操作回执" value={phases[state.operation.state]??'待核对'}/><p className="fine-print">{state.freshness==='remote_checked'?'已查询绑定目标。本次观察不授予任务执行或写入权限。':state.freshness==='check_failed'?'查询失败；本地已挂载不证明网络或云端健康。':'仅本地缓存。打开页面不会自动连接云端刷新。'}</p></div>}
  {state?.activationError&&<p className="connection-error" role="status">本地授权与挂载状态不一致，请核对原回执；不会自动覆盖其他网关。</p>}
  {waiting&&<div className="connection-utility"><p>先查询原操作。仍未知时可关闭旧请求并阻断迟到应用；保留云端既有授权，本地不会因此自动接管。</p><Button kind="soft" icon="shield" disabled={busy} onClick={()=>act('recoveryPreview')}>预览关闭未知配对操作</Button></div>}
  {plan&&<section className="connection-confirm" aria-label="双端配对确认"><h3>{plan.recovery?'关闭未知配对请求':plan.enabled?'确认连接这两个 Host':'确认撤销双端配对'}</h3>
   <InfoRow label="云端范围" value={'已绑定 ECS / DSH '+plan.target.hostVersion}/>
   <Callout>{plan.recovery?'保留云端当前授权，仅关闭原操作并阻断迟到确认；不代表云端已停用。原确认若先成功，会如实显示已生效。':plan.enabled?'启用本地受理、任务与仓库读取和持久消息传输。传输器会处理已授权队列；不会调用模型、开启 worker、开发、提交或推送。':'先停止本地接入，再请求撤销云端配对。历史任务与邮箱保留，不关闭原生 DSH。若网络中断须核对云端回执。'}</Callout>
   <CheckRow checked={confirm} disabled={busy} onChange={setConfirm} title="我已核对双端范围，不授权模型执行或仓库写入"/>
   <div className="connection-actions" role="group" aria-label="双端配对最终确认"><Button kind="primary" icon="check" disabled={busy||!confirm} onClick={()=>act(plan.recovery?'recoveryApply':'apply')}>{plan.recovery?'确认关闭未知配对操作':plan.enabled?'确认双端配对':'确认撤销双端配对'}</Button><Button kind="secondary" disabled={busy} onClick={()=>{setPlan(null);setConfirm(false);}}>取消</Button></div>
  </section>}
  {error&&<p className="connection-error" role="alert">{error}</p>}
  <Callout>请先开启云端任务受理；停用受理前须撤销配对。页面仅手动刷新，不把配置完成当作模型或 IM 全链路验收通过。</Callout>
 </Panel>;
}
