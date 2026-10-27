import {ModelProbe} from './model-probe';
import React,{useEffect,useState,useRef} from 'react';
import {Panel,Button,InfoRow,Callout,CheckRow,Field} from './components';
const labels={not_configured:'未接入',configured_unverified:'已接入 · 请求结果见下方回执',disabled:'已停用',credential_changed:'凭据已变化 · 请重新预览确认',registration_pending:'注册待核对',needs_review:'需要核对',unavailable:'当前 Host 能力不可用',not_checked:'尚未核对云端 · 不自动连接'};
const messages={ONBOARDING_CLOUD_MODEL_CLARIFICATION_UNSUPPORTED:'本次云端归档尚不支持名称补充说明，请核对版本；不忽略选择或改用本端。',ONBOARDING_CLOUD_HANDOFF_MODEL_CLARIFICATION_UNSUPPORTED:'目标 Host 尚不支持名称补充说明，请核对版本；不忽略选择或改用本端。',ONBOARDING_CLOUD_HANDOFF_TOKEN_UNSUPPORTED:'目标云端 Host 尚不支持 Token Plan 凭据合同，请核对版本；保留原配置，不自动升级。',ONBOARDING_CLOUD_HANDOFF_MODEL_UNAVAILABLE:'目标云端模型接入服务尚未就绪，请手动核对，不切换到本端。',ONBOARDING_CLOUD_HANDOFF_FENCE_UNSUPPORTED:'目标云端尚不支持此服务的版本屏障，保留账本，不自动关闭或重发。',ONBOARDING_CLOUD_TOKEN_UNSUPPORTED:'本次云端归档尚不支持 Token Plan 交接与接入；保留原环境，不自动覆盖或升级。',ONBOARDING_CLOUD_HANDOFF_HOST_NOT_READY:'云端 Host 尚未完全就绪或仍在安装／重启收尾。请等待后手动核对，不自动重试或重发。',ONBOARDING_CLOUD_HANDOFF_TARGET_CHANGED:'云端实例身份变化，已停止；请核对原目标，不使用旧确认。',ONBOARDING_CLOUD_HANDOFF_IDENTITY_REVIEW:'云端身份或能力尚未通过核验，保留原记录，不转交其他实例。',ONBOARDING_CLOUD_HANDOFF_RUNTIME_SOURCE_CHANGED:'云端受管程序文件已变化，停止操作；不自动替换或修复。',ONBOARDING_CLOUD_HANDOFF_AUTH_FAILED:'云端原生访问凭据未通过核验，请核对当前运行时；不尝试日常凭据或其他地址。',ONBOARDING_CLOUD_OPERATION_BUSY:'另一项云端操作正在处理，请等待它结束后再手动核对；本次不会排队执行或自动重试。',ONBOARDING_CLOUD_MODEL_UNSUPPORTED:'本次云端归档尚不支持模型接线，保留旧环境，不自动替换控制器或升级。',ONBOARDING_CLOUD_MODEL_PLAN_EXPIRED:'计划已过期或控制端已重启，请先核对云端当前状态，再重新预览。',ONBOARDING_CLOUD_MODEL_IDENTITY_REVIEW:'目标身份发生变化，已停止；请重新核对实例，不将旧确认用于新目标。',ONBOARDING_MODEL_CREDENTIAL_REQUIRED:'请先保存“本端 DeepSeek”凭据。预备云端的 Key 不会自动用于本端。',ONBOARDING_MODEL_CREDENTIAL_CHANGED:'凭据刚刚变化，请重新预览；本次没有启用旧计划。',ONBOARDING_MODEL_ROUTE_CONFLICT:'同名路由已存在，保留原配置，请先核对。',ONBOARDING_MODEL_PLAN_EXPIRED:'计划已过期，请重新预览。'};
export function ModelConnection({request,query,cloud=false,service='deepseek'}){
 const token=service==='token-plan',side=cloud?'云端':'本端',subject=token?' Token Plan':'模型',title=side+subject+'接入',providerName=token?'阿里云 Token Plan（双端配置）':'DeepSeek（双端配置）',call=(method,args)=>request((cloud?'cloud_':'')+(token?'token_':'')+method,args);
 const [state,setState]=useState(null),[plan,setPlan]=useState(null),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[resolution,setResolution]=useState(null),[clarification,setClarification]=useState('');
 const selectionKey=JSON.stringify([query,cloud,service,clarification]),currentSelection=useRef(selectionKey);currentSelection.current=selectionKey;
 useEffect(()=>{setClarification('');setResolution(null);},[query,cloud,service]);
 function editClarification(value){setClarification(value);setResolution(null);}
 useEffect(()=>{if(cloud){setState({state:'not_checked'});return;}let live=true;request(token?'token_model_status':'model_status',{}).then(s=>{if(live)setState(s);}).catch(()=>{if(live)setError('尚未核对模型接入状态，请手动刷新。');});return()=>{live=false;};},[request,cloud,token]);
 async function act(kind,enabled){
  setBusy(true);setError('');
  try{
   if(kind==='status'){setPlan(null);setConfirm(false);setResolution(null);setState(await call('model_status',{}));}
   if(kind==='preview'){setPlan(null);setConfirm(false);setPlan(await call('model_preview',{enabled}));}
   if(kind==='apply'){
    if(!plan||!confirm)return;
    const p=plan;setPlan(null);setConfirm(false);setResolution(null);
    setState(await call('model_apply',{id:p.id,fingerprint:p.fingerprint,confirm:true}));
   }
   if(kind==='resolve'){const r=await call('model_resolve',{query,...(clarification.trim()?{clarification:clarification.trim()}:{})});if(currentSelection.current===selectionKey)setResolution(r);}
  }catch(e){setPlan(null);setConfirm(false);setError(token&&cloud&&e.message==='ONBOARDING_MODEL_CREDENTIAL_REQUIRED'?'请在云端 Token Plan 凭据交接区保存专用 Key，再单独预览云端接入；不会借用本端或 DeepSeek Key。':token&&e.message==='ONBOARDING_MODEL_CREDENTIAL_REQUIRED'?'请先在本端安全保存 Key 区保存阿里云 Token Plan 专用凭据；不会借用 DeepSeek Key。':e.message==='ONBOARDING_MODEL_ADAPTER_UNAVAILABLE'?'当前 Host 缺少兼容的官方多模型适配依赖或目录不符，请核对官方版本；不会自动安装、切换端点或回退其他服务。':cloud&&e.message==='ONBOARDING_MODEL_CREDENTIAL_REQUIRED'?'请先在云端凭据交接区（或云端原生导览）保存云端专用 Key，再预览云端接入。':messages[e.message]??'结果需核对，请手动刷新状态；不会自动重试、切换模型或回退至其他 Key。');}
  finally{setBusy(false);}
 }
 return <Panel className="connection-panel" title={title} icon="link" sub={cloud?"仅本次受管云端实例；独立预览确认，不读取或转发本地 Key。":"只使用本项目保存的本端专用 Key；不修改原生模型或默认选择。"}>
  <InfoRow label="当前状态" value={state?labels[state.state]??'需要核对':'尚未读取'}/>
  <InfoRow label={cloud?"实际操作的云端 Host":"当前访问的 Host"} value={state?.target?`${state.target.name} · ${state.target.platform}`:"尚未核对"}/>
  {cloud&&state?.remoteTarget&&<InfoRow label="云端专用目录" value={state.remoteTarget.root}/>}
  {cloud&&state?.checkedAt&&<InfoRow label="最近手动核验" value={new Date(state.checkedAt).toLocaleString()+" · 非自动刷新"}/>}
  <InfoRow label="服务商" value={token?"阿里云 Token Plan · 中国内地":"DeepSeek 官方 · 独立接入"}/>
  <Callout>{cloud?"此处通过已核验 SSH 调整本次受管云端自有模型接入，云端账本是状态依据。进入页面不连接云端；请手动刷新。":""}保存 Key 不等于模型可用。启用后会增加“{providerName}”路由，凭据用于{cloud?"上述受管云端":"当前访问的 Host"}，不发起推理或自动转发到另一端；实际请求验证仍需单独进行。</Callout>
  <div className="connection-actions" role="group" aria-label={title+"操作"}>
   <Button kind="primary" icon="link" disabled={busy} onClick={()=>act('preview',true)}>预览{token?side+" Token Plan":side}接入</Button>
   <Button kind="secondary" icon="pause" disabled={busy||!state?.bindingRevision} onClick={()=>act('preview',false)}>{token?"预览停用 Token Plan":"预览停用接入"}</Button>
   <Button kind="secondary" icon="reset" disabled={busy} onClick={()=>act('status')}>手动刷新{token?"Token Plan":cloud?"云端模型":"模型"}状态</Button>
  </div>
  {plan&&<section className="connection-confirm" aria-label={title+"确认"}><h3>{(plan.enabled?'启用':'停用')+title}</h3><p>仅{cloud?"上述受管云端":"当前 Host"}；不修改原生路由、默认模型和用户凭据。停用也不会删除 Key。</p><InfoRow label="应用位置" value={`${plan.target?.name??"当前 Host"} · ${plan.target?.platform??"平台未核对"}`}/>{cloud&&plan.remoteTarget&&<InfoRow label="云端专用目录" value={plan.remoteTarget.root}/>}<InfoRow label="目标端点" value={plan.endpoint}/><CheckRow title={"我确认仅调整本项目的"+title+"，不授权模型请求或任务"} checked={confirm} onChange={setConfirm}/><div className="connection-actions" role="group" aria-label="确认或取消模型接入"><Button kind="primary" icon="check" disabled={busy||!confirm} onClick={()=>act('apply')}>确认{plan.enabled?'启用':'停用'}{title}</Button><Button kind="secondary" disabled={busy} onClick={()=>{setPlan(null);setConfirm(false);}}>取消</Button></div></section>}
  <section className="connection-utility connection-model-choice" aria-label="模型名称核对">
   <div><h3>模型名称核对</h3><p>按{side}完整目录匹配；先用模型简称，有重名再补充接入名称。无需填写技术编号。</p></div>
   <Button kind="soft" icon="settings" disabled={busy||!query?.trim()} onClick={()=>act('resolve')}>{token?"核对所填模型名称":"解析所填模型名称"}</Button>
   {(resolution?.status==='ambiguous'||clarification)&&<Field label="模型接入补充说明" hint="仅重名时需要；填写候选展示的接入名称，例如“请用 DeepSeek（双端配置）”。不填写 Key。" value={clarification} maxLength={200} onChange={e=>editClarification(e.target.value)}/>}
   {resolution?.status==='ambiguous'&&<div className="connection-actions" role="group" aria-label="用易懂的接入名称补充选择">{[...new Set(resolution.candidates?.map(x=>x.provider_name)??[])].map(name=><Button key={name} kind="secondary" disabled={busy} onClick={()=>editClarification('请用 '+name)}>选择 {name}</Button>)}<p>选择仅补充文字，请再核对名称；同名接入仍会要求澄清，不自动请求模型。</p></div>}
   {resolution&&<div className="connection-result" role="status"><p>{resolution.status==='resolved'?`${cloud?"云端":"当前 Host"}唯一匹配：${resolution.selection.model_name} · ${resolution.selection.provider_name}，思考 High。未设为默认模型、未调用。`:resolution.instruction}</p>{resolution.status!=='resolved'&&resolution.candidates?.map(x=><p key={x.provider+'/'+x.model}>{x.model_name} · {x.provider_name}</p>)}</div>}
  </section>
  <ModelProbe request={request} query={query} clarification={clarification} cloud={cloud} service={service}/>
  {error&&<p className="connection-error" role="alert">{error}</p>}
 </Panel>;
}
