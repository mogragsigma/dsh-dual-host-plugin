import React,{useState,useRef,useEffect,useMemo} from 'react';
import {Button,Panel,Callout,Badge,CheckRow,InfoRow,Summary} from './components';
import {createSelfRemoveFlow,selfRemoveActions,selfRemoveRecoveryGuide} from './self-remove-flow';
const phases={intent:'已记意图 · 原结果未知',unknown:'原结果未知 · 不重发',not_dispatched:'该次未派发给官方管理',saved_restart_required:'官方已保存选择 · 需另行重启',manager_applied:'该次官方管理回执已应用',manager_rejected:'该次官方管理未确认应用',reconciled:'已补记当前观察 · 不追认原结果'};
const errors={ONBOARDING_SELF_REMOVE_OTHER_LIFECYCLE_RECOVERY_REQUIRED:'本端仍有未核对的停用记录。请先核对原记录，不用移除接口绕过。',ONBOARDING_SELF_REMOVE_MAINTENANCE_REQUIRED:'请先在上方申请组件维护；已有任务忙碌或状态未知时，不移除插件。',ONBOARDING_SELF_REMOVE_ORIGINAL_PROCESS_UNRESOLVED:'原 Host 进程仍在或无法证明退出，不能收尾。若需重启，请先保存草稿、核验空闲并单独确认风险；本页不会代你停止。',ONBOARDING_SELF_REMOVE_REFERENCE_UNAVAILABLE:'无法保存查询引用，本次确认没有派发。请保留浏览器数据并检查存储。',ONBOARDING_SELF_REMOVE_PROVIDER_CHANGED:'自身通道已变化，可能由官方热重载移除引起。请按恢复说明核对；不要重复移除。',ONBOARDING_SELF_REMOVE_OWNERSHIP_REVIEW:'官方当前安装归属不满足要求。请在官方插件管理核对，不改写配置或强行接管。',ONBOARDING_SELF_REMOVE_PLAN_EXPIRED:'计划已过期或失效。请手动核对，再预览；不会自动发送。'};
export function SelfRemove({request,contract=0}){
 const [state,setState]=useState(null),[consent,setConsent]=useState(false),[guideSaved,setGuideSaved]=useState(false),alive=useRef(true),flow=useRef();
 if(!flow.current){let storage;try{storage=globalThis.sessionStorage;}catch{}flow.current=createSelfRemoveFlow(request,v=>{if(alive.current)setState(v);},contract,storage);}
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const s=state??flow.current.get(),g=selfRemoveActions(s,contract),c=s.current,p=s.plan,r=s.receipt,review=p?.action==='record_observation_only';
 const reference=p?.action==='remove_own_bundle'?p.id:s.reference?.operationId??r?.id;
 const guide=useMemo(()=>{try{return URL.createObjectURL(new Blob([selfRemoveRecoveryGuide(reference,p?.version??r?.version)],{type:'text/plain;charset=utf-8'}));}catch{return null;}},[reference,p?.version,r?.version]);
 useEffect(()=>()=>{if(guide)URL.revokeObjectURL(guide);},[guide]);
 const act=name=>{setConsent(false);setGuideSaved(false);return flow.current.act(name,consent,guideSaved);};
 if(contract!==1)return null;
 return <Panel title="本端插件包移除" sub="通过官方包管理移除本端插件包；保留规则与数据，不操作另一端。" icon="offline" className="connection-panel self-disable-panel self-remove-panel" extra={<Badge>默认不操作</Badge>}>
  <Callout tone="warn" title="先保留可重装的包源，再决定移除">官方热重载可能立即关闭本插件的面板与回执通道。晚到的原生输入或在途 IM 仍可能中止。界面消失不是成功证明，也不表示 Host 已停止。</Callout>
  <Summary title="移除以后，如何重新安装？" pose="tasks" open><ol className="self-disable-guide"><li>在同一 Host、同一 profile 的 DSH 官方插件管理核对 <code>@mogragsigma/dsh-dual-host-plugin</code>，需要时从保留的已验证包源另行重新安装；不能假定市场可按包名下载。</li><li>官方要求重启时，先保存草稿、核验空闲并明确确认风险。本页不自动停机或重启。</li><li>重新进入此处，手动查询移除账本。原进程退出后，未知记录才可另行补记当前观察，不追认原请求成功。</li><li>组件锁的旧记录收尾、自有执行入口恢复分别确认；不重发历史任务。</li></ol><div className="connection-actions">{guide?<a className="button secondary" href={guide} download="大肥鱼-本端移除恢复说明.txt">保存移除恢复说明</a>:<p className="fine-print">下载不可用；请自行保存上述说明。不要关闭现有官方管理入口。</p>}</div></Summary>
  <Callout title="没有已验证的包源？先不要移除">当前候选为未发布私有包；请保留原安装包或原安装来源。本页不下载未知包，不清空数据，也不释放 ECS。</Callout><section aria-label="本端移除当前观察"><InfoRow label="账本观察" value={!c?'尚未手动核对':c.pending?'当前有待核对操作':c.receipt?'当前无未知操作':'当前没有移除记录'}/><p className="fine-print">{s.observedAt?'观察时间：'+new Date(s.observedAt).toLocaleString()+(s.fresh?'':' · 已过时'):'打开页面不查询、不移除、不定时刷新。'}</p></section>
  <div className="connection-actions"><Button kind="secondary" icon="reset" disabled={s.busy} onClick={()=>act('refresh')}>手动核对移除账本</Button>{g.remove&&<Button kind="soft" onClick={()=>act('remove')}>预览移除本端插件包</Button>}{g.review&&<Button kind="soft" onClick={()=>act('review')}>预览移除后核对</Button>}</div>
  {s.storageError&&<Callout tone="warn">查询引用不可读或已损坏，所有变更保持关闭。保留原数据，不自动清理。</Callout>}
  {s.uncertain&&!s.storageError&&<Callout tone="warn">上次请求尚未找到对应记录；只查询，不重复移除，不据此认定没有执行。</Callout>}
  {c?.pending&&<Callout tone="warn">当前原操作结果未知。重新安装后仍需核对，不会自动放开任务入口。</Callout>}
  {p&&<section className="connection-confirm" aria-label="待确认本端移除计划"><h3>{review?'待确认 · 仅补记当前观察':'待确认 · 移除本端插件包'}</h3><InfoRow label="作用范围" value={review?'仅更新账本，不操作官方管理':'当前 Host · 仅 @mogragsigma/dsh-dual-host-plugin'}/>{!review&&<InfoRow label="当前版本" value={p.version}/>}<p>{review?'保存当前重新安装的观察，不追认原操作成功，不恢复任务入口。':'本包将被官方移除；未使用的 profile 依赖可能被修剪。保留全局规则、Skills、凭据、会话、任务、成果、备份及其他声明插件。面板可能立即消失；关闭窗口不能撤销已发出的请求。'}</p><p className="fine-print">有效至 {new Date(p.expiresAt).toLocaleTimeString()}，提交时再次核验。</p>
   {!review&&<CheckRow checked={guideSaved} onChange={setGuideSaved} disabled={!g.confirm} title="我已保存恢复说明，并保留可重新安装的已验证包源"/>}<CheckRow checked={consent} onChange={setConsent} disabled={!g.confirm} title={review?'我确认仅补记当前观察，不追认原操作成功':'我理解面板可能消失及在途输入可能中止，确认仅移除本端插件包'} sub="不是 Host 停机、完整卸载、开发或发布授权。"/><div className="connection-actions"><Button kind="primary" disabled={!g.confirm||!consent||!review&&!guideSaved} onClick={()=>act('confirm')}>{review?'确认仅补记移除观察':'确认移除本端插件包'}</Button><Button kind="secondary" disabled={s.busy} onClick={()=>{flow.current.cancel();setConsent(false);setGuideSaved(false);}}>取消本端计划</Button></div>
  </section>}
  {r&&<section className="maintenance-receipt" aria-label="本端移除历史回执"><h3>历史记录 · {phases[r.state]}</h3><p>历史回执不证明当前面板仍加载、Host 已停机或任务已恢复。</p>{c?.receipt?.id!==r.id&&<p>当前另有更新记录；本区保留你上次请求的历史。</p>}<InfoRow label="记录时间" value={new Date(r.updatedAt).toLocaleString()}/><details className="plan-item"><summary>诊断引用</summary><code>{r.id}</code></details></section>}
  {s.error&&<p className="connection-error" role="alert">{errors[s.error]??'结果无法确认；按恢复说明手动核对，不自动重试。'} <code>{s.error}</code></p>}
 </Panel>;
}
