import React,{useState,useRef,useEffect} from 'react';
import {Button,Panel,Callout,Badge,CheckRow,InfoRow} from './components';
import {createMaintenanceFlow,maintenanceActions} from './maintenance-flow';
const actions={upgrade:'升级',repair:'修复',uninstall:'移除'};
const states={inspected:'当前文件已检查',not_installed:'尚未安装规则与 Skill',uninstalled:'本端规则与 Skill 已移除',committed:'变更已记账',rolled_back:'本次变更已回滚',needs_review:'待核对 · 保留现场',applying:'处理中／待核对',rolling_back:'回滚中／待核对'};
const messages={ONBOARDING_MAINTENANCE_BUSY:'原事务仍在运行；请稍后手动核对，不会中断或重发。',ONBOARDING_PLAN_EXPIRED:'计划已过期；未自动重新申请或执行。若已提交，请先核对原回执。',ONBOARDING_PLAN_DRIFT:'文件或账本发生变化，原计划未继续执行。请先核对回执，保留现场。',ONBOARDING_MAINTENANCE_OPERATION_NOT_FOUND:'尚未找到原请求的账本，不等于请求未送达。请稍后手动查询，不重复确认。',ONBOARDING_MAINTENANCE_INCOMPLETE_JOURNAL:'原事务缺少完整账本，不能自动恢复；保留现场供核对。',ONBOARDING_MAINTENANCE_REFERENCE_UNAVAILABLE:'浏览器无法保存回执查询引用，本次未发送维护请求。请检查浏览器存储设置。'};
const changes={create:'新建自有文件',replace:'替换受管内容',remove:'移除受管内容'};
export function Maintenance({request,contract=0,mutation=false}){
 const [s,setS]=useState(null),[confirmed,setConfirmed]=useState(false),alive=useRef(true),flow=useRef(null);
 if(!flow.current){let storage;try{storage=globalThis.sessionStorage;}catch{}flow.current=createMaintenanceFlow(request,v=>{if(alive.current)setS(v);},{contract,mutation},storage);}
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const state=s??flow.current.get(),gates=maintenanceActions(state,{contract,mutation}),p=state.plan,r=state.receipt;
 const act=a=>{setConfirmed(false);return flow.current.act(a,confirmed);};
 return <Panel title="本端规则与 Skill 维护" sub="只管理你正在访问的 Host；另一端需分别进入并确认。" icon="shield" extra={<Badge>手动核对</Badge>} className="connection-panel maintenance-panel">
  <Callout>升级、修复或移除的范围仅为本项目的全局 AGENTS.md 托管区与 Skill。保留用户原文、未知文件、凭据、任务与成果；不卸载插件本体、第三方插件或 ECS 实例。</Callout>
  <div className="maintenance-status" role="status"><InfoRow label="当前状态" value={state.current?(states[state.current.state]??'状态需核对'):'尚未手动核对'}/>{state.current?.action&&<InfoRow label="当前事务" value={actions[state.current.action]??'维护'}/>}{state.current?.installedVersion&&<InfoRow label="已登记规则版本" value={state.current.installedVersion}/>}<p className="fine-print">{state.observedAt?'观察时间：'+new Date(state.observedAt).toLocaleString()+' · 不代表会话已加载':'打开页面不执行维护，也不定时刷新。'}</p></div>
  <div className="connection-actions" role="group" aria-label="本端维护操作"><Button kind="secondary" icon="reset" disabled={state.busy} onClick={()=>act('refresh')}>手动核对维护状态与回执</Button>{Object.entries(actions).map(([a,name])=><Button key={a} kind="soft" disabled={!gates.preview} onClick={()=>act(a)}>预览{name}计划</Button>)}</div>
  {contract!==2||!mutation?<Callout>目标端只开放只读维护计划，不能从这里应用或恢复；不会降级调用旧接口。</Callout>:null}
  {state.uncertain&&<Callout tone="warn">原请求结果尚待核对，不重复发送，不把刷新失败显示为维护成功。</Callout>}
  {state.current?.canRecover&&<div className="connection-actions"><Button kind="secondary" disabled={!gates.recover} onClick={()=>act('recovery_preview')}>预览原事务恢复</Button></div>}
  {p&&<section className="connection-confirm" aria-label="待确认维护计划"><h3>待确认计划 · {actions[p.action]}规则与 Skill</h3><InfoRow label="规则版本" value={(p.installedVersion??'未登记')+' → '+p.targetVersion}/><InfoRow label="拟变更" value={(p.changes?.length??0)+' 项 · 尚未执行'}/><p>计划有效至 {new Date(p.expiresAt).toLocaleTimeString()}。确认时再次检查文件归属、版本和并发变化。</p>
   {p.conflicts?.map((x,i)=><div className="plan-item" role="alert" key={i}><strong>此项冲突阻止应用</strong><code>{x.code}</code>{x.path&&<code>{x.path}</code>}</div>)}
   {p.changes?.map((x,i)=><details className="plan-item" key={i}><summary>{changes[x.action]} · {x.kind==='global_rules'?'全局 AGENTS.md':x.path.split(/[\\/]/).slice(-2).join('/')}</summary><code>{x.path}</code><p>{x.preservedUserBytes!==undefined?'保留用户原文 '+x.preservedUserBytes+' 字节':'仅管理清单内自有文件'}</p><InfoRow label="变更大小" value={x.beforeBytes+' → '+x.afterBytes+' 字节'}/>{x.managedText&&<pre className="install-diff">{x.managedText}</pre>}</details>)}
   {p.retained?.length>0&&<details className="plan-item"><summary>将保留的目录与文件 · {p.retained.length} 项</summary>{p.retained.map((x,i)=><div key={i}><code>{x.path}</code><p>{x.reason}{x.names?.length?' · '+x.names.join('、'):''}</p></div>)}</details>}
   {!p.canApply&&<Callout>{p.conflicts?.length?'存在冲突，本计划不能应用。':'没有可应用的变更；不重复维护。'}</Callout>}
   <CheckRow checked={confirmed} disabled={!gates.apply} onChange={setConfirmed} title="我确认仅应用上述本端规则与 Skill 维护计划" sub="不授权另一端操作、插件卸载、任务开发或发布。"/>
   <div className="connection-actions"><Button kind="primary" disabled={!gates.apply||!confirmed} onClick={()=>act('apply')}>确认{actions[p.action]}本端规则与 Skill</Button><Button kind="secondary" disabled={state.busy} onClick={()=>{flow.current.cancel();setConfirmed(false);}}>取消计划</Button></div>
  </section>}
  {state.recovery&&<section className="connection-confirm" aria-label="待确认恢复计划"><h3>{state.recovery.action==='finalize_receipt'?'变更已提交 · 仅补齐回执收尾':'回滚原事务的未完成变更'}</h3><InfoRow label="原操作" value={actions[state.current?.action]??'维护'}/>{Array.isArray(state.current?.files)&&<details className="plan-item"><summary>原事务涉及 {state.current.files.length} 个受管文件</summary>{state.current.files.map((x,i)=><div key={i}><p>{changes[x.action]??'核对受管内容'}</p><code>{x.path}</code></div>)}</details>}<p>{state.recovery.action==='finalize_receipt'?'不撤销已经成功的维护，只核验原事务并收尾。':'只恢复能够核验的原始文件；并发修改与未知内容保留为待核对。'}</p><CheckRow checked={confirmed} onChange={setConfirmed} disabled={!gates.recoveryApply} title="我确认仅按上述计划处理原维护事务"/><div className="connection-actions"><Button kind="primary" disabled={!confirmed||!gates.recoveryApply} onClick={()=>act('recover')}>确认处理原维护事务</Button><Button kind="secondary" disabled={state.busy} onClick={()=>{flow.current.cancel();setConfirmed(false);}}>取消恢复</Button></div></section>}
  {r&&<section className="maintenance-receipt" role="status" aria-label="持久维护回执"><h3>持久回执 · {states[r.state]??'状态需核对'}</h3><InfoRow label="原操作" value={actions[r.action]??'维护'}/>{r.version&&<InfoRow label="回执版本" value={r.version}/>}<p>这是原操作的账本，不代表当前文件仍一致、会话已加载或整套环境维护完成。</p>{r.error&&<code>{r.error}</code>}{r.review?.map((x,i)=><div className="plan-item" key={i}><code>{x.path}</code><p>保留现场 · {x.reason}</p></div>)}{r.directoryResults?.filter(x=>x.state==='retained_nonempty_or_changed').map((x,i)=><p key={i}>非空或变化的目录已保留：<code>{x.path}</code></p>)}</section>}
  {(state.error||state.current?.error)&&<p className="connection-error" role="alert">{messages[state.error||state.current.error]??'本次结果需核对；不自动重试或覆盖文件。'} <code>{state.error||state.current.error}</code></p>}
 </Panel>;
}
