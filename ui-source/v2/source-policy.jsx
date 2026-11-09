import React,{useState,useEffect} from 'react';
import {Button,Panel,InfoRow} from '../onboarding/components';
const modes={off:'仅响应交办',observe:'观察候选',auto:'自动处理'};
const states={pending:'待判断',unavailable:'暂无法判断',ignored:'未接新单',observed:'仅观察',owned:'已归入原任务',accepted:'已受理'};
const guide=(id,title,text)=>({'data-guide':id,'data-guide-title':title,'data-guide-text':text});
export function SourcePolicy({kind,request,draft}){
 const [snapshot,setSnapshot]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[page,setPage]=useState(0),[refresh,setRefresh]=useState(0);
 useEffect(()=>{let alive=true;setBusy(true);setError('');request('source-status',{after:page,limit:20}).then(x=>{if(alive)setSnapshot({...x,readAt:Date.now()});}).catch(()=>{if(alive)setError('未能读取云端状态。已有内容仅为历史快照；不会自动重试或切换到本地。');}).finally(()=>{if(alive)setBusy(false);});return()=>{alive=false;};},[request,page,refresh]);
 const prepare=(title,text)=>draft(title,`${text}\n请先回读当前配置与原回执，核对版本后处理；此处仅为指示草稿，未执行。`);
 const policyDraft=()=>prepare('准备主动工作策略','请核对现有来源后整理主动工作计划：来源与范围、明确目标、文案或局部视觉修正规则、工作目录、交付方式、本期自动新建任务总数（由我指定，不代填）、可选业务期限。先给我确认，不启动真实来源、不调用执行模型、不发送消息。已有任务保留还是撤销依赖，修改前另行说明。');
 return <>
  <div className="v2-section-title"><p className="v2-muted">{snapshot?`${error?'历史':'最近'}快照 · ${new Date(snapshot.readAt).toLocaleTimeString('zh-CN')}`:'等待云端状态'}</p><Button icon="reset" disabled={busy} onClick={()=>setRefresh(x=>x+1)}>刷新状态</Button></div>
  {error&&<p role="alert">{error}</p>}{busy&&!snapshot&&<p role="status">读取中…</p>}
  {snapshot&&<>
   <Panel title="处理模式" sub="来源开关控制接收；模式只决定新主动事项。关闭自动接单不会暂停有效存量任务。撤销策略授权是另一个动作。">
    <div {...guide('source-mode','先区分模式与撤销','这里显示云端实际模式。按钮只准备对话草稿；关闭自动接单不等于暂停已有任务。')}><InfoRow label="当前模式" value={modes[snapshot.mode.mode]??'未知'}/><div className="v2-source-actions">{Object.entries(modes).map(([mode,label])=><Button key={mode} disabled={busy||!!error||snapshot.mode.mode===mode} onClick={()=>mode==='auto'?policyDraft():prepare('调整处理模式',`请将云端主动工作模式调整为 ${mode}（${label}），当前版本 ${snapshot.mode.version}；有效存量任务继续，不撤销策略授权，不补跑旧候选。`)}>准备{label}</Button>)}</div></div>
   </Panel>
   {kind==='sources'&&<Panel title="已配置来源" sub="这是配置与接收状态，不是平台已连通证明。真实来源接入需要另行确认；不会新增 IM 消费者。">
    <div {...guide('source-bindings','核对来源与接收','来源停用只影响这一来源，不关闭机器人，也不撤销独立任务权限。真实接入未经验证时会明确显示。')}>
    {!snapshot.sources.length&&<p className="v2-muted">尚未配置来源</p>}
    {snapshot.sources.map(s=><article className="v2-source-item" key={s.id}><div className="v2-section-title"><h3>{s.id}</h3><span className="v2-status">{s.enabled?'允许接收':'已停用'}</span></div><InfoRow label="真实接入" value="未接入验证"/><InfoRow label="范围" value={s.scopes.join('、')}/><InfoRow label="已存事实" value={s.records??'未知'}/>{s.lastError&&<p role="status">接收异常：{s.lastError}</p>}<Button disabled={busy||!!error} onClick={()=>prepare(s.enabled?'停用来源':'启用来源',`请${s.enabled?'停用':'启用'}来源 ${s.id}，当前配置版本 ${s.revision}。只影响该来源，${s.enabled?'已有资料与独立任务保留':'从新切点开始，不补跑旧积压或恢复已停止任务'}。`)}>准备{s.enabled?'停用':'启用'}</Button></article>)}
    </div></Panel>}
   {kind==='policy'&&<Panel title="主动工作策略" sub="总数只计算本期自动新建任务；跟进、模型调用不计入。重启、修改配置和任务失败不清零，换期需明确确认。" extra={<Button onClick={policyDraft}>准备策略</Button>}>
    <div {...guide('source-policy','撤销与停新单不同','点击这里只准备撤销草稿，需到原生对话提交。撤销影响已有依赖任务；只想停接新单，请改处理模式。原生在途动作可能仍在收拢。')}>
     {!snapshot.policies.length&&<p className="v2-muted">尚未确认主动工作策略</p>}
     {snapshot.policies.map(p=><article className="v2-source-item" key={p.id}><div className="v2-section-title"><h3>{p.goal}</h3><span className="v2-status">{p.revoked?'已撤销':p.end_at&&p.end_at<=Date.now()?'业务期限已到':p.used>=p.max_tasks?'本期新单已满':'有效'}</span></div><InfoRow label="本期自动新任务" value={`${p.used} / ${p.max_tasks}`}/><InfoRow label="来源 / 范围" value={`${p.source_id} / ${p.scope}`}/><InfoRow label="本期" value={p.period_id}/><InfoRow label="交付" value={p.delivery}/><InfoRow label="业务期限" value={p.end_at?new Date(p.end_at).toLocaleString('zh-CN'):'未指定'}/><Button disabled={busy||!!error||p.revoked} onClick={()=>prepare('撤销策略授权',`请撤销主动策略 ${p.id}（版本 ${p.revision}）及依赖授权，不只是关闭新接单。报告受影响任务、收拢中和未知状态；保留成果与原回执，不保证撤回已经发生的外部动作。`)}>准备撤销授权</Button></article>)}
     {snapshot.effect.items.length>0&&<p role="status">撤销状态：{snapshot.effect.status==='effective'?'依赖任务已围栏':'仍在收拢或等待执行端确认'}；已发生的外部动作不会自动撤回。</p>}
    </div></Panel>}
   <Panel title="最近判断" sub="原始来源事实保留。无法判断不等于没有需求；仅观察不会创建任务或发送通知。">
    <div {...guide('source-decisions','查看处理结果','这里区分观察、归入原任务、受理和无法判断。来源事实不是本人指示，不会因此取得人工跟进名额。')}>
    <div className="v2-source-columns"><span>来源 / 判断</span><span>当前状态</span></div>
    {snapshot.decisions.map(x=><article className="v2-source-decision" key={x.id}><div><strong>{x.source_id}</strong><p className="v2-muted">{x.result?.assessment?.reason??({ 'existing-task-input':'已交给原任务处理','new-task-total-reached':'本期自动新任务已达总数','proactive-off':'当前仅响应交办','no-policy':'尚无适用策略','cutover-no-backlog-replay':'旧候选未补跑','thread-owner-paused-or-stopped':'原任务已暂停或停止'}[x.result?.reason]??x.result?.reason??'尚无结论')}</p>{x.result?.task_id&&<small>任务 {x.result.task_id}</small>}</div><span className="v2-status">{states[x.status]??x.status}</span></article>)}
    {!snapshot.decisions.length&&<p className="v2-muted">本页暂无判断记录</p>}
    <div className="v2-pagination"><Button disabled={busy||page===0} onClick={()=>setPage(x=>Math.max(0,x-20))}>上一页</Button><Button disabled={busy||snapshot.next_cursor==null} onClick={()=>setPage(snapshot.next_cursor)}>下一页</Button></div>
    </div></Panel>
  </>}
 </>;
}
