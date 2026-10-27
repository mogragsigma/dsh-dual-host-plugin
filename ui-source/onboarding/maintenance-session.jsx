import React,{useState,useRef,useEffect} from 'react';
import {Button,Panel,Callout,Badge,CheckRow,InfoRow} from './components';
import {createMaintenanceSessionFlow,maintenanceSessionActions} from './maintenance-session-flow';
const states={open:'当前没有未结束维护',held:'本实例持有组件维护锁',needs_review:'本实例记录待核对',interrupted:'旧实例记录未收尾',acquire_intent:'已记获取意图 · 结果待核对',release_intent:'已记释放意图 · 结果待核对',released:'原组件锁已释放',not_held:'原记录已核对 · 未持锁',retired:'旧实例记录已收尾'};
const historyStates={...states,held:'该记录当时已取得组件锁',needs_review:'该记录待核对',released:'该记录组件锁已释放',not_held:'该记录已核对 · 当时未持锁'};
const titles={acquire:'申请组件维护',release:'释放本实例组件锁',record_observation:'核对本实例记录',retire_previous_instance:'收尾旧实例记录',resume_admission:'恢复自有执行入口'};
const reasons={absent:'原进程已不存在',pid_reused:'PID 已属于不同出生身份',boot_changed:'同一主机已重新启动',terminal:'原进程已终止',same_process:'原进程仍存活',identity_missing:'旧记录缺少身份凭据',host_changed:'主机身份不同',namespace_changed:'进程命名空间不同',observer_unavailable:'当前实例身份无法核验',process_unavailable:'原进程状态无法读取',observation_changed:'观察期间身份变化',identity_format_changed:'旧时间格式无法与当前格式比较',current_instance:'当前实例不能作为旧实例收尾',previous_instance_unverified:'尚不能核验旧实例'};
const componentStates={open:'未持锁',held:'本实例已持锁',busy:'活动中',not_configured:'未配置 · 不适用',unsupported:'不支持核验',needs_review:'待核对'};
const errors={ONBOARDING_MAINTENANCE_REFERENCE_UNAVAILABLE:'无法保存查询引用，请求未发送。请检查浏览器存储设置。',ONBOARDING_MAINTENANCE_RECORD_PLAN_EXPIRED:'计划过期或已失效；先手动核对，再预览新计划。',ONBOARDING_MAINTENANCE_RECORD_OBSERVATION_CHANGED:'记录或退出证据发生变化，未继续操作。请手动核对。',ONBOARDING_MAINTENANCE_RECORD_LEDGER_REVIEW:'原账本无法安全解析，保留现场，不覆盖或删除。'};
export function MaintenanceSession({request,contract=0}){
 const [s,setS]=useState(null),[consent,setConsent]=useState(false),alive=useRef(true),flow=useRef();
 if(!flow.current){let storage;try{storage=globalThis.sessionStorage;}catch{}flow.current=createMaintenanceSessionFlow(request,v=>{if(alive.current)setS(v);},contract,storage);}
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const v=s??flow.current.get(),g=maintenanceSessionActions(v,contract),p=v.plan,c=v.current,r=v.receipt;
 const act=name=>{setConsent(false);return flow.current.act(name,consent);};
 return <Panel title="维护会话与记录" sub="仅管理当前 Host 的自有组件；规则文件维护仍在第 5 页。" icon="lock" className="connection-panel maintenance-session" extra={<Badge>手动核对</Badge>}>
  <Callout>组件锁不是整机暂停。第三方 IM 尚未完成排空；这里不授权停机、插件升级、卸载、开发或发布。</Callout>
  <div className="maintenance-status" role="status"><InfoRow label="当前观察" value={c?(states[c.state]??'状态需核对'):'尚未手动核对'}/><p className="fine-print">{v.observedAt?'观察时间：'+new Date(v.observedAt).toLocaleString()+(v.fresh?'':' · 已过时，需重新核对'):'打开页面不读账本、不执行维护、不定时刷新。'}</p></div>
  {c?.admission?.contract===1&&<InfoRow label="自有执行入口" value={({checking:'启动核对中 · 暂不放行',open:'准入开放 · 任务仍受各自审批约束',fenced:'准入关闭 · 恢复须另行确认',unavailable:'账本无法核验 · 保持关闭'})[c.admission.local]??'未知 · 不视为已恢复'}/>}
  {c?.admission?.blocked&&<Callout tone="warn">自有任务网关、模型接入与后台启动保持关闭。收尾旧记录只更新历史，不会自动恢复；这里不暂停第三方 IM 或全部原生会话。</Callout>}
  {c?.executionMayHaveResumed&&<Callout tone="warn">Host 已换实例，原生或第三方任务仍可能已恢复。旧记录不代表旧锁仍然生效；不会沿用旧批准。</Callout>}
  {c&&<div className="maintenance-components">{[['onboarding','自有导览与后台'],['gateway','任务与文件网关'],['agents','原生智能体']].map(([key,label])=><InfoRow key={key} label={label} value={componentStates[c.live?.components?.[key]?.state]??'未知 · 不视为空闲'}/>)}<InfoRow label="第三方 IM" value="未完成排空验证"/></div>}
  <div className="connection-actions"><Button kind="secondary" icon="reset" disabled={v.busy||contract!==2} onClick={()=>act('refresh')}>手动核对会话与回执</Button>{Object.entries(titles).filter(([key])=>g[key]).map(([key,label])=><Button key={key} kind="soft" onClick={()=>act(key)}>预览{label}</Button>)}</div>
  {v.uncertain&&<Callout tone="warn">上次请求尚未找到可核验记录。保留查询引用，不自动重发；请手动核对，不能据此判定请求没有执行。</Callout>}
  {p&&<section className="connection-confirm" aria-label="待确认维护会话计划"><h3>待确认 · {titles[p.action]}</h3><InfoRow label="作用范围" value={p.scope==='ledger_only'?'只更新原账本，不操作组件':p.scope==='own_execution_startup_only'?'仅恢复自有后台和执行入口':'当前 Host 的自有导览、网关与原生智能体'}/>{p.reason&&<InfoRow label="核验依据" value={reasons[p.reason]??'核验未满足要求'}/>}{p.action==='record_observation'&&<InfoRow label="拟记入状态" value={states[p.observedState]??'无法核验'}/>}
   <p>{p.action==='resume_admission'?'核对并持久记录恢复决定，再放行当前有效的自有启动项；不自动重发消息、重试失败请求或放宽任务审批。':p.action==='acquire'?'先记意图，再尝试获取组件锁；不取消现有工作。':p.action==='release'?'只释放本次已有组件锁；普通任务可能继续执行。':p.action==='record_observation'?'只补记当前观察，不获取、释放或重建锁。':'保留历史，将原记录标为已收尾；不发进程信号，新维护需另行确认。'}</p>
   {p.action==='acquire'&&!p.ownerProofAvailable&&<Callout tone="warn">当前无法记录进程出生身份；若重启后留下未完成记录，不能自动证明旧实例已退出。</Callout>}
   {p.reasons?.length>0&&<Callout tone="warn">存在活动或无法核验的组件，本计划不能应用。稍后手动核对，不中断现有任务。</Callout>}
   {!p.canApply&&<Callout tone="warn">证据未满足，本计划不可确认；不以未知状态代替空闲或退出。</Callout>}
   <p className="fine-print">计划有效至 {new Date(p.expiresAt).toLocaleTimeString()}，确认时再次核验。</p><CheckRow checked={consent} disabled={!g.confirm} onChange={setConsent} title={'我确认仅'+titles[p.action]} sub="不是整机停机、升级、卸载或任务执行授权。"/>
   <div className="connection-actions"><Button kind="primary" disabled={!g.confirm||!consent} onClick={()=>act('confirm')}>确认{titles[p.action]}</Button><Button kind="secondary" disabled={v.busy} onClick={()=>{flow.current.cancel();setConsent(false);}}>取消会话计划</Button></div>
  </section>}
  {r&&<section className="maintenance-receipt" aria-label="维护会话历史回执"><h3>查询到的记录 · {historyStates[r.state]??'状态需核对'}</h3><p>这是账本事实，不代表整机已排空，也不代表历史请求均已成功。</p>{c?.receipt?.id!==r.id&&<p>当前另有更新的维护记录，请以上方“当前观察”为准。</p>}<InfoRow label="记录时间" value={new Date(r.updatedAt).toLocaleString()}/><details className="plan-item"><summary>诊断信息</summary><code>{r.id}</code><InfoRow label="历史记录数" value={c?.historyCount??'未知'}/></details></section>}
  {v.error&&<p className="connection-error" role="alert">{errors[v.error]??'本次结果无法确认；先手动核对，不自动重试。'} <code>{v.error}</code></p>}
 </Panel>;
}
