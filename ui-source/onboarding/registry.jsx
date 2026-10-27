import React,{useEffect,useRef,useState} from 'react';
import {Panel,Field,Button,InfoRow,Callout,CheckRow} from './components';
const messages={ONBOARDING_REPOSITORY_ALIAS_CONFLICT:'这个别名已经登记给其他仓库，请改名后重新预览。',ONBOARDING_REPOSITORY_REGISTRY_ARGUMENTS:'请核对仓库地址和别名；不要填写令牌。',ONBOARDING_REPOSITORY_CREDENTIAL_REQUIRED:'目标端没有本项目 Gitee 令牌。请先保存／交接，或明确选择匿名访问公开仓库。',ONBOARDING_REPOSITORY_RECOVERY_REQUIRED:'上次云端登记尚待核对，不能用新计划覆盖。请先刷新原回执，必要时预览关闭未知操作。',ONBOARDING_REPOSITORY_PLAN_EXPIRED:'确认计划已过期或被消耗。若曾点击确认，请先刷新回执，不要直接重复登记。',ONBOARDING_REPOSITORY_REGISTRY_CONFLICT:'登记版本已变化，本次没有覆盖新版本。请刷新后重新审阅。',ONBOARDING_REPOSITORY_ALREADY_APPLIED:'原操作已登记，请手动刷新查看回执，无需关闭或重发。',ONBOARDING_CLOUD_REPOSITORY_UNSUPPORTED:'原云端安装归档不支持登记合同；保留原环境，不替换旧控制器。',ONBOARDING_CLOUD_HANDOFF_REPOSITORY_UNSUPPORTED:'目标 Host 不支持登记与恢复合同，不回退到旧接口。',ONBOARDING_CLOUD_HANDOFF_HOST_NOT_READY:'受管云端尚未就绪，请先核对第 6 页；不会改登记到本端。'};
const normalizedUrl=v=>v?.replace(/^git@gitee\.com:/,'https://gitee.com/').replace(/\.git\/?$/,'').replace(/\/$/,'').toLowerCase();
const labels={not_started:'尚无本轮云端登记操作',sending:'已记发送意图 · 待核对',needs_review:'结果待核对 · 不重发',recovering:'正在核对关闭结果',applied:'原登记回执已确认',closed:'原操作已关闭或版本已推进'};
export function RepositoryRegistry({request,url,alias,cloud=false}){
 const [authentication,setAuthentication]=useState('anonymous'),[state,setState]=useState(null),[plan,setPlan]=useState(null),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[unknown,setUnknown]=useState(false);
 const live=useRef(true),flight=useRef(false),current=useRef('');const key=JSON.stringify([url,alias,authentication,cloud]);current.current=key;
 const prefix=cloud?'cloud_repository_registry_':'repository_registry_',side=cloud?'云端':'本端';
 const name=alias?.trim()||url?.replace(/\/$/,'').split('/').pop()?.replace(/\.git$/,'')||'';
 useEffect(()=>{live.current=true;request(prefix+'status',cloud?{refresh:false}:{}).then(v=>{if(live.current)setState(v);}).catch(()=>{if(live.current)setError('本端登记记录读取失败，请手动刷新核对。');});return()=>{live.current=false;};},[cloud]);
 // Form changes do not query Gitee, and cannot leave an old confirmation enabled.
 useEffect(()=>{setPlan(null);setConfirm(false);},[key]);
 const registry=cloud?state?.registry:state,op=cloud?state?.operation:null;
 const registered=registry?.entries?.find(e=>e.url.toLowerCase()===normalizedUrl(url));
 const waiting=cloud?op&&['sending','needs_review','recovering'].includes(op.state):unknown;
 async function act(action,enabled){
  if(flight.current)return;flight.current=true;setBusy(true);setError('');const started=key,p=plan;
  if(action==='apply'||action==='recoveryApply'){setPlan(null);setConfirm(false);setUnknown(true);}
  try{
   let args;
   if(action==='status'){setPlan(null);setConfirm(false);args=cloud?{refresh:true}:{};}
   else if(action==='preview')args=enabled?{url,alias:name,authentication,enabled:true}:{url:registered.url,alias:registered.alias,authentication:registered.authentication,enabled:false};
   else if(action==='recoveryPreview')args={};
   else args={id:p.id,fingerprint:p.fingerprint,confirm:true};
   const v=await request(prefix+action,args);if(!live.current)return;
   if(action==='preview'||action==='recoveryPreview'){if(current.current===started){setPlan({...v,recovery:action==='recoveryPreview'});setConfirm(false);}}
   else{setState(v);setUnknown(false);}
  }catch(e){if(live.current){setError(messages[e.message]??'结果未确认。请手动核对原记录，不依据错误推断未写入，也不自动重试。');if(action==='status')setState(v=>cloud&&v?{...v,registry:null,freshness:'check_failed'}:null);}}
  finally{flight.current=false;if(live.current)setBusy(false);}
 }
 return <Panel className="connection-panel" title={side+'仓库登记'} icon="git" sub="把草稿变成明确登记；不是任务绑定，也不开放开发或 Git 写入。">
  <InfoRow label="登记位置" value={cloud?'本导览绑定的云端 Host · 不改本端':'当前 Host · 不自动同步云端'}/>
  <InfoRow label="拟用别名" value={name||'填写地址后默认使用仓库名称，也可自定义别名'}/>
  <Field label="登记访问身份"><select value={authentication} disabled={busy} onChange={e=>setAuthentication(e.target.value)}><option value="anonymous">匿名 · 公开仓库</option><option value="managed">目标端本项目 Gitee 令牌</option></select></Field>
  <div className="connection-actions" role="group" aria-label={side+'仓库登记操作'}>
   <Button kind="primary" icon={busy?'spinner':'git'} disabled={busy||!url||!name||!!waiting} onClick={()=>act('preview',true)}>预览{side}仓库登记</Button>
   <Button kind="secondary" icon="pause" disabled={busy||!registered?.enabled||!!waiting} onClick={()=>act('preview',false)}>预览停用{side}登记</Button>
   <Button kind="secondary" icon="reset" disabled={busy} onClick={()=>act('status')}>手动刷新{side}登记</Button>
  </div>
  {op&&<div className="connection-result" role="status"><InfoRow label="原操作" value={labels[op.state]??'待核对'}/><p className="fine-print">{state.freshness==='remote_checked'?'已手动查询目标端；仅代表本次观察。':state.freshness==='check_failed'?'本次查询失败，历史回执不证明当前在线。':'本端历史记录，尚未查询云端。'}</p></div>}
  {registry&&<div className="connection-result" role="status"><InfoRow label="当前地址的登记" value={registered?(registered.enabled?'已登记 · '+registered.alias:'已停用，保留记录'):'未登记'}/><InfoRow label="任务运行时" value={registry.runtimeConfigured?'目标配置已接入；任务仍须另行关联和审批':'尚未启用此登记的云端任务运行时；保存不代表可执行'}/><p className="fine-print">登记修订 {registry.revision}；不是仓库内容或权限的持续监控。</p></div>}
  {cloud&&waiting&&<div className="connection-utility"><p>先刷新原回执。仍未确认时，可单独关闭原操作并阻断迟到请求；不删除仓库登记或凭据。</p><Button kind="soft" icon="shield" disabled={busy} onClick={()=>act('recoveryPreview')}>预览关闭未知云端登记</Button></div>}
  {plan&&<section className="connection-confirm" aria-label={side+'仓库登记确认'}><h3>{plan.recovery?'关闭未知登记，不重发':plan.entry.enabled?'确认登记计划':'确认停用计划'}</h3>
   {!plan.recovery&&<><InfoRow label="仓库" value={plan.entry.url}/><InfoRow label="别名" value={plan.entry.alias}/><InfoRow label="访问方式" value={plan.entry.authentication==='anonymous'?'匿名，不使用任何已存令牌':'仅目标端本项目 Gitee 令牌'}/><InfoRow label="实际 Host" value={plan.target.name+' / '+plan.target.platform}/></>}
   <Callout>{plan.recovery?'仅推进登记版本屏障或核对已推进的版本；保留当前所有条目，不重发原登记。若原请求已成功，会显示原登记生效，而不是假报撤销。':'仅保存或停用这个地址的登记。原任务关联不变；开发、提交、推送仍须独立审批。'}</Callout>
   <CheckRow title="我确认仅变更本项目仓库登记，不授权任务或 Git 写入" checked={confirm} onChange={setConfirm}/>
   <div className="connection-actions" role="group" aria-label={side+'仓库登记最终确认'}><Button kind="primary" icon="check" disabled={busy||!confirm} onClick={()=>act(plan.recovery?'recoveryApply':'apply')}>{plan.recovery?'确认关闭未知登记':plan.entry.enabled?'确认'+side+'仓库登记':'确认停用'+side+'登记'}</Button><Button kind="secondary" disabled={busy} onClick={()=>{setPlan(null);setConfirm(false);}}>取消</Button></div>
  </section>}
  {error&&<p className="connection-error" role="alert">{error}</p>}
  <Callout>本端与云端登记独立；Gitee 仍不是通信通道或任务锁。页面不自动刷新，不访问 Gitee 网页。</Callout>
 </Panel>;
}
