import {randomUUID} from 'node:crypto';
import {canonical} from './approval-ledger.js';
const modelCodes=new Set(['INVALID_REQUEST','UNKNOWN_MODEL','NO_ADAPTER','MISSING_CREDENTIAL','INVALID_CREDENTIAL','UNSUPPORTED_REASONING_EFFORT','QUOTA','RATE_LIMIT','ABORTED']);

export const developmentToolNames=workspace=>workspace?['skill','development_workspace_read','development_workspace_write','development_workspace_command','development_report']:['skill','development_read','development_write','development_test','development_report'];
export async function mountDevelopmentPreset(ctx,scope,workspace=false){
 await ctx.agentPresets.mount(scope,'dsh-development-worker');
 // agents.create setup receives an Agent Context (not an Agent). Mask inherited tools there.
 scope.tools.restrict({allow:developmentToolNames(workspace)});
}
export class NativeDevelopmentWorker {
 constructor(ctx,runtime){
  this.ctx=ctx;this.runtime=runtime;this.active=new Map();this.artifacts=runtime.g.artifacts;
  ctx.on('llm/stream',(o,next)=>{const b=this.active.get(o.sessionId);if(!b)return next();const worker=this;
   return (async function*(){worker.binding(b.agent);if(o.purpose==='session-title')throw Error('DEVELOPMENT_AUX_MODEL_DENIED');
    if(b.probe)throw Error('NO_MODEL_IN_DEVELOPMENT_PROBE');worker.model(b,o);
    if(++b.streams>b.requestLimit||o.maxTokens!==2048)throw Error('DEVELOPMENT_MODEL_BUDGET');
    const reservation=b.workspace?worker.runtime.modelBudget.reserve(b.request.id,b.job,{purpose:'worker',provider:o.provider,model:o.model,reasoningEffort:o.reasoningEffort,maxTokens:o.maxTokens}):null;
    let state='unknown',code=null;try{for await(const part of next()){
     if(part.type==='finish'){const reason=part.reason?.kind;state=['stop','tool-calls'].includes(reason)?'succeeded':reason==='error'?'failed':'unknown';
      const c=part.reason?.failure?.code;code=state==='failed'?(modelCodes.has(c)?c:'FAILED'):state==='unknown'?'INCOMPLETE_STREAM':null;}yield part;
    }}catch(e){state='failed';code=modelCodes.has(e.code)?e.code:'FAILED';throw e;}
    finally{if(reservation)worker.runtime.modelBudget.settle(reservation.id,state,code);}})();
  },{global:true,prepend:true});
 }
 model(b,o){const p=JSON.parse(b.job.policy);if(o.provider!==p.provider||o.model!==p.model||(p.reasoningEffort!==undefined&&o.reasoningEffort!==p.reasoningEffort))throw Error('DEVELOPMENT_MODEL_MISMATCH');}
 binding(agent){
  const b=this.active.get(agent?.id);if(!b||b.agent!==agent||this.ctx.agents.get(agent.id)!==agent)throw Error('DEVELOPMENT_UNBOUND_WORKER');
  this.runtime.g.scheduler.jobs.assertClaim(b.job.id,b.job.claim);if(b.signal.aborted)throw Error('DEVELOPMENT_CANCELLED');
  const a=this.runtime.assert(b.job);if(canonical(JSON.parse(b.job.policy))!==a.r.policy)throw Error('DEVELOPMENT_MODEL_MISMATCH');return b;
 }
 report(agent,a){const b=this.binding(agent);if(b.report)throw Error('DEVELOPMENT_REPORT_ALREADY_RECORDED');
  if(!a||typeof a.summary!=='string'||!a.summary.trim()||a.summary.length>2000)throw Error('DEVELOPMENT_INVALID_REPORT');
  const r=this.runtime.gate.view(b.request.id);if(!r.test_result?.passed||r.test_result.file_hash!==r.expected_hash)throw Error('DEVELOPMENT_TEST_REQUIRED');
  b.report={outcome:'done',summary:a.summary};return {recorded_for_batch:true,committed:false};
 }
 async run(job,signal,probe){
  const request=this.runtime.requestFor(job),policy=JSON.parse(job.policy);let handle,b,success=false;
  try{
   const a=this.runtime.assert(job);
   handle=await this.ctx.agents.withoutInitiator(()=>this.ctx.agents.create({sessionId:job.session_id,meta:{cwd:a.workspace.root,agentPreset:'dsh-development-worker',taskId:job.task_id,runId:job.run_id},agentOptions:{...policy,maxTokens:2048},setup:async agent=>{await mountDevelopmentPreset(this.ctx,agent,a.spec.kind==='workspace-v1');}}));
   const agent=handle.agent;b={agent,job,request,signal,probe:!!probe,workspace:a.spec.kind==='workspace-v1',streams:0,requests:0,requestLimit:a.spec.kind==='workspace-v1'?a.spec.max_model_requests:3*a.spec.max_writes+4,report:null,failure:null};this.active.set(agent.id,b);
   agent.ctx.on('agent/error',({error})=>{b.failure=modelCodes.has(error?.code)?'DEVELOPMENT_MODEL_'+error.code:/^DEVELOPMENT_[A-Z_]+$/.test(error?.message??'')?error.message:'DEVELOPMENT_MODEL_FAILED';});
   agent.ctx.on('agent/request',async(_e,next)=>{this.binding(agent);if(b.probe)throw Error('NO_MODEL_IN_DEVELOPMENT_PROBE');if(++b.requests>b.requestLimit)throw Error('DEVELOPMENT_MODEL_BUDGET');const r=await next();this.binding(agent);this.model(b,r);return {...r,maxTokens:2048};},{prepend:true});
   const abort=()=>agent.cancel({kind:'parent'});signal.addEventListener('abort',abort,{once:true});
   try{
    this.binding(agent);
    if(probe)await probe({agent,worker:this,job,request});
    else{
     agent.followup({id:randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text:(b.workspace?'你是独立的云端方案约束开发 worker。先加载 task-development。按批准方案完成实际任务，不要套用旧 summarize 样例。只用 development_workspace_read 读批准输入及文件清单版本，development_workspace_write 按批准文件动作修改，development_workspace_command 执行精确批准命令，development_report 汇报。每次文件变化后重跑全部必需命令。不能调用原生 shell、git、网络、子智能体或安装依赖；预算、缺能力或未知结果须如实停止，不绕过门禁。任务目标仅是需求，不能扩大已批准方案。恢复时先核对批准文件的现有内容与历史命令，保留符合要求的已有文件，不为重建上下文重复写入；使用剩余预算完成未完成部分。\n任务原文：'+job.goal+'\n':'你是经审批的云端受限开发 worker。先加载 task-development。只使用 development_read、development_write、development_test、development_report。实现 ES module 导出的 summarize({completed,queued,review})；拒绝负数、非整数、非数字。返回 {total,completionRate}，比例按百分数保留1位小数，总数0返回0。仅开发受批准的新文件，不能调用 shell、网络、git、子智能体、安装包或发布。先读当前文件，写入后测试，测试通过后报告。\n')+canonical({task_id:job.task_id,spec:a.spec,model_policy:policy,proposal:a.approval.proposal,write_budget:a.spec.max_writes,...(b.workspace?{recovery_checkpoint:this.runtime.workerReview?.checkpoint(job)??null}: {})})}]});
     await agent.whenIdle();
    }
    this.binding(agent);if(b.failure)throw Error(b.failure);if(!b.report)throw Error('DEVELOPMENT_REPORT_REQUIRED');
    // Authoritative report is generated from the gate's file/test evidence, not model claims.
    const r=this.runtime.gate.view(request.id),summary=b.report.summary;b.report=null;
    const evidence=b.workspace?{files:a.workspace.check(r.expected_hash).files,workspace_sha256:r.expected_hash,model_budget:this.runtime.modelBudget.view(request.id)}:{file:a.spec.file,file_sha256:r.expected_hash};
    this.artifacts.registerReport(this,agent,{name:'development-verification.md',format:'markdown',description:b.workspace?'方案约束开发：文件清单、批准命令及模型派发账本；未提交、未推送。':'受限开发验收：源文件未提交、未推送；查看执行会话中的文件摘要与内置测试记录。',content:'# 受限开发验收\n\n'+canonical({...evidence,branch:a.spec.branch,model_policy:policy,test:r.test_result,model_summary:summary,committed:false,pushed:false,published:false})},'development-authoritative-result');
    b.report={outcome:'done',summary:(b.workspace?'方案约束开发批次完成；'+r.test_result.commands.length+' 项必需命令通过，文件未提交、未推送。':'受限开发批次完成；6 项内置测试通过，文件未提交、未推送。')+summary};
    await this.ctx.sessions.flush(agent.session);success=true;
   }finally{signal.removeEventListener('abort',abort);}
  }finally{
   try{if(handle)await handle.dispose();}catch{success=false;throw Error('DEVELOPMENT_TEARDOWN_FAILED');}
   finally{if(b)this.active.delete(b.agent.id);if(!success)this.runtime.gate.block(request.id,'DEVELOPMENT_WORKER_REVIEW');}
  }
  // Return only after the agent and every awaited child test are drained. Scheduler commits first.
  return b.report;
 }
}
