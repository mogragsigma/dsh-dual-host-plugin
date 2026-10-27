// Explicitly synthetic, memory-only preview. Never connected to a DSH Host.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {interpretApproval} from '../../bundle/approval-semantics.js';
import {createFlow,advanceFlow,flowView,flowCue} from './attention-flow.mjs';
import {InterventionPanel} from './InterventionPanel.jsx';
import {taskAttention} from '../task-focus.mjs';
import './intervention-preview.css';
window.__ModuleLoader__={load:m=>{window.previewUI=m.factory(name=>{if(name!=='react')throw Error('PREVIEW_IMPORT_DENIED');return React;});}};
/*PREVIEW_COMPONENT*/
const {WorkbenchUI,css}=window.previewUI;
const style=document.createElement('style');style.textContent=css;document.head.append(style);
const policy={provider:'配置的官方渠道',model:'deepseek-flash',reasoningEffort:'high'},now=Date.now();
const host=role=>({role,plugin_version:'交互预览',instance_id:'preview-'+role,observed_at:Date.now(),connection:{state:'verified',peer_version:'交互预览',peer_role:role==='local'?'cloud':'local'},active_runs:0,queues:{},scheduler_enabled:false});
const summary=(id,title,state)=>({task_id:id,title,spec_revision:1,display_state:state,created:now-60000,requested_model:policy,coordination:{busy:false,blocked:false,owner:'cloud',write_queue:[]},repository:{state:'unbound'},jobs:[],jobs_total:0,approvals:[],runs:[],runs_total:0,artifacts:{state:'not_registered',items:[]},planning:{available:true,schedules:[],workflows:[],schedules_total:0,workflows_total:0},delivery:{execution:{available:true,items:[],total:0}},notifications:{managed:true,deliveries:[]}});
const tasks=[summary('review','每周模型能力观察','waiting_approval'),summary('ready','产品体验走查报告','completed'),summary('repo','项目说明与使用指南','completed'),summary('failure','资料分析与整理','needs_review'),summary('question','季度研究范围确认','waiting_input'),summary('time','周五定时简报','scheduled_time'),summary('old','历史审批记录示例','completed')];
const approval=(id,scope='develop')=>({id,state:'pending',recorded_state:'pending',spec_revision:1,expires:now+86400000,created:now,summary:'整理最近一周的模型功能变化，生成一份中文报告。仅执行本次约定范围，不提交、推送或发布。',scopes:[scope],requested_model:policy,repository_revision:0,execution_boundary:'disabled',proposal_delivery:'sent'});
tasks[0].approvals=[approval('proposal-review')];tasks[0].approval=tasks[0].approvals[0];
const report=(id,name,description)=>({id,name,description,kind:'report',state:'needs_verification',spec_revision:1,created_at:now,description_source:'worker'});
tasks[1].artifacts={state:'registered',items:[report('report-ready','产品体验走查.md','汇总 6 个关键流程的体验发现，并给出按优先级排列的改进建议。')]};
tasks[2].repository={state:'bound',branch:'main',url:'https://gitee.com/preview-fixture/example',verification_fresh:true};
tasks[2].artifacts={state:'registered',items:[{...report('repo-guide','使用指南','已关联仓库中的说明文件；点击核验后查看入口演示。'),kind:'gitee',repository:{path:'README.md',branch:'main',commit:'a'.repeat(40)},description_source:'direct_user'}]};
tasks[3].jobs=[{id:'job-failed',status:'needs_review',reason:'needs_review',error:'WORKER_REPORT_REQUIRED',spec_revision:1,attempts:1,max_runs:1}];tasks[3].jobs_total=1;
tasks[4].jobs=[{id:'job-input',status:'waiting_input',reason:'waiting_input',spec_revision:1,input_question:'本次只比较国内产品，还是同时包含海外产品？',attempts:1,max_runs:2}];tasks[4].jobs_total=1;
tasks[5].jobs=[{id:'job-scheduled',status:'queued',reason:'scheduled_time',spec_revision:1,due:now+3600000}];tasks[5].jobs_total=1;
tasks[6].approvals=[{...approval('expired'),'state':'expired',expires:now-1000}];
tasks[3].preview_flow=createFlow('recovery');tasks[4].preview_flow=createFlow('input');
for(const [id,title,kind,state] of [['config','云端报告执行配置','capability','waiting_capability'],['notification','报告完成通知核对','notification','needs_review'],['unknown','历史任务记录核对','unknown','needs_review']]){
 const t=summary(id,title,state);t.preview_flow=createFlow(kind);tasks.push(t);
}
const sync=t=>{if(t.preview_flow)t.display_state=flowView(t.preview_flow).owner;};tasks.forEach(sync);
// Put the requested recovery example first without changing other fixture identities.
tasks.unshift(tasks.splice(tasks.findIndex(t=>t.task_id==='failure'),1)[0]);
const drafts=new Map();
const find=id=>{const t=tasks.find(x=>x.task_id===id);if(!t)throw Error('PREVIEW_TASK_MISSING');return t;};
let notice='';const listeners=new Set();const show=text=>{notice=text;for(const f of listeners)f(text);};
function App(){
 const [message,setMessage]=React.useState('');React.useEffect(()=>{listeners.add(setMessage);return()=>listeners.delete(setMessage);},[]);
 const request=async(method,args)=>{
  if(method==='list'){const q=(args.query??'').normalize('NFKC').trim().toLocaleLowerCase(),items=tasks.filter(t=>t.title.normalize('NFKC').toLocaleLowerCase().includes(q));return {instance_id:'preview-cloud',viewer_role:'local',viewer:host('local'),host:host('cloud'),observed_at:Date.now(),items:structuredClone(items),total:items.length,next_cursor:null,pending:[]};}
  if(method==='detail')return {instance_id:'preview-cloud',viewer_role:'local',observed_at:Date.now(),item:structuredClone(find(args.task_id))};
  throw Error('PREVIEW_READ_ONLY');
 };
 const decide=async a=>{const t=find(a.task_id),p=t.approvals.find(p=>p.id===a.request_id);
  if(!p||p.spec_revision!==a.expected_revision||!['pending','held','clarification_required'].includes(p.state))throw Error('APPROVAL_SNAPSHOT_CHANGED');
  const words={approve:'同意',hold:'暂缓',reject:'拒绝'};
  const interpreted=await interpretApproval(a.text||words[a.shortcut],{},undefined);
  const state={approve:'approved',reject:'rejected',hold:'held',amend:'changes_requested',clarify:'clarification_required'}[interpreted.intent]??'clarification_required';
  p.state=state;p.recorded_state=state;t.display_state=state==='approved'?'waiting_capability':state==='held'?'held':state;
  if(state==='approved')t.preview_flow=createFlow('capability');
  if(state==='changes_requested')t.preview_flow=createFlow('amendment',a.text);
  sync(t);
  return {recorded:true,state,message:state==='changes_requested'?'旧方案已冻结。请修订后重新送审；不会执行旧方案。':state==='approved'?'模拟账本已记录本次决定；执行能力未开放，没有启动任务。':interpreted.reason};
 };decide.preview=true;decide.drafts=drafts;
 const perform=async a=>{
  const t=find(a.task_id);if(t.spec_revision!==a.revision||!t.preview_flow)throw Error('PREVIEW_CHANGED');
  t.preview_flow=advanceFlow(t.preview_flow,a);sync(t);
  if(t.preview_flow.phase==='completed')t.artifacts={state:'registered',items:[report('flow-'+t.task_id,t.title+' · 模拟报告.md','仅用于本轮交互验收的合成报告。'+(t.preview_flow.opinion?'采用的模拟要求：'+t.preview_flow.opinion:'复用示例资料，补齐结果。'))]};
 };
 const attentionPreview={cue:t=>t.preview_flow?flowCue(t.preview_flow):taskAttention(t).length?'有待处理事项':'查看成果与进度',render:props=>props.item.preview_flow?<InterventionPanel key={'flow-'+props.item.task_id} {...props} perform={perform} drafts={drafts}/>:null};
 const download=a=>{const bytes='# '+a.name+'\n\n这是一份交互预览生成的模拟文件，不来自真实任务。\n',url=URL.createObjectURL(new Blob([bytes],{type:'text/plain;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download=a.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);show('下载的是模拟文件；真实受控下载尚未接线。');};
 return <><div className="preview-bar"><strong>交互预览</strong><span>全流程模拟 · 点击“资料分析与整理”开始 · 不连接正式 DSH</span><button onClick={()=>location.reload()}>重置演示</button></div><WorkbenchUI request={request} call={async()=>({viewer_role:'local',observed_at:Date.now(),runs:[],a2a:{available:true,items:[]}})} open={async()=>show('执行会话入口演示：正式版本将打开此成果所属的云端会话。')} openSidebar={async()=>show('侧栏入口演示：不操作真实 DSH。')} appearance={async()=>({mascot:URL.createObjectURL(await (await fetch('./whale-ui-states.png')).blob())})} artifactAccess={async(action,a)=>({artifact:{...find(a.task_id).artifacts.items.find(x=>x.id===a.artifact_id),state:'verified'},checked_at:Date.now(),...(action==='session'?{session_id:'task-worker-11111111-1111-4111-8111-111111111111'}:{}),...(action==='gitee'?{url:'https://gitee.com/preview-fixture/example/blob/'+'a'.repeat(40)+'/README.md'}:{})})} decisionAdapter={decide} attentionPreview={attentionPreview} downloadArtifact={download} discussTask={entry=>show('对话入口演示：关联当前任务，不向任意已有会话插入消息。事项：'+entry.title)} />{message?<div className="preview-notice" role="status">{message}<button onClick={()=>setMessage('')} aria-label="关闭预览提示">关闭</button></div>:null}</>;
}
// Gitee links are only illustrative. Never navigate to a fake repository.
window.addEventListener('click',e=>{const a=e.target.closest('a');if(a?.href?.startsWith('https://gitee.com/preview-fixture/')){e.preventDefault();show('Gitee 入口演示：实际版本将打开经核验的固定版本页面；本预览不访问 Gitee。');}},true);
createRoot(document.getElementById('root')).render(<App/>);
