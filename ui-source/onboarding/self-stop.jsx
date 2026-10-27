import React,{useState,useRef,useEffect,useMemo} from 'react';
import {Button,Panel,Callout,Badge,CheckRow,InfoRow,Summary} from './components';
import {createSelfStopFlow,selfStopActions,selfStopRecoveryGuide} from './self-stop-flow';
const phases={intent:'已记停机意图 · 原结果未知',not_dispatched:'该次未向官方请求退出',reconciled:'已补记原进程退出观察'};
const errors={ONBOARDING_SELF_STOP_MAINTENANCE_REQUIRED:'先在上方取得组件维护；忙碌或状态未知时不能停机。',ONBOARDING_MAINTENANCE_RECORD_HELD_SESSION_REQUIRED:'当前没有本实例持有的组件维护，请先手动核对维护会话。',ONBOARDING_SELF_STOP_ORIGINAL_PROCESS_UNRESOLVED:'原进程仍在或无法证明退出，不能补记。保留记录，不重复停机。',ONBOARDING_SELF_STOP_REFERENCE_UNAVAILABLE:'无法保存查询引用，未派发本次确认。请保留浏览器数据并检查存储。',ONBOARDING_SELF_STOP_OTHER_LIFECYCLE_RECOVERY_REQUIRED:'还有未核对的停用、移包或 IM 维护，请先处理原记录。',ONBOARDING_SELF_STOP_EXIT_UNAVAILABLE:'当前 Host 未提供官方退出服务；请使用原有人工停机方式，不会降级为强杀。',ONBOARDING_SELF_STOP_OWNERSHIP_REVIEW:'当前官方安装归属无法核验；保持只读，不强行接管。',ONBOARDING_SELF_STOP_PLAN_EXPIRED:'计划已过期或变化，请手动核对后重新预览。'};
export function SelfStop({request,contract=0,allowStop=false}){
 const [state,setState]=useState(null),[consent,setConsent]=useState(false),[guideSaved,setGuideSaved]=useState(false),alive=useRef(true),flow=useRef();
 if(!flow.current){let storage;try{storage=globalThis.sessionStorage;}catch{}flow.current=createSelfStopFlow(request,v=>{if(alive.current)setState(v);},contract,allowStop,storage);}
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const s=state??flow.current.get(),g=selfStopActions(s,contract,allowStop),c=s.current,p=s.plan,r=s.receipt,review=p?.action==='record_exit_observation_only';
 const reference=p?.action==='request_current_host_exit'?p.id:s.reference?.operationId??r?.id;
 const guide=useMemo(()=>{try{return URL.createObjectURL(new Blob([selfStopRecoveryGuide(reference,p?.version??r?.version)],{type:'text/plain;charset=utf-8'}));}catch{return null;}},[reference,p?.version,r?.version]);
 useEffect(()=>()=>{if(guide)URL.revokeObjectURL(guide);},[guide]);
 const act=name=>{setConsent(false);setGuideSaved(false);return flow.current.act(name,consent,guideSaved);};
 if(contract!==1)return null;
 return <Panel title="停止本端 Host" sub="仅请求当前 Host 官方退出；不是同时停止两端，也不是卸载或清理数据。" icon="offline" className="connection-panel self-disable-panel self-stop-panel" extra={<Badge>默认不停止</Badge>}>
  <Callout tone="warn" title="先保存草稿，确认知道如何回来">界面与连接可能立即关闭，断开不是停机成功证明。最后时刻到达的原生或 IM 输入可能中止；外部守护程序可能重启，不能把组件维护当作全局输入屏障。</Callout>
  <Summary title="停机以后，如何恢复？" pose="tasks" open><ol className="self-disable-guide"><li>保存所有草稿和本说明，确认当前 Host 原有的启动方式。无需重新安装插件，不删除用户配置。</li><li>需要恢复时另行确认并按原方式重新启动。此界面不自动启动，也不控制外部守护程序。</li><li>重开此处，手动查询停机账本。原进程确已退出后，另行确认仅补记观察，不追认原请求因果。</li><li>回到组件维护区，分别确认旧记录收尾与恢复自有受理；不重发历史任务。</li></ol><div className="connection-actions">{guide?<a className="button secondary" href={guide} download="大肥鱼-本端停机恢复说明.txt">保存停机恢复说明</a>:<p className="fine-print">下载不可用，请自行保存上述说明后再决定。</p>}</div></Summary>
  {(!allowStop||c?.stopCapabilityAvailable===false)&&<Callout title="当前只可查询与核对">未提供官方退出能力，不会改用强杀；请使用原有人工停机方式。旧记录仍可手动查询。</Callout>}
  <section aria-label="本端停机当前观察"><InfoRow label="账本观察" value={!c?'尚未手动核对':c.pending?'当前有待核对停机意图':c.receipt?'当前无未决停机记录':'当前没有停机记录'}/><p className="fine-print">{s.observedAt?'观察时间：'+new Date(s.observedAt).toLocaleString()+(s.fresh?'':' · 已过时'):'打开页面不查询、不停止、不定时刷新。'}</p></section>
  <div className="connection-actions"><Button kind="secondary" icon="reset" disabled={s.busy} onClick={()=>act('refresh')}>手动核对停机账本</Button>{g.stop&&<Button kind="soft" onClick={()=>act('stop')}>预览停止本端 Host</Button>}{g.review&&<Button kind="soft" onClick={()=>act('review')}>预览停机后核对</Button>}</div>
  {s.storageError&&<Callout tone="warn">查询引用不可读或损坏，变更保持关闭。保留数据，不自动清理。</Callout>}
  {s.uncertain&&!s.storageError&&<Callout tone="warn">尚未找到对应记录；只查询，不重复停止，也不据此推断原请求没有执行。</Callout>}
  {c?.pending&&<Callout tone="warn">原停机结果尚未核对。即使当前页面可打开，也不能断定原进程未退出；自有任务受理仍需独立确认恢复。</Callout>}
  {p&&<section className="connection-confirm" aria-label="待确认本端停机计划"><h3>{review?'待确认 · 仅补记退出观察':'待确认 · 停止本端 Host'}</h3><InfoRow label="作用范围" value={review?'仅更新账本，不再次停止':'当前打开此界面的 Host · 官方退出'}/>{!review&&<InfoRow label="插件版本" value={p.version}/>}<p>{review?'只补记原进程确已退出；不追认退出一定由原请求造成，不恢复任务入口。':'保留插件包、全局规则、Skills、凭据、会话、任务队列、成果与备份。官方有界关闭可能强制结束未完成的工作；本页不自动重启，关闭窗口不能撤销已提交请求。'}</p><p className="fine-print">有效至 {new Date(p.expiresAt).toLocaleTimeString()}，提交时再次核验。</p>
   {!review&&<CheckRow checked={guideSaved} onChange={setGuideSaved} disabled={!g.confirm} title="我已保存草稿和恢复说明，知道如何重新启动此 Host"/>}<CheckRow checked={consent} onChange={setConsent} disabled={!g.confirm} title={review?'我确认仅补记原进程退出观察，不追认原请求因果':'我接受最后到达的原生或 IM 输入可能中止，确认停止本端 Host'} sub="不授权卸载、清理数据、开发或发布。"/><div className="connection-actions"><Button kind="primary" disabled={!g.confirm||!consent||!review&&!guideSaved} onClick={()=>act('confirm')}>{review?'确认仅补记退出观察':'确认停止本端 Host'}</Button><Button kind="secondary" disabled={s.busy} onClick={()=>{flow.current.cancel();setConsent(false);setGuideSaved(false);}}>取消停机计划</Button></div>
  </section>}
  {r&&<section className="maintenance-receipt" aria-label="本端停机历史回执"><h3>历史记录 · {phases[r.state]}</h3><p>此记录不证明当前 Host 已停止，不代表任务已恢复；原生输入和第三方 IM 不受自有受理屏障控制。</p>{c?.receipt?.id!==r.id&&<p>当前另有更新记录；这里保留上次请求的历史。</p>}<InfoRow label="记录时间" value={new Date(r.updatedAt).toLocaleString()}/><details className="plan-item"><summary>诊断引用</summary><code>{r.id}</code></details></section>}
  {s.error&&<p className="connection-error" role="alert">{errors[s.error]??'结果无法确认，请按恢复说明手动核对；不会自动重发。'} <code>{s.error}</code></p>}
 </Panel>;
}
