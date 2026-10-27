import React from 'react';
import {Button,Callout,InfoRow} from './components';
import {repairPresentation} from './repair-presentation';
const states={not_started:'尚无修复记录',committed:'同版本文件已修复',rolled_back:'修复已回滚',needs_review:'修复中断，待核对',applying:'修复结果待核对',refused:'本次修复未执行',planned:'修复计划尚未执行',preparing:'修复预览待核对'};
export function PluginRepair({s,actions,act,confirm}){
 if(!s.repairCapability?.supported)return null;
 const plan=s.repairPlan,r=s.repairStatus?.repair,a=s.repairStatus?.activation;
 const activationSupported=s.repairCapability.activationSupported&&r?.activationSupported!==false&&plan?.activationSupported!==false;
 const presentation=repairPresentation(s);
 const observed=presentation.observedAt?new Date(presentation.observedAt).toLocaleString():null;
 return <section className="cloud-plan plugin-repair" aria-label="自有插件修复与生效核验">
  <h3>自有插件修复与生效核验</h3>
  <p>只从签名历史对应的同版本归档恢复已列出的自有文件。不修改 DSH、第三方插件、用户规则、凭据或任务成果。</p>
  {(plan?.version||r?.version)&&<InfoRow label="修复版本" value={plan?.version??r.version}/>}
  <InfoRow label="文件修复" value={s.repairPending?'原修复事务待核对':states[r?.state]??'尚未核对'}/>
  <InfoRow label="加载生效" value={presentation.label}/>
  {observed&&<p className="fine-print">核验时间：{observed}。这是当时的观察，不是实时在线保证。{(!a.sameRecordedRepair||!a.sameRecordedHost)&&' 记录与当前已登记的修复或 Host 不同，不能沿用。'}</p>}
  {!s.repairFresh&&<p className="fine-print">当前显示本地历史回执；上方手动刷新才会查询远端，不自动修复或重启。</p>}
  {s.repairPending&&<Callout tone="warn">不要重复应用或另建事务。先手动刷新原记录；确认远端中断及 Host 已停止后，才可单独恢复原事务。</Callout>}
  <div className="form-actions" role="group" aria-label="修复操作">
   <Button disabled={!actions.runtime_repair_preview} onClick={()=>act('runtime_repair_preview')}>预览同版本修复</Button>
   {activationSupported&&<Button disabled={!actions.runtime_repair_verify} onClick={()=>act('runtime_repair_verify')}>核验新进程已加载</Button>}
  </div>
  {plan&&<div className="cloud-confirm" aria-label="修复差异计划">
   <InfoRow label="待修复文件" value={plan.changes.length+' 项'}/>
   {plan.changes.length>0&&<details open={plan.changes.length<=8}><summary>查看文件差异</summary><ul>{plan.changes.map(x=><li className="plan-item" key={x.path}><code>{x.path}</code> · {x.action==='create'?'恢复缺失文件':'恢复归档内容'}</li>)}</ul></details>}
   <p className="fine-print">计划有效至 {new Date(plan.expiresAt).toLocaleString()}。执行前重新核验停机、归属与文件；未知内容保留。</p>
   {!plan.canApply&&<Callout>没有需要修复的自有文件；不会执行空事务。</Callout>}
   {confirm('runtime_repair_apply','修复已列出的文件','仅替换上方确切文件，保存错误内容备份和签名归属增量；不更新整体归属清单，不启动 Host。')}
  </div>}
  {confirm('runtime_repair_recover','恢复原修复事务','只核对并恢复原事务；发生冲突则保留待核对，不重发原应用，不接管未知文件，不启动 Host。')}
  {presentation.guidance&&<Callout>{presentation.guidance}</Callout>}
  {!activationSupported&&<Callout>此修复路径尚不提供独立生效核验；保留文件回执，不宣称在线加载，不自动重启或更换原控制器。</Callout>}
 </section>;
}
