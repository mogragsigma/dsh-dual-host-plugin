import React from 'react';
import {flowView} from './attention-flow.mjs';
export function InterventionPanel({item,fresh,onChanged,perform,drafts}){
 const flow=item.preview_flow,view=flowView(flow),id=React.useId();
 const [draft,setDraft]=React.useState(drafts.get(item.task_id)||''),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
 const locked=React.useRef(false),active=React.useRef(true),heading=React.useRef();
 React.useEffect(()=>()=>{active.current=false;},[]);
 React.useEffect(()=>{if(flow.version>1)heading.current?.focus({preventScroll:true});},[flow.version]);
 const update=value=>{setDraft(value);drafts.set(item.task_id,value);};
 async function submit(action){
  if(!fresh||locked.current)return;locked.current=true;setBusy(true);setError('');
  try{await perform({task_id:item.task_id,revision:item.spec_revision,expectedVersion:flow.version,action,text:draft});if(active.current){update('');onChanged();}}
  catch(e){if(active.current)setError(e.message==='PREVIEW_CHANGED'?'处理建议已变化，请刷新后再决定；输入内容已保留。':'本次没有确认处理结果。输入内容已保留，请刷新核对，不要重复提交。');}
  finally{locked.current=false;if(active.current)setBusy(false);}
 }
 const awaiting=/等待你|请确认/.test(view.owner),required=view.actions.some(a=>a.requiresText&&a.tone==='primary');
 return <section className="task-attention preview-intervention" aria-label={awaiting?'待你处理':'处理进展'}>
  <header className="attention-heading mascot-zone"><div><h3>{awaiting?'待你处理':'处理进展'}</h3><p>{view.owner} · 模拟演练</p></div><div className="companion" data-companion="tasks" aria-hidden="true"/></header>
  <div className="flow-steps" aria-label="处理阶段">{['核对','建议','处理','结束'].map((s,i)=><span key={s} aria-current={view.step===i?'step':undefined}>{i+1}. {s}</span>)}</div>
  <article className="attention-item">
   <h4 ref={heading} tabIndex={-1} className="flow-heading">{view.title}</h4>
   <p className="attention-description">{view.description}</p>
   {view.facts.length?<ul className="flow-facts">{view.facts.map((x,i)=><li key={i}>{x}</li>)}</ul>:null}
   {view.input?<div className="task-decision-box"><label htmlFor={id}>补充要求或处理意见 · {required?'必填':'选填'}</label><textarea id={id} value={draft} onChange={e=>update(e.target.value)} maxLength={2000} rows={3} disabled={busy} placeholder={flow.kind==='input'?'例如：只比较国内产品，报告分成两段。':'例如：只整理已有资料，不重新检索；报告分成两段。'} aria-required={required} aria-describedby={id+'-hint'}/><p id={id+'-hint'} className="decision-hint">补充要求会更新建议，需你再次确认，不会直接执行旧建议。</p></div>:null}
   {!fresh&&!view.terminal?<p className="warning">这是历史快照。可以继续填写，请先点击顶部“刷新状态”再提交。</p>:null}
   <div className="decision-actions">{view.actions.map(a=><button key={a.id} type="button" className={'button '+(a.tone==='primary'?'primary':'')} disabled={!fresh||busy||a.requiresText&&!draft.trim()} onClick={()=>submit(a.id)}>{busy?'正在处理…':a.id==='continue'&&draft.trim()?'更新建议后再确认':a.label}</button>)}</div>
   {error?<p className="warning" role="alert">{error}</p>:null}
   {view.terminal?<p className="flow-next">{flow.phase==='completed'?'下一步：点击上方成果按钮查看、下载，或选择其他任务。':'下一步：可查看下方处理记录，或选择其他任务。'}</p>:<p className="decision-hint flow-demo-hint">预览中的“查看进展／结果”按钮推进模拟步骤，无定时刷新、真实审批或模型调用。</p>}
  </article>
  {flow.history.length?<details className="flow-history"><summary>本次处理记录 · {flow.history.length} 条</summary><ol>{flow.history.map(h=><li key={h.version}><strong>{h.action}</strong>{h.note?<p>你的意见：{h.note}</p>:null}<span>{h.result}</span></li>)}</ol></details>:null}
 </section>;
}
