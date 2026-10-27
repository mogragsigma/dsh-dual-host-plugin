import React,{useEffect,useRef,useState} from 'react';
import {Button,Callout,CheckRow,InfoRow,Mascot} from './components';
import {createUninstallFlow,uninstallUiActions,uninstallLabels} from './plugin-uninstall-flow';
const label=s=>uninstallLabels[s]??'尚无卸载回执';
const recoveryLabels={cancel_proven_unstarted_uninstall:'取消已证实尚未开始的卸载',rollback_incomplete_changes:'恢复原规则与 Skill',finalize_receipt:'核对已移除规则并完成插件退役',finish_recorded_uninstall:'继续核对原卸载记录'};
const reasons={user_configuration_credentials_sessions_preserved:'配置、凭据与会话保留',tasks_and_artifacts_preserved:'任务与成果保留',all_history_and_retired_image_preserved:'卸载记录、历史与退役插件备份保留',unknown_sidecars_preserved:'用户旁置文件保留'};
function OpenUninstall({request,operationId,stoppedUntil,busy:parentBusy,onMutation}){
 const callback=useRef(onMutation);callback.current=onMutation;
 const [s,setState]=useState({}),[flow]=useState(()=>createUninstallFlow(request,setState,{operationId,onMutation:()=>callback.current?.()})),[checked,setChecked]=useState(false),[,tick]=useState(0);
 useEffect(()=>{flow.resume();flow.act('load');return()=>flow.dispose();},[flow]);
 const stopped=stoppedUntil>Date.now()&&!parentBusy,actions=uninstallUiActions({...s,busy:s.busy||parentBusy},{stopped}),plan=s.plan,u=s.record;
 useEffect(()=>{setChecked(false);if(!plan)return;const id=setTimeout(()=>{setChecked(false);tick(x=>x+1);},Math.max(0,plan.value.expiresAt-Date.now())+1);return()=>clearTimeout(id);},[plan]);
 useEffect(()=>{setChecked(false);if(!stoppedUntil)return;const id=setTimeout(()=>{setChecked(false);tick(x=>x+1);},Math.max(0,stoppedUntil-Date.now())+1);return()=>clearTimeout(id);},[stoppedUntil]);
 const act=name=>{setChecked(false);if(!parentBusy)return flow.act(name,{stopped:stoppedUntil>Date.now()});};
 const rows=u?.plans?.filter(p=>p.kind==='apply')??[],r=u?.requests?.filter(r=>r.targetId===s.id&&r.receipt?.state!=='refused').at(-1),observation=s.observation?.value;
 return <div className="version-maintenance-body">
  <p className="fine-print">打开只读本端历史。远端查询和每次执行均由你手动触发，不定时刷新、不自动停机或重启。</p>
  <div className="form-actions"><Button icon="reset" disabled={!actions.load} onClick={()=>act('load')}>重读本端卸载记录</Button></div>
  {s.busy&&<p role="status">正在处理本次卸载请求，请勿重复操作。</p>}
  {s.error&&<Callout tone="warn"><span role="alert">当前结果尚需核对。先重读本端记录，再查询原卸载；不要重复提交。</span><code>{s.error}</code></Callout>}
  {s.loaded&&!u?.supported&&<Callout>原安装归档没有完整卸载请求契约。保留原环境，不替换旧控制器或删除历史来取得权限。</Callout>}
  {u?.supported&&<>
   <Callout>这里只撤下自有插件、托管规则与未被修改的 Skill。配置、凭据、会话、成果、依赖和历史备份保留；不是清空 ECS，也不卸载本地控制器。</Callout>
   {!stopped&&<Callout>需要先在上方手动核验状态；若仍运行，明确确认风险停机并核对退出。这里不会代为停止 Host。</Callout>}
   {s.otherPending&&<Callout tone="warn">版本切换、规则配套仍有未核对请求。请先查询并完成原事务，暂不开始卸载。</Callout>}
   {(u.pending||s.uncertain)&&<Callout tone="warn">卸载尚未核对，重启与新维护被阻止。查询不会重新执行，恢复需要单独预览确认。</Callout>}
   {rows.length>0&&<label className="version-choice"><span>卸载记录</span><select aria-label="卸载记录" value={s.id} disabled={!!s.busy||parentBusy} onChange={e=>flow.select(e.target.value)}>{rows.map((p,i)=><option value={p.id} key={p.id}>{p.version} · 第 {i+1} 次</option>)}</select></label>}
   <InfoRow label="历史卸载回执" value={r?.state==='requested'?'请求结果未知':label(r?.receipt?.state)}/>
   <div className="form-actions"><Button disabled={!actions.preview} onClick={()=>act('preview')}>预览卸载范围</Button><Button disabled={!actions.status} onClick={()=>act('status')}>查询原卸载</Button><Button disabled={!actions.recover_preview} onClick={()=>act('recover_preview')}>预览卸载恢复</Button></div>
   {observation&&<div className="version-observation" aria-live="polite"><strong>本次观察</strong><p>{observation.canApply===false?'发现冲突，未生成可执行卸载计划。':observation.state?label(observation.state):'已取得待确认计划；目标文件尚未改变。'}</p>{observation.conflicts?.length>0&&<ul>{observation.conflicts.map((x,i)=><li key={i}><code>{x.code}</code>{x.path&&<span> · {x.path}</span>}</li>)}</ul>}</div>}
   {plan&&<section className="cloud-confirm version-confirm" aria-label="自有能力卸载确认">
    <h3>{plan.action==='apply'?'确认卸载自有能力':recoveryLabels[plan.value.action]??'确认恢复原卸载'}</h3>
    <p>{plan.action==='apply'?'先保护性移除自有规则与 Skill，再将已核验插件目录移入保留区；用户修改或未知文件会阻止操作。':'仅处理原卸载事务；不会重发应用、删除未知锁或重建归属。'}</p>
    <InfoRow label="版本" value={plan.value.version??rows.find(x=>x.id===s.id)?.version}/>
    {plan.value.changes&&<details><summary>查看 {plan.value.changes.length} 项变化</summary><ul>{plan.value.changes.map(x=><li className="plan-item" key={x.path}><code>{x.path}</code> · {x.action==='retire_owned_image'?'退役并保留插件备份':x.action==='remove'?'移除自有文件':'仅移除自有托管块'}</li>)}</ul></details>}
    {plan.value.retained&&<details open><summary>保留内容</summary><ul>{plan.value.retained.map((x,i)=><li className="plan-item" key={i}><span>{reasons[x.reason]??'保留用户内容'}</span><code>{x.path}</code></li>)}</ul></details>}
    <p className="fine-print">有效至 {new Date(plan.value.expiresAt).toLocaleString()}。取消或关闭后不保留批准。</p>
    {!actions.confirm&&<Callout tone="warn">计划、停机观察或请求状态已变化，请重新核对；不会自动续期。</Callout>}
    <CheckRow title="我已核对移除范围与保留内容" sub="不清空 Host，不删除任务/凭据/备份，不自动重启或开放开发写入。" checked={checked} onChange={setChecked} disabled={!actions.confirm}/>
    <div className="form-actions"><Button kind="primary" disabled={!actions.confirm||!checked} onClick={()=>{setChecked(false);if(!parentBusy)flow.act('confirm',{confirmed:true,stopped:stoppedUntil>Date.now()});}}>{plan.action==='apply'?'确认卸载自有能力':'确认本次恢复'}</Button><Button disabled={!!s.busy} onClick={()=>{setChecked(false);flow.cancel();}}>取消本次确认</Button></div>
   </section>}
  </>}
 </div>;
}
export function PluginUninstall(props){const [open,setOpen]=useState(false);return <section className="cloud-plan version-maintenance" aria-label="保护性卸载自有能力"><div className="version-heading"><div><h3>保护性卸载自有能力</h3><p>撤下能力，不清空数据。每一步都可核对。</p></div><Mascot pose="tasks"/></div><Button aria-expanded={open} disabled={props.busy} onClick={()=>setOpen(x=>!x)}>{open?'收起卸载维护':'展开卸载维护'}</Button>{open&&<OpenUninstall {...props}/>}</section>;}
