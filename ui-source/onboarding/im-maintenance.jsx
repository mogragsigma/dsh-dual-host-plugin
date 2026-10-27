import React,{useState,useRef,useEffect} from 'react';
import {Button,Panel,Callout,Badge,CheckRow,InfoRow,Field} from './components';
import {createImMaintenanceFlow,imMaintenanceActions} from './im-maintenance-flow';
const states={connected:'已连接',disconnected:'已断开',connecting:'连接中',provisioning:'配置中',error:'连接异常'};
const phases={intent:'已记录意图 · 结果未知',acknowledged:'已收到该次操作回执',needs_review:'结果待核对',reviewed:'已补记当前观察 · 原操作结果未追认'};
const titles={disconnect:'断开机器人',reconnect:'恢复机器人连接',review:'补记当前连接观察'};
const errors={ONBOARDING_IM_MAINTENANCE_REFERENCE_UNAVAILABLE:'查询引用无法保存，请求未发送。请检查浏览器存储。',ONBOARDING_IM_MAINTENANCE_OWN_DISCONNECT_REQUIRED:'本插件没有找到可核验的断开记录，不能从这里恢复连接。请使用原生 IM 管理入口。',ONBOARDING_IM_MAINTENANCE_ORIGINAL_IN_FLIGHT_UNVERIFIED:'原实例的请求仍可能在途，不能收尾。请保留记录，稍后手动核对。',ONBOARDING_IM_MAINTENANCE_PLAN_EXPIRED:'计划已过期或失效，请重新手动核对并预览。',ONBOARDING_IM_MAINTENANCE_CONFIG_CHANGED:'机器人配置已变化，请保留现场核对，不覆盖旧记录。'};
export function ImMaintenance({request,contract=0,allowMutation=false}){
 const [state,setState]=useState(null),[consent,setConsent]=useState(false),alive=useRef(true),flow=useRef();
 if(!flow.current){let storage;try{storage=globalThis.sessionStorage;}catch{}flow.current=createImMaintenanceFlow(request,v=>{if(alive.current)setState(v);},contract,storage,Date.now,allowMutation);}
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const s=state??flow.current.get(),g=imMaintenanceActions(s,contract,Date.now(),allowMutation),c=s.current,p=s.plan,r=s.receipt,action=p?.kind==='review'?'review':p?.action;
 const act=name=>{setConsent(false);return flow.current.act(name,consent);};
 return <Panel title="IM 连接维护" sub="只操作当前 Host 的单个飞书机器人；不通过本页远程切换另一端。" icon="chat" className="connection-panel" extra={<Badge>默认不操作</Badge>}>
  <Callout tone="warn" title="断开可能中止在途消息">可能中止正在发送的消息、媒体和待决交互，不是无损暂停。配置按官方接口约定保留；恢复连接需另行确认。Host 重启可能自动重连，不代表整机已停机或可安全升级。</Callout>
  <section className="maintenance-status" aria-label="IM 当前连接观察"><InfoRow label="当前观察" value={!c?'尚未手动核对':c.inventoryState==='unavailable'?'连接清单不可用 · 仅展示账本':c.bots.length?`${c.bots.length} 个飞书机器人`:'没有已配置的飞书机器人'}/><p className="fine-print">{s.observedAt?'观察时间：'+new Date(s.observedAt).toLocaleString()+(s.fresh?'':' · 已过时，请重新核对'):'打开页面不读取连接、不自动断开、不定时刷新。'}</p>
   {c?.inventoryState==='observed'&&c.bots.length>0&&<Field label="本次维护的机器人" hint="按名称选择，不用输入编号；连接状态只是当前观察，不证明消息已成功送达。"><select value={s.selected} disabled={s.busy} onChange={e=>{flow.current.select(e.target.value);setConsent(false);}}><option value="">请选择机器人</option>{c.bots.map(b=><option key={b.botId} value={b.botId}>{b.name} · {states[b.state]}</option>)}</select></Field>}
   {c?.pending&&<Callout tone="warn">当前另有未完成记录：{phases[c.receipt.phase]}。先核对账本，不重复断开或恢复。</Callout>}
  </section>
  <div className="connection-actions"><Button kind="secondary" icon="reset" disabled={s.busy||contract!==1} onClick={()=>act('refresh')}>手动核对 IM 与回执</Button>{['disconnect','reconnect','review'].filter(k=>g[k]).map(k=><Button key={k} kind="soft" onClick={()=>act(k)}>预览{titles[k]}</Button>)}</div>
  {(!allowMutation||c?.inventoryState==='unavailable')&&<p className="fine-print">当前只可查询维护账本；未取得公开 IM 接口与实时观察，不允许连接变更。</p>}
  {s.storageError&&<Callout tone="warn">浏览器查询引用无法读取或已损坏。保留原数据，所有连接变更保持关闭；本页不清理历史。</Callout>}
  {s.uncertain&&!s.storageError&&<Callout tone="warn">尚未找到与上次请求完全对应的回执。只核对，不重发；不能把“现在已断开”当作原请求成功。</Callout>}
  {p&&<section className="connection-confirm" aria-label="待确认 IM 维护计划"><h3>待确认 · {titles[action]}</h3><InfoRow label="作用范围" value={action==='review'?'只补记账本，不操作机器人':p.botName}/><p>{action==='review'?'仅保存当前观察，不追认原发送或原连接操作成功，也不自动恢复连接。':action==='disconnect'?'这次明确断开可能中止在途消息和交互。不会删除机器人配置，不会自动恢复。':'仅恢复这个机器人连接；不重放历史失败消息，不代表未完成的发送已经恢复。'}</p>{action==='review'&&<InfoRow label="拟记录的当前状态" value={states[p.observedState]}/>}
   <p className="fine-print">有效至 {new Date(p.expiresAt).toLocaleTimeString()}，确认时再次核验；关闭窗口不撤销已发送的请求。</p><CheckRow checked={consent} onChange={setConsent} disabled={!g.confirm} title={action==='review'?'我确认仅补记观察，不追认原操作成功':'我确认本次'+titles[action]+'，理解可能中止在途 IM'} sub="不授权 Host 停止、插件切换、开发或发布。"/><div className="connection-actions"><Button kind="primary" disabled={!g.confirm||!consent} onClick={()=>act('confirm')}>确认{titles[action]}</Button><Button kind="secondary" disabled={s.busy} onClick={()=>{flow.current.cancel();setConsent(false);}}>取消 IM 计划</Button></div>
  </section>}
  {r&&<section className="maintenance-receipt" aria-label="IM 历史回执"><h3>历史回执 · {phases[r.phase]}</h3><p>历史结果不等于当前连接状态，也不证明在途消息成功送达。</p>{c?.receipt?.id!==r.id&&<p>当前有更新的记录；这里保留你上次请求的历史回执。</p>}<InfoRow label="记录时间" value={new Date(r.updatedAt).toLocaleString()}/><InfoRow label="当时观察" value={states[r.observedState]??'未知 · 未视为成功'}/><details className="plan-item"><summary>诊断引用</summary><code>{r.id}</code></details></section>}
  {s.error&&<p className="connection-error" role="alert">{errors[s.error]??'本次结果无法确认；请手动核对，不自动重试。'} <code>{s.error}</code></p>}
 </Panel>;
}
