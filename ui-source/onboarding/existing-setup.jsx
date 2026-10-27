import React,{useState,useRef,useEffect} from 'react';
import {Panel,Button,Field,CheckRow,Callout,InfoRow,InfoHelp,HelpProvider,Modal,Badge,Mascot} from './components';
import {ExistingPairInspection} from './existing-pair';
import {NotificationDefaults} from './notification-defaults';
import {Installation} from './installation';
import {Maintenance} from './maintenance';
const titles=['复用双端连接','核对模型选择','选择收发入口','核对可选仓库','保护规则与 Skill','确认复用配置'];
const poses=['cloud','model','welcome','repository','tasks','model'];
const messages={ONBOARDING_EXISTING_RULES_REQUIRED:'两端托管规则尚未核验一致。请在第 5 页处理，不认领未知文件。',ONBOARDING_EXISTING_MODEL_REQUIRED:'模型尚未唯一解析，或某端清单不完整。请重新核对模型名称，不需要填写 provider。',ONBOARDING_EXISTING_NOTIFICATION_REQUIRED:'所选默认通知尚未在云端同步，或该端没有机器人清单。请回第 3 页核对。',ONBOARDING_EXISTING_CONFIGURATION_CHANGED:'配置在预览后发生变化，未保存确认。请重新预览。',ONBOARDING_EXISTING_RECHECK_FAILED:'最终只读复核未通过，未保存确认。请核对连接和配置后重新预览。',ONBOARDING_EXISTING_PLAN_EXPIRED:'预览已失效或 Host 已重启，请重新预览。'};
const fresh=x=>x&&Number.isFinite(x.expiresAt)&&Date.now()<x.expiresAt;
export function ExistingSetupGuide({request,appearance,onManaged,onExit,installationEnabled,maintenanceContract,maintenanceMutation}){
 const [page,setPage]=useState(0),[pair,setPair]=useState(null),[model,setModel]=useState(null),[notification,setNotification]=useState(null),[repository,setRepository]=useState(null);
 const [query,setQuery]=useState(''),[clarification,setClarification]=useState(''),[useIm,setUseIm]=useState(false),[useRepo,setUseRepo]=useState(false),[repoUrl,setRepoUrl]=useState('');
 const [plan,setPlan]=useState(null),[confirmed,setConfirmed]=useState(false),[reviewed,setReviewed]=useState(false),[receipt,setReceipt]=useState(null),[uncertain,setUncertain]=useState(null),[fenceConfirmed,setFenceConfirmed]=useState(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[modal,setModal]=useState(null),[mascot,setMascot]=useState(null),[keyboard,setKeyboard]=useState(false);
 const alive=useRef(true),lock=useRef(false),title=useRef();
 useEffect(()=>{alive.current=true;appearance?.().then(a=>{if(alive.current)setMascot(a.mascot);}).catch(()=>{});return()=>{alive.current=false;};},[]);
 useEffect(()=>{title.current?.focus({preventScroll:true});},[page]);
 function invalidate(){setPlan(null);setConfirmed(false);setError('');}
 const options=()=>({query,clarification,im:useIm,repoUrl:useRepo?repoUrl:null});
 async function act(kind){
  if(lock.current)return;lock.current=true;setBusy(true);setError('');
  try{
   if(kind==='model'){setModel(null);const r=await request('existing_setup_model',{query,clarification});if(alive.current)setModel(r);}
   if(kind==='notifications'){setNotification(null);const r=await request('existing_setup_notifications',{});if(alive.current)setNotification(r);}
   if(kind==='repository'){setRepository(null);const r=await request('existing_setup_repository',{url:repoUrl});if(alive.current)setRepository(r);}
   if(kind==='preview'){if(uncertain)return;invalidate();const r=await request('existing_setup_preview',options());if(alive.current)setPlan(r);}
   if(kind==='apply'){
    if(!plan||!confirmed||uncertain||!fresh(plan))return;
    const p=plan;setPlan(null);setConfirmed(false);setUncertain({id:p.id,revision:p.expectedRevision+1});
    const r=await request('existing_setup_apply',{id:p.id,fingerprint:p.fingerprint,confirm:true});if(!alive.current)return;
    setReceipt(r);if(r.operation===p.id)setUncertain(null);
   }
   if(kind==='status'){
    const r=await request('existing_setup_status',{});if(!alive.current)return;setReceipt(r);setFenceConfirmed(false);
    if(uncertain&&(r.operation===uncertain.id||r.revision>=uncertain.revision))setUncertain(null);
   }
   if(kind==='fence'){
    if(!fenceConfirmed||!receipt||!uncertain)return;const op=crypto.randomUUID();setFenceConfirmed(false);
    const r=await request('existing_setup_fence',{expectedRevision:receipt.revision,operation:op,confirm:true});if(!alive.current)return;setReceipt(r);if(r.operation===op)setUncertain(null);
   }
  }catch(e){if(alive.current){setPlan(null);setConfirmed(false);setError(messages[e.message]??'本次结果未确认。请核对原回执；不自动重试、换端、复制密钥或开启任务。');if(kind==='apply'&&messages[e.message])setUncertain(null);}}
  finally{lock.current=false;if(alive.current)setBusy(false);}
 }
 const rulesReady=pair&&[pair.local,pair.cloud].every(h=>['committed','inspected'].includes(h.rules.state)&&h.rules.files>0);
 const ready=[fresh(pair),fresh(model)&&model.resolution.status==='resolved',!useIm||notification?.enabled&&notification.synchronized,!useRepo||!!repository,rulesReady&&reviewed];
 function next(){if(!ready[page]||busy){setError('请先完成本页手动核对；失效结果不能用于继续。');return;}invalidate();setPage(page+1);}
 function leave(action){setModal({title:'离开既有双端配置？',body:<><p>尚未确认的填写不会保存。已保存的复用回执和实际配置保持不变；未确认的请求应先查询原回执，不要重新提交。</p><Button kind="secondary" onClick={()=>{setModal(null);action();}}>离开当前填写</Button></>});}
 const chooseModel=(q,c)=>{invalidate();setModel(null);setQuery(q);setClarification(c);};
 const checkPair=<ExistingPairInspection request={request} onResult={r=>{setPair(r);invalidate();}}/>;
 const body=[
  <div className="stack">{checkPair}<Callout>复用已建立的自有直连，不重新申请 ECS、索取 SSH 私钥或初始化 Host。没有直连时返回“新环境配置”。这是保留数据的重装路径，不是全新 ECS 初始化。</Callout></div>,
  <Panel className="connection-panel" title="复用模型服务" icon="key" sub="保留两端现有模型及凭据。仅解析云端验收模型，不调用、不设为 worker 固定模型；本地原生默认模型也不变。">
   <Field label="复用云端任务模型" placeholder="例如 ds flash" value={query} maxLength={200} onChange={e=>chooseModel(e.target.value,'')}/>
   {(model?.resolution.status==='ambiguous'||clarification)&&<Field label="模型接入补充说明" value={clarification} maxLength={200} onChange={e=>chooseModel(query,e.target.value)}/>}
   <div className="connection-actions"><Button kind="secondary" disabled={busy||!query.trim()} onClick={()=>act('model')}>核对云端模型名称</Button></div>
   {model&&<div className="connection-result" role="status"><p>{model.resolution.status==='resolved'?`${model.resolution.selection?.model_name??model.resolution.model_policy.model} · ${model.resolution.selection?.provider_name??'已唯一匹配'} · High，尚未调用。`:model.resolution.instruction}</p>{model.resolution.status!=='resolved'&&model.resolution.candidates?.map(x=><p key={x.provider+'/'+x.model}>{x.model_name} · {x.provider_name}</p>)}</div>}
   {model?.resolution.status==='ambiguous'&&<div className="connection-actions">{[...new Set(model.resolution.candidates?.map(x=>x.provider_name)??[])].map(name=><Button key={name} kind="soft" onClick={()=>chooseModel(query,'请用 '+name)}>选择 {name}</Button>)}</div>}
  </Panel>,
  <div className="stack"><Panel className="connection-panel" title="复用聊天与通知" icon="chat" sub="可选。未勾选仅跳过本次核验，不停用已有机器人或通知。选择后，核对已保存的默认端及对话，不强制填写 ID。"><CheckRow title="核对并复用默认收发入口" checked={useIm} onChange={v=>{invalidate();setUseIm(v);setNotification(null);}}/></Panel>{useIm&&<><NotificationDefaults request={request}/><Panel className="connection-panel" title="核对云端通知账本" icon="shield"><Button kind="secondary" onClick={()=>act('notifications')}>核对已保存的收发选择</Button>{notification&&<div role="status"><InfoRow label="默认端" value={notification.target?.host==='local'?'本地机器人':notification.target?.host==='cloud'?'云端机器人':'未配置'}/><InfoRow label="返回对话" value={notification.target?.label??'未配置'}/><InfoRow label="双端记录" value={notification.enabled&&notification.synchronized?'一致 · 实际送达仍须验收':'尚未一致，请先核对默认设置'}/></div>}</Panel></>}</div>,
  <Panel className="connection-panel" title="复用可选 Gitee 仓库" icon="git" sub="只读核验用户自己的任务成果仓库，不操作产品源码仓库；未选择不会解除历史任务绑定。"><CheckRow title="核对已有 Gitee 任务仓库" checked={useRepo} onChange={v=>{invalidate();setUseRepo(v);setRepository(null);}}/>{useRepo?<><Field label="Gitee 仓库地址" placeholder="https://gitee.com/team/task-results" value={repoUrl} onChange={e=>{invalidate();setRepoUrl(e.target.value);setRepository(null);}}/><Button kind="secondary" disabled={busy||!repoUrl.trim()} onClick={()=>act('repository')}>通过云端 API 只读核验仓库</Button>{repository&&<div className="connection-result" role="status"><InfoRow label="已核验仓库" value={repository.repository.url}/><InfoRow label="默认分支" value={repository.repository.branch}/><InfoRow label="读取权限" value="已核验 · 不授权写入或建立新任务绑定"/></div>}</>:<Callout>无需仓库也能工作，成果保留介绍与执行会话入口。不会清除任何现有仓库设置。</Callout>}</Panel>,
  <div className="stack">{checkPair}<Panel className="connection-panel" title="保留规则与用户内容" icon="shield" sub="只核对有真实归属账本的托管规则与 Skill。未知文件不认领，用户内容不覆盖。云端规则须在云端自身安装器处理，不能从这里调用任意远端安装操作。"><InfoRow label="双端规则" value={rulesReady?'文件核验一致 · 会话加载另验':'尚未核验一致，不能确认复用'}/><CheckRow title="我已核对保护范围，不授权任务或写入" checked={reviewed} onChange={setReviewed}/></Panel>{installationEnabled&&<details className="details"><summary>本端规则安装与维护</summary><Installation request={request}/>{maintenanceContract>0&&<Maintenance request={request} contract={maintenanceContract} mutation={maintenanceMutation}/>}</details>}</div>,
  <Panel className="connection-panel" title="确认复用现有配置" icon="shield" sub="最后重新核对两端、模型、可选通知及仓库，然后只保存本插件的复用确认记录。不创建 Host、不复制密钥、不执行任务，不授予开发、提交、推送或发布权限。">
   <div className="connection-actions"><Button kind="primary" disabled={busy||!!uncertain} onClick={()=>act('preview')}>预览复用确认</Button><Button kind="secondary" disabled={busy} onClick={()=>act('status')}>查询原复用回执</Button></div>
   {plan&&<section className="connection-confirm"><InfoRow label="云端模型" value={plan.evidence.model.model+' · High · 不设全局默认'}/><InfoRow label="收发入口" value={plan.evidence.notification?`${plan.evidence.notification.target.host==='local'?'本地':'云端'} · ${plan.evidence.notification.target.label}`:'本次跳过，保留现有设置'}/><InfoRow label="仓库" value={plan.evidence.repository?.url??'本次跳过，保留现有绑定'}/><CheckRow title="我确认复用上述配置，仅保存确认记录" checked={confirmed} onChange={setConfirmed}/><div className="connection-actions"><Button kind="primary" disabled={busy||!confirmed||!fresh(plan)} onClick={()=>act('apply')}>确认复用配置</Button></div></section>}
   {receipt&&<div className="connection-result" role="status"><h3>{receipt.state==='confirmed_history'?'已保存复用确认回执':'尚无有效复用确认'}</h3><p>这是历史配置选择，不是实时在线或任务成功证明。原生配置和安装归属没有改变；实际任务、IM 送达和成果仍需验收。</p></div>}
   {uncertain&&<div className="connection-confirm"><Callout>原保存结果尚未确认，请先查询回执，不重复点击确认。若核对后仍需关闭此请求，只作版本屏障，实际配置保持不变。</Callout>{receipt&&<><CheckRow title="关闭未确认请求，使原复用确认失效但保留实际配置" checked={fenceConfirmed} onChange={setFenceConfirmed}/><Button kind="secondary" disabled={busy||!fenceConfirmed} onClick={()=>act('fence')}>关闭未确认的复用请求</Button></>}</div>}
  </Panel>
 ][page];
 return <HelpProvider onHelp={(title,body)=>setModal({title,body})}><div className={'dsh-onboarding existing-setup'+(keyboard?' keyboard':'')} style={mascot?{'--mascot':`url("${mascot}")`}:undefined} onKeyDownCapture={()=>setKeyboard(true)} onPointerDownCapture={()=>setKeyboard(false)}><div className="window-frame"><header className="window-header"><div className="brand"><span className="brand-portrait"><Mascot/></span><strong>大肥鱼bot<span>保留数据，复用已有配置</span></strong></div><div className="header-actions"><Badge>既有双端</Badge><Button kind="text" disabled={busy} onClick={()=>leave(onManaged)}>新环境配置</Button>{onExit&&<Button kind="text" disabled={busy} onClick={()=>leave(onExit)}>返回大肥鱼bot</Button>}</div></header><main><div className="page-top"><div className="page-position"><strong>{page+1}<span>/6</span></strong><h1 ref={title} tabIndex="-1">{titles[page]}</h1><InfoHelp title={titles[page]}>只复用当前已认证配对的两个 Host。填写进度不等于真实验收；每个实际配置修改仍使用独立预览与确认。</InfoHelp></div><span className="step-mascot mascot-zone"><Mascot pose={poses[page]}/></span></div><div className="page-progress progress-track" role="progressbar" aria-label="既有配置填写进度" aria-valuemin="0" aria-valuemax="6" aria-valuenow={page}><span style={{transform:`scaleX(${page/6})`}}/></div><fieldset disabled={busy} style={{border:0,padding:0,margin:0}}><div className="page-content" data-page={page+1}>{body}</div></fieldset>{error&&<p className="connection-error" role="alert">{error}</p>}<footer className="wizard-footer"><p className="fine-print">只手动核对；跳过可选项不会停用现有功能。当前填写尚未保存，最终确认另有回执。</p><div><Button kind="text" icon="back" disabled={!page||busy||!!uncertain} onClick={()=>{invalidate();setPage(page-1);}}>上一步</Button></div><div>{page<5&&<Button kind="primary" end="arrow" disabled={busy||!ready[page]} onClick={next}>继续</Button>}</div></footer></main></div><Modal modal={modal} onClose={()=>setModal(null)}/></div></HelpProvider>;
}
