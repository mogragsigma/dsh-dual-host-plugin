import {canonical} from './approval-ledger.js';

// Failure diagnostics are not success artifacts, approval, a refund, or a resume.
// Store after the native worker returns/throws; never infer drain from a callback.
export class DevelopmentAttention {
 constructor(runtime){
  this.r=runtime;this.db=runtime.gate.db;
  this.db.exec(`CREATE TABLE IF NOT EXISTS development_attention(run_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,job_id TEXT NOT NULL,snapshot TEXT NOT NULL,created INTEGER NOT NULL);`);
 }
 record(job,error){
  const r=this.r.requestFor(job),gate=this.r.gate;
  if(job.version!=='0.22.0'||r.task_id!==job.task_id)throw Error('DEVELOPMENT_ATTENTION_RUN_MISMATCH');
  const run=this.r.g.scheduler.jobs.db.prepare('SELECT job_id,claim FROM runs WHERE id=?').get(job.run_id);
  if(!run||run.job_id!==job.id||run.claim!==job.claim)throw Error('DEVELOPMENT_ATTENTION_RUN_MISMATCH');
  const old=this.db.prepare('SELECT snapshot FROM development_attention WHERE run_id=?').get(job.run_id);
  if(old)return JSON.parse(old.snapshot);
  const progress=gate.progress(r.id),model=this.r.modelBudget.view(r.id),test=r.test_result?JSON.parse(r.test_result):null;
  const passed=test?.passed===true&&test.file_hash===r.expected_hash;
  const exhausted=[];
  if(progress.write_budget.calls_used>=progress.write_budget.limit||progress.write_budget.intents_used>=progress.write_budget.limit)exhausted.push('write');
  if(progress.command_budget.used>=progress.command_budget.limit)exhausted.push('command');
  if(model.used>=model.limit)exhausted.push('model');
  const code=/^DEVELOPMENT_[A-Z_]{1,80}$/.test(error?.message??'')?error.message:'DEVELOPMENT_WORKER_FAILED';
  const labels={write:'写入',command:'命令',model:'模型'};
  const summary='开发批次已停止，等待核对。'+(passed?'当前清单的必需命令已通过，但批次未完成，不能据此交付。':'当前清单的验收未通过或证据不完整。')+
   (exhausted.length?'已用完'+exhausted.map(x=>labels[x]).join('、')+'预算；不自动追加或换任务重试。':'尚有额度也不会自动重启，须先核对已发生操作。');
  const question=exhausted.length?'请查看执行会话中的失败输出，再决定调整方案并重新审批，或停止任务；原失败与消耗保留。':'请查看执行会话中的失败输出及当前文件；继续前由运营方核对原审批、效果和排空，再显式恢复。';
  const snapshot={schema:1,run_id:job.run_id,request_id:r.id,job_id:job.id,code,summary,question,
   test_passed_on_recorded_manifest:passed,recorded_manifest:r.expected_hash,exhausted,
   ...progress,model_budget:model,unclosed_operations:gate.unresolved(r.id),
   grants_execution:false,success_artifact:false,budget_reset:false};
  gate.store.tx(()=>{this.db.prepare('INSERT INTO development_attention VALUES (?,?,?,?,?)').run(job.run_id,r.id,job.id,canonical(snapshot),gate.now());gate.event(r.id,'attention_recorded',{run_id:job.run_id,code,exhausted});});
  return snapshot;
 }
}
