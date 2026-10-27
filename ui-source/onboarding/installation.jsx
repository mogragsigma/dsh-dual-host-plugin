import React,{useState,useRef,useEffect} from 'react';
import {Button,Panel,Callout,Badge,CheckRow,Field} from './components';
const reasons={
 ONBOARDING_GLOBAL_TARGET_AMBIGUOUS:'发现两份全局规则，请明确选择追加目标；另一份保持不变。',
 ONBOARDING_SKILL_CONFLICT:'存在同名 Skill 或目录，保留用户内容，不覆盖也不自动改名。',
 ONBOARDING_UNOWNED_RULE_BLOCK:'发现未能核验归属的托管区，需要人工核对。',
 ONBOARDING_OWNED_CONTENT_REVIEW:'已安装文件或版本发生变化；本期不自动升级。',
 ONBOARDING_GLOBAL_BUDGET_REVIEW:'全局规则超过保守加载预算，需要先精简或调整方案。',
 ONBOARDING_RECOVERY_REQUIRED:'有未结束事务，先核对回执并处理恢复。'
};
export function Installation({request}){
 const [plan,setPlan]=useState(null),[root,setRoot]=useState(''),[confirmed,setConfirmed]=useState(false),[receipt,setReceipt]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),serial=useRef(0);
 useEffect(()=>()=>{serial.current++;},[]);
 async function run(action){
  const n=++serial.current;setBusy(true);setError('');
  try{const r=await action();if(n===serial.current)return r;}
  catch(e){if(n===serial.current)setError('操作未完成：'+e.message+'。请手动核对回执，不自动重试。');}
  finally{if(n===serial.current)setBusy(false);}
 }
 async function preview(){setConfirmed(false);setPlan(null);const r=await run(()=>request('install_preview',root?{ruleRoot:root}:{}));if(r)setPlan(r);}
 async function status(){const r=await run(()=>request('install_status',{}));if(r)setReceipt(r);}
 async function apply(){if(!plan?.canApply||!confirmed||busy)return;const p=plan;setConfirmed(false);setPlan(null);const r=await run(()=>request('install_apply',{id:p.id,fingerprint:p.fingerprint,confirm:true}));if(r)setReceipt(r);}
 async function recover(){if(!receipt?.id||busy)return;const r=await run(()=>request('install_recover',{id:receipt.id,confirm:true}));if(r)setReceipt(r);setPlan(null);setConfirmed(false);}
 return <Panel title="本端规则与 Skill 安装计划" icon="shield" extra={<Badge>仅当前 Host</Badge>}>
  <Callout>这份计划仅安装本端全局规则与 Skill，不连接 ECS、不修改凭据、不启动任务或开发、提交、发布。预览不写文件；应用后会保存私有备份和事务回执。</Callout>
  <Field label="全局规则追加目标" hint="选填；两份都存在时必须选择。只选追加位置，不移动或修改另一份规则。">
   <select aria-label="全局规则追加目标" disabled={busy} value={root} onChange={e=>{setRoot(e.target.value);setPlan(null);setConfirmed(false);}}>
    <option value="">自动：优先唯一已有文件，否则创建</option>
    <option value="dsh">当前 Host 的 DSH 全局规则</option>
    <option value="shared">当前 Host 的共享 Agents 全局规则</option>
   </select>
  </Field>
  <div className="form-actions"><Button onClick={preview} disabled={busy}>预览安装计划</Button><Button kind="soft" onClick={status} disabled={busy}>核对安装回执</Button></div>
  {error&&<p role="alert">{error}</p>}
  {plan&&<div className="install-plan">
   <p>{plan.alreadyInstalled?'已安装且摘要一致 · 无需重复应用':`${plan.changes.length} 项变更 · 全局规则 ${plan.globalBytes}/${plan.byteLimit} 字节`}</p>
   {plan.conflicts.map((x,i)=><div role="alert" className="plan-item" key={i}><strong>{reasons[x.code]??x.code}</strong>{x.path&&<code>{x.path}</code>}</div>)}
   <div className="install-changes">{plan.changes.map(x=><details className="plan-item" key={x.path}><summary>{x.action==='append'?'追加，保留原文':'新建，不覆盖'} · {x.path.includes('/skills/')?x.path.slice(x.path.lastIndexOf('/skills/')+1):'AGENTS.md'}</summary><code>{x.path}</code><p>保留原始 {x.preservedBytes} 字节</p><code>原摘要：{x.beforeHash??'不存在'}<br/>目标摘要：{x.afterHash}</code><pre className="install-diff">{x.addedText}</pre></details>)}</div>
   <CheckRow checked={confirmed} disabled={!plan.canApply||busy} onChange={setConfirmed} title="我确认在上述实际路径应用这份规则与 Skill 计划" sub="不授权 ECS 初始化；任何冲突或快照变化均会停止。"/>
   <Button kind="primary" disabled={!plan.canApply||!confirmed||busy||Date.now()>plan.expiresAt} onClick={apply}>应用本端规则与 Skill</Button>
  </div>}
  {receipt&&<div className="plan-item" role="status"><strong>安装回执：{({committed:'文件已安装',rolled_back:'已回滚',needs_review:'待人工核对',applying:'执行中／需核对',rolling_back:'回滚中／需核对',not_installed:'尚未安装'})[receipt.state]??receipt.state}</strong><p>会话加载仍需独立核验；不代表整套初始化完成。</p>{receipt.error&&<code>{receipt.error}</code>}{receipt.review?.map((x,i)=><code key={i}>{x.path} · 保留现场，不覆盖</code>)}{receipt.canRecover&&<Button disabled={busy} onClick={recover}>确认回滚未完成事务</Button>}</div>}
 </Panel>;
}
