import React,{useEffect,useRef,useState} from 'react';
import {Button,Callout,InfoRow,CheckRow,Mascot} from './components';
import {createVersionFlow,versionUiActions,versionLabels} from './plugin-version-flow';
const titles={receive:'接收候选文件',apply:'切换插件文件',rollback:'回滚插件文件',recover:'恢复原文件事务',rules_apply:'配套更新规则与 Skill',rules_recover:'恢复原规则事务'};
const descriptions={receive:'发送本端冻结的自有候选包。不安装依赖、不替换现用插件、不启动 Host。',apply:'只切换当前已停止 Host 的自有插件目录，保留旧版本备份。之后仍需规则配套与独立重启确认。',rollback:'只恢复原插件目录。不会顺带覆盖用户规则；如规则版本不匹配，须另行预览并确认配套。',recover:'只恢复原中断文件事务，不重发切换，不接管未知文件。',rules_apply:'只更新自有托管块与未被用户修改的 Skill，保留用户前后文字、凭据和成果。不会自动重启。',rules_recover:'只核对并恢复原规则事务；缺少日志或出现冲突时保留待核对，不强行清锁。'};
const label=s=>versionLabels[s]??'尚未核对';
function Choose({label:caption,items,value,onChange,disabled}){return items?.length>0&&<label className="version-choice"><span>{caption}</span><select aria-label={caption} value={value} disabled={disabled} onChange={e=>onChange(e.target.value)}>{items.map((p,i)=><option key={p.id} value={p.id}>{p.version??`${p.fromVersion} → ${p.toVersion}`} · 第 {i+1} 次</option>)}</select></label>;}
function OpenVersionMaintenance({request,operationId,stoppedUntil,busy:parentBusy,onMutation}){
 const callback=useRef(onMutation);callback.current=onMutation;
 const [s,setState]=useState({}),[flow]=useState(()=>createVersionFlow(request,setState,{operationId,onMutation:()=>callback.current?.()})),[checked,setChecked]=useState(false),[,tick]=useState(0);
 useEffect(()=>{flow.resume();flow.act('load');return()=>flow.dispose();},[flow]);
 const stopped=stoppedUntil>Date.now()&&!parentBusy,actions=versionUiActions({...s,busy:s.busy||parentBusy},{stopped}),plan=s.plan,v=s.versions,a=s.artifacts;
 useEffect(()=>{setChecked(false);if(!plan)return;const timer=setTimeout(()=>{setChecked(false);tick(x=>x+1);},Math.max(0,plan.value.expiresAt-Date.now())+1);return()=>clearTimeout(timer);},[plan]);
 useEffect(()=>{if(!stoppedUntil)return;const timer=setTimeout(()=>{setChecked(false);tick(x=>x+1);},Math.max(0,stoppedUntil-Date.now())+1);return()=>clearTimeout(timer);},[stoppedUntil]);
 const act=name=>{setChecked(false);if(parentBusy)return;return flow.act(name,{stopped:stoppedUntil>Date.now()});};
 const vr=v?.requests?.filter(r=>r.targetId===s.versionId).at(-1),ar=a?.requests?.filter(r=>r.targetId===s.artifactId).at(-1);
 const observation=s.observation?.value,plannedChanges=plan?.value?.changes,liveObservation=observation?.scope==='maintained_plugin_version_observed'?observation:null,history=s.activation?.records?.filter(r=>r.requestedTransactionId===s.versionId).at(-1);
 return <div className="version-maintenance-body">
  <p className="fine-print">重新打开只读本端历史。查询远端、文件切换、规则配套和重启分别操作；不会定时刷新。</p>
  <div className="form-actions"><Button icon="reset" disabled={!actions.load} onClick={()=>act('load')}>重读本端维护记录</Button></div>
  {s.busy&&<p role="status">正在处理本次维护请求，请勿重复操作。</p>}
  {s.error&&<Callout tone="warn"><span role="alert">结果尚需核对。请先重读本端记录，再查询原候选或事务；不要因报错重新发送。</span><code>{s.error}</code></Callout>}
  {(v?.pending||a?.pending||s.uncertain)&&<Callout tone="warn">存在未核对请求。新切换和重启仍被门禁阻止；查询不代表重新执行。</Callout>}
  {s.loaded&&!v?.supported&&<Callout>原安装归档没有版本维护契约。保留原环境，不替换旧控制器接管。</Callout>}
  {v?.supported&&<>
   {!stopped&&<Callout>先在上方手动核验状态，明确确认风险停机并核对退出。文件操作需要退出证明；读取加载状态不要求停机，也不会代为停机。</Callout>}
   <ol className="phase-timeline version-phases">
    <li><span className="phase-dot">1</span><div className="phase-copy"><h3>准备自有候选</h3><p>只取本端自有分发包；预览会保存本地冻结快照，不联系 ECS。</p>
     <Choose label="候选版本" items={v.candidates} value={s.candidateId} disabled={!!s.busy} onChange={x=>flow.select('candidateId',x)}/>
     <div className="form-actions"><Button disabled={!actions.candidate_preview} onClick={()=>act('candidate_preview')}>预览本端候选</Button><Button disabled={!actions.candidate_status} onClick={()=>act('candidate_status')}>核对候选接收</Button></div>
    </div></li>
    <li><span className="phase-dot">2</span><div className="phase-copy"><h3>切换插件文件</h3><InfoRow label="历史文件回执" value={vr?.state==='requested'?'请求结果未知':label(vr?.receipt?.state)}/>
     <Choose label="文件版本事务" items={v.plans?.filter(x=>x.kind==='apply')} value={s.versionId} disabled={!!s.busy} onChange={x=>flow.select('versionId',x)}/>
     <div className="form-actions"><Button disabled={!actions.preview} onClick={()=>act('preview')}>预览文件切换</Button><Button disabled={!actions.status} onClick={()=>act('status')}>查询原文件事务</Button><Button disabled={!actions.rollback_preview} onClick={()=>act('rollback_preview')}>预览文件回滚</Button><Button disabled={!actions.recover_preview} onClick={()=>act('recover_preview')}>预览中断恢复</Button></div>
    </div></li>
    <li><span className="phase-dot">3</span><div className="phase-copy"><h3>配套规则与 Skill</h3><InfoRow label="历史规则回执" value={ar?.state==='requested'?'请求结果未知':label(ar?.receipt?.state)}/>
     <Choose label="规则配套事务" items={a?.plans?.filter(x=>x.kind==='apply')} value={s.artifactId} disabled={!!s.busy} onChange={x=>flow.select('artifactId',x)}/>
     {!a?.supported?<Callout>原归档不支持规则配套；不能仅凭插件文件切换就启动新版本。</Callout>:<div className="form-actions"><Button disabled={!actions.rules_preview} onClick={()=>act('rules_preview')}>预览规则配套</Button><Button disabled={!actions.rules_status} onClick={()=>act('rules_status')}>查询原规则事务</Button><Button disabled={!actions.rules_recover_preview} onClick={()=>act('rules_recover_preview')}>预览规则恢复</Button></div>}
    </div></li>
    <li><span className="phase-dot">4</span><div className="phase-copy"><h3>核验新进程已加载</h3>
     <p>配套后先在上方另行确认重启，再手动核验。不要求先修复文件，不自动重启或轮询。</p>
     <InfoRow label="历史加载观察" value={history?.observedAt?`${history.pluginVersion} · ${new Date(history.observedAt).toLocaleString()}`:'尚无已记录的加载观察'}/>
     <p className="fine-print">历史记录不是当前在线证明。核验只代表该时刻版本、规则和 Skill 一致，不授予开发或发布权限。</p>
     {!s.activation?.supported?<Callout>原安装归档没有普通版本加载核验契约；更新插件文件不能补授旧控制器权限。</Callout>:<div className="form-actions"><Button disabled={!actions.activation_status} onClick={()=>act('activation_status')}>查询历史加载记录</Button><Button icon="check" disabled={!actions.activation_verify} onClick={()=>act('activation_verify')}>手动核验当前加载</Button></div>}
     {liveObservation&&<Callout tone={liveObservation.activationVerified?'info':'warn'}><strong>{liveObservation.activationVerified?'本次加载核验通过':'仅查询到历史记录，未核验在线状态'}</strong><p>{liveObservation.pluginVersion?`观察版本：${liveObservation.pluginVersion}。`:'尚无成功加载观察。'}{liveObservation.observedAt&&`观察时间：${new Date(liveObservation.observedAt).toLocaleString()}。`}</p>{!liveObservation.activationVerified&&liveObservation.observedAt&&(!liveObservation.sameRecordedRelease||!liveObservation.sameRecordedHost)&&<p>记录所属版本或进程已改变，不可作为当前生效依据。</p>}</Callout>}
    </div></li>
   </ol>
   {observation&&!liveObservation&&<div className="version-observation" aria-live="polite"><strong>本次观察</strong><p>{observation.artifactsMatched?'规则与当前镜像的内容匹配；尚未证明新进程已加载。':observation.canApply===false?'当前没有可执行的配套计划；请查看冲突或已匹配说明。':observation.state?label(observation.state):'已取得待确认计划。'}</p>{observation.conflicts?.length>0&&<ul>{observation.conflicts.map((x,i)=><li key={i}><code>{x.code}</code>{x.path&&<span> · {x.path}</span>}</li>)}</ul>}</div>}
   {plan&&<section className="cloud-confirm version-confirm" aria-label={titles[plan.action]+'确认'}>
    <h3>{titles[plan.action]}</h3><p>{descriptions[plan.action]}</p>
    <InfoRow label="版本" value={plan.value.version??plan.value.targetVersion??`${plan.value.fromVersion??''} → ${plan.value.toVersion??''}`}/>
    {plannedChanges&&<details><summary>查看 {plannedChanges.length} 项文件变化</summary><ul>{plannedChanges.map(x=><li className="plan-item" key={x.path}><code>{x.path}</code> · {x.action}</li>)}</ul></details>}
    <p className="fine-print">有效至 {new Date(plan.value.expiresAt).toLocaleString()}。关闭或取消不会续用批准。</p>
    {!actions.confirm&&<Callout tone="warn">确认暂不可执行：请核对停机状态、未知请求或计划有效期。不会自动续期。</Callout>}
    <CheckRow title="我已核对本次文件维护范围" sub="不自动重启，不开放业务开发、提交、推送或发布。" checked={checked} onChange={setChecked} disabled={!actions.confirm}/>
    <div className="form-actions"><Button kind="primary" disabled={!actions.confirm||!checked} onClick={()=>{setChecked(false);if(!parentBusy)flow.act('confirm',{confirmed:true,stopped:stoppedUntil>Date.now()});}}>确认{titles[plan.action]}</Button><Button disabled={!!s.busy} onClick={()=>{setChecked(false);flow.cancel();}}>取消本次确认</Button></div>
   </section>}
   <Callout>文件切换 ≠ 规则配套 ≠ 加载生效。完成配套后请在上方重新核验状态、独立确认重启；再手动核验新进程加载，不能把历史文件回执当作在线证明。</Callout>
  </>}
 </div>;
}
export function PluginVersionMaintenance(props){const [open,setOpen]=useState(false);return <section className="cloud-plan version-maintenance" aria-label="自有插件版本维护"><div className="version-heading"><div><h3>自有插件版本维护</h3><p>文件、规则、重启与加载核验分开。保留用户规则和原版本备份。</p></div><Mascot pose="tasks"/></div><Button aria-expanded={open} disabled={props.busy} onClick={()=>setOpen(x=>!x)}>{open?'收起版本维护':'展开版本维护'}</Button>{open&&<OpenVersionMaintenance {...props}/>}</section>;}
