import React,{useEffect,useRef,useState} from 'react';
import {Button,Callout,CheckRow,InfoRow,Mascot} from './components';
import {createReclaimFlow,reclaimUiActions,reclaimResultLabel} from './runtime-reclaim-flow';
function OpenReclaim({request,operationId,stoppedUntil,busy:parentBusy,onMutation}){
 const callback=useRef(onMutation);callback.current=onMutation;
 const [s,setState]=useState({}),[flow]=useState(()=>createReclaimFlow(request,setState,{operationId,onMutation:()=>callback.current?.()})),[checked,setChecked]=useState(false),[,tick]=useState(0);
 useEffect(()=>{flow.resume();flow.act('load');return()=>flow.dispose();},[flow]);
 const plan=s.plan,stopped=stoppedUntil>Date.now()&&!parentBusy,actions=reclaimUiActions({...s,busy:s.busy||parentBusy},{stopped});
 useEffect(()=>{setChecked(false);if(!plan)return;const id=setTimeout(()=>{setChecked(false);tick(x=>x+1);},Math.max(0,plan.value.expiresAt-Date.now())+1);return()=>clearTimeout(id);},[plan]);
 useEffect(()=>{setChecked(false);if(!stoppedUntil)return;const id=setTimeout(()=>{setChecked(false);tick(x=>x+1);},Math.max(0,stoppedUntil-Date.now())+1);return()=>clearTimeout(id);},[stoppedUntil]);
 const act=name=>{setChecked(false);if(!parentBusy)return flow.act(name,{stopped:stoppedUntil>Date.now()});},r=s.record?.requests?.at(-1),v=s.observation?.value;
 return <div className="version-maintenance-body">
  <p className="fine-print">打开只读本端记录。远端查询和每次执行均手动触发；不定时刷新，不自动停机、重启或重复删除。</p>
  <div className="form-actions"><Button icon="reset" disabled={!actions.load} onClick={()=>act('load')}>重读本端回收记录</Button></div>
  {s.busy&&<p role="status">正在处理本次回收请求，请勿重复操作。</p>}
  {s.error&&<Callout tone="warn"><span role="alert">{s.error==='ONBOARDING_CLOUD_RUNTIME_RECLAIM_PLAN_EXPIRED'?'本次确认已失效。请重读本端记录后重新预览；旧确认不会重发。':'当前结果需要核对。先重读本端记录，再查询原回收；不要重复提交删除。'}</span><code>{s.error}</code></Callout>}
  {s.loaded&&!s.record?.supported&&<Callout>原安装归档不支持持久回收请求。保持原环境，不改写旧归档补能力。</Callout>}
  {s.record?.supported&&<>
   <Callout tone="warn">回收会永久删除原清单中的依赖和运行时程序文件，不承诺恢复已删除文件。配置、凭据、会话、成果、退役插件和历史备份保留；不是清空 ECS 或整个目录。</Callout>
   {!s.uninstallCompleted&&<Callout>请先完成上方“保护性卸载自有能力”，并手动核对卸载回执。</Callout>}
   {!stopped&&<Callout>请先在上方手动核验 Host 已退出。这里不会代为停机，也不把旧观察当作当前状态。</Callout>}
   {s.otherPending&&<Callout tone="warn">版本、规则或卸载仍有待核对事务。先处理原记录，不开始回收。</Callout>}
   {r?.receipt?.workerActive===true&&!s.uncertain&&<Callout>上次观察到后台回收正在执行，不代表已经完成。请手动查询进度；运行期间不能重复启动或确认恢复。</Callout>}
   {(s.record.pending&&r?.receipt?.workerActive!==true||s.uncertain)&&<Callout tone="warn">原回收结果尚未完整核对；查询不继续删除。即使暂未观察到目标意图，也不表示旧请求从未执行，恢复须另行确认。</Callout>}
   <InfoRow label="历史回收回执" value={s.uncertain||r?.state==='requested'?'请求结果未知':reclaimResultLabel(r?.receipt)}/>
   <div className="form-actions"><Button disabled={!actions.preview} onClick={()=>act('preview')}>预览运行时回收</Button><Button disabled={!actions.status} onClick={()=>act('status')}>查询原回收</Button><Button disabled={!actions.recover_preview} onClick={()=>act('recover_preview')}>预览原回收恢复</Button></div>
   {v&&<div className="version-observation" aria-live="polite"><strong>本次观察</strong><p>{v.canApply?'已取得待确认范围，尚未删除文件。':reclaimResultLabel(v)}</p>{v.total>0&&<InfoRow label="已记账条目" value={`${v.completed??0} / ${v.total}`}/>}</div>}
   {plan&&<section className="cloud-confirm version-confirm" aria-label="独立运行时回收确认">
    <h3>{plan.action==='apply'?'确认回收运行时文件':'确认恢复原回收'}</h3>
    <p>{plan.action==='apply'?'只处理原签名清单，遇到未知文件或归属变化就保留待核对。':plan.value.action==='start_original_manifest_if_still_unobserved'?'当前未观察到目标意图。再次确认后，仅在仍未出现意图且原范围仍吻合时登记并执行；迟到请求不能触发重复删除。':'只继续原清单的未完成部分，不扩大范围、不重新安装或启动 Host。'}</p>
    {plan.action==='apply'&&<><InfoRow label="回收范围" value={`${plan.value.files} 个文件 · ${plan.value.entries} 个条目`}/><InfoRow label="文件总量" value={`${(plan.value.bytes/1024/1024).toFixed(2)} MiB`}/><details><summary>查看将清理的运行时目录</summary><ul>{plan.value.removeRoots.map(x=><li className="plan-item" key={x}><code>{x}</code></li>)}</ul></details></>}
    <details open><summary>始终保留</summary><ul><li>原生配置、凭据、会话、临时数据与任务成果</li><li>原安装源、退役插件、控制账本及全部历史备份</li><li>用户原有规则、旁置文件及非本次清单内容</li></ul></details>
    <p className="fine-print">有效至 {new Date(plan.value.expiresAt).toLocaleString()}。关闭或取消不保留批准。</p>
    {!actions.confirm&&<Callout tone="warn">计划、停机观察或请求状态已变化，请手动核对；不会自动续期。</Callout>}
    <CheckRow title="我确认仅回收上述运行时文件，并理解删除不可逆" sub="保留用户数据与全部历史；不会自动重启或开放业务写入。" checked={checked} onChange={setChecked} disabled={!actions.confirm}/>
    <div className="form-actions"><Button kind="primary" disabled={!actions.confirm||!checked} onClick={()=>{setChecked(false);if(!parentBusy)flow.act('confirm',{confirmed:true,stopped:stoppedUntil>Date.now()});}}>{plan.action==='apply'?'确认永久回收运行时':'确认本次恢复'}</Button><Button disabled={!!s.busy} onClick={()=>{setChecked(false);flow.cancel();}}>取消本次确认</Button></div>
   </section>}
  </>}
 </div>;
}
export function RuntimeReclaim(props){const [open,setOpen]=useState(false);return <section className="cloud-plan version-maintenance" aria-label="独立运行时精确回收"><div className="version-heading"><div><h3>独立运行时精确回收</h3><p>完成卸载后再回收程序文件，数据与历史留下。</p></div><Mascot pose="tasks"/></div><Button aria-expanded={open} disabled={props.busy} onClick={()=>setOpen(x=>!x)}>{open?'收起运行时回收':'展开运行时回收'}</Button>{open&&<OpenReclaim {...props}/>}</section>;}
