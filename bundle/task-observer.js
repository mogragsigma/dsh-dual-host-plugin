// F29: observe evidence; never drive, retry, pause or repair the execution.
import {createHash} from 'node:crypto';
import {ManagedBudget} from './managed-runtime.js';
import {observationModel} from './task-observer-model.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const code=x=>typeof x==='string'&&/^[A-Z][A-Z_]{1,100}$/.test(x)?x:null;
export function validateObserver(c){
 if(c===undefined)return;
 if(!object(c)||typeof c.enabled!=='boolean'||Object.keys(c).some(k=>!['enabled','intervalMs','windowMs','diagnostics'].includes(k))||!Number.isInteger(c.intervalMs??15000)||(c.intervalMs??15000)<1000||(c.intervalMs??15000)>300000||!Number.isInteger(c.windowMs??60000)||(c.windowMs??60000)<1000||(c.windowMs??60000)>86400000)throw Error('TASK_OBSERVER_CONFIG_INVALID');
 const d=c.diagnostics,p=d?.policy;
 if(d!==undefined&&(!object(d)||typeof d.enabled!=='boolean'||Object.keys(d).some(k=>!['enabled','policy','maxRequests','endAt','timeoutMs'].includes(k))||d.enabled&&(!object(p)||Object.keys(p).some(k=>!['provider','model','reasoningEffort'].includes(k))||!['provider','model'].every(k=>typeof p[k]==='string'&&p[k].length>0&&p[k].length<=128)||p.reasoningEffort!==undefined&&(typeof p.reasoningEffort!=='string'||p.reasoningEffort.length>128)||!Number.isSafeInteger(d.maxRequests)||d.maxRequests<1||d.maxRequests>10000||!Number.isSafeInteger(d.endAt)||d.endAt<1||!Number.isInteger(d.timeoutMs??15000)||(d.timeoutMs??15000)<1000||(d.timeoutMs??15000)>45000)))throw Error('TASK_OBSERVER_MODEL_CONFIG_INVALID');
}
const fact=(kind,reason,title,detail,extra={})=>({kind,reason,title,detail,notify:false,candidate:false,...extra});
export class TaskObserver {
 constructor(g,c){
  validateObserver(c);this.g=g;this.db=g.store.db;this.c=c;this.now=g.now;this.cursor='';this.closed=false;this.lastError=null;this.controller=new AbortController();
  this.db.exec(`CREATE TABLE IF NOT EXISTS task_observations(task_id TEXT PRIMARY KEY,body TEXT NOT NULL,issue_key TEXT,episode INTEGER NOT NULL,first_seen INTEGER NOT NULL,observations INTEGER NOT NULL,observed_at INTEGER NOT NULL,notice_id TEXT,result_run INTEGER NOT NULL,diagnostic_state TEXT NOT NULL,diagnostic TEXT);
   CREATE TABLE IF NOT EXISTS task_observation_dirty(task_id TEXT PRIMARY KEY,result_run INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS task_observer_active ON managed_executions(task_id) WHERE state NOT IN ('idle','fenced');
   CREATE INDEX IF NOT EXISTS task_observer_issues ON task_observations(task_id) WHERE issue_key IS NOT NULL;
   CREATE TABLE IF NOT EXISTS task_observation_samples(task_id TEXT PRIMARY KEY,claim TEXT NOT NULL,body TEXT NOT NULL,observed_at INTEGER NOT NULL);`);
  this.db.prepare("UPDATE task_observations SET diagnostic_state='unavailable' WHERE diagnostic_state='pending'").run();
  if(c.diagnostics?.enabled&&c.diagnostics.endAt>this.now()){
   this.budgets=new ManagedBudget(this.db,this.now);this.budgets.bind('task-observer-budget',c.diagnostics.policy,{maxRequests:c.diagnostics.maxRequests,endAt:c.diagnostics.endAt},{amend:true});
   this.review=observationModel(g.ctx,c.diagnostics,(policy)=>{if(this.closed)throw Error('TASK_OBSERVER_CLOSED');return this.budgets.reserve('task-observer-budget',policy,'observer');});
  }
 }
 changed(id,baseline){this.db.prepare('INSERT OR IGNORE INTO task_observation_dirty VALUES (?,?)').run(id,baseline);}
 capture(r,s){
  // Only called after execution_validate has authenticated the live role/claim.
  if(!object(s)||Object.keys(s).some(k=>!['active','tools','background','activity'].includes(k))||typeof s.active!=='boolean'||typeof s.background!=='boolean'||!Number.isSafeInteger(s.tools)||s.tools<0||s.tools>1000||!Number.isSafeInteger(s.activity)||s.activity<0)return;
  this.db.prepare('INSERT INTO task_observation_samples VALUES (?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET claim=excluded.claim,body=excluded.body,observed_at=excluded.observed_at').run(r.task_id,r.claim,JSON.stringify(s),this.now());
 }
 facts(r){
  const id=r.task_id,control=this.g.continuity.state(id).state,report=r.report?JSON.parse(r.report):null,now=this.now();
  const evidence={execution_state:r.state,execution_round:r.runs,report_at:report?.at??null,report_summary:report?.summary?.slice(0,700)??null,error:code(r.error),source:'existing-task-contract-and-native-activity',semantic_progress:'not_attested'};
  const finish=f=>({...f,evidence});
  if(control!=='active')return finish(fact('waiting',control,control==='stopped'?'已停止':'已暂停','按你的决定保持，不自动恢复。'));
  if(r.state==='idle')return finish(fact('ready','report_ready','本轮成果已就绪','按任务报告查看成果；不等于对外交付。'));
  if(r.state==='scheduled'){const s=this.g.execution.schedules.current(id);if(s?.status==='review'||s?.reason==='deadline_reached')return finish(fact('blocked',s.reason,'计划需要核对','请核对任务修订或明确业务期限。',{notify:true}));return finish(fact('waiting',s?.reason??'schedule_conditions','等待约定的触发条件','时间、依赖或命名信号尚未全部满足，不启动执行会话。',{due:s?.next_due??null}));}
  if(r.state==='waiting'&&r.due>now)return finish(fact('waiting','schedule','等待下一次计划','尚未到约定时间，保留任务和成果。',{due:r.due}));
  if(['claimed','running'].includes(r.state)){
   if(r.lease_until<=now)return finish(fact('unknown','contact_lost','执行状态尚未核实','暂时联系不上执行端；不代表任务已经停止，不重跑原操作。',{candidate:true,notifyAfterWindow:true}));
   const row=this.db.prepare('SELECT * FROM task_observation_samples WHERE task_id=?').get(id);
   if(!row||row.claim!==r.claim||now-row.observed_at>Math.max(30000,this.c.intervalMs??15000)*2)return finish(fact('unknown','activity_unavailable','暂不能确认当前活动','已有执行认领，但还没有新鲜的原生活动证据。'));
   const s=JSON.parse(row.body);evidence.activity_observed_at=row.observed_at;evidence.activity_counter=s.activity;
   if(s.active||s.tools||s.background)return finish(fact('running',s.background?'background':'native_active',s.background?'等待当前工作结束':'正在处理','原生活动仍在进行；这本身不证明实质进展。'));
   return finish(fact('checking','idle_without_report','正在核对执行交接','暂未看到活动、成果报告或明确等待条件。',{candidate:true}));
  }
  // View approval state without invoking execution authority/control/reconciliation.
  const a=r.authority?null:this.g.approvals.view(r.approval_id);
  if(r.authority?this.g.catalog.head(id).spec_revision!==r.revision:a.state!=='approved'||a.spec_revision!==r.revision)return finish(fact('blocked','authorization','任务授权需要核对','原授权已变化或失效；按当前任务方案处理。',{notify:true}));
  if(['needs_review','fenced'].includes(r.state))return finish(fact('blocked',code(r.error)??'execution_review','任务受阻，需核对','先核对已有成果和原操作，不重复执行结果未知的动作。',{notify:true,common:providerCause(r,a)}));
  if(r.state==='waiting_input')return finish(fact('waiting','input:'+hash(report?.summary??''),'等待你的指示',report?.summary?.slice(0,700)??'请查看任务报告中的具体问题。',{notify:true}));
  if(['queued','waiting'].includes(r.state)){
   const b=this.g.execution.budgets.view(id);
   if(b.max_requests!==null&&b.used>=b.max_requests||b.end_at!==null&&b.end_at<=now)return finish(fact('blocked','task_limit','任务额度或期限已到','需要调整任务约定；不会自行增加额度或开启新窗口。',{notify:true}));
   const slots=this.g.execution.slots.list(),spec=JSON.parse(r.spec);
   if(slots.some(s=>JSON.parse(s.resources).includes('cwd:'+spec.cwd)))return finish(fact('waiting','resource','等待工作位置可用','同一工作位置仍有任务占用，避免重复写入。'));
   if(slots.filter(s=>s.role===r.role).length>=(r.role==='local'?1:3+(r.human?1:0)))return finish(fact('waiting','capacity','等待执行名额','已有工作正在推进，按既有顺序等待。'));
   return finish(fact('checking','awaiting_dispatch','等待执行端接续','当前尚无派发记录，正在核对交接。',{candidate:true}));
  }
  return finish(fact('unknown','state_unavailable','状态尚未核实','未取得足够的执行证据，不判断为完成或停滞。'));
 }
 observe(r){
  const old=this.db.prepare('SELECT * FROM task_observations WHERE task_id=?').get(r.task_id),f=this.facts(r),now=this.now();
  const controlled=this.g.continuity.state(r.task_id).state!=='active';
  const key=controlled?(old?.issue_key??null):(f.candidate||f.notify||f.kind==='blocked')?hash([r.revision,f.reason]):null,same=!!old&&key===old.issue_key;
  const episode=same?old.episode:(old?.episode??0)+(key?1:0),first=same?old.first_seen:now,count=same?old.observations+1:1;
  if(f.candidate&&count>=2&&now-first>=(this.c.windowMs??60000)){
   if(f.kind!=='unknown'){f.kind='suspected';f.title='可能没有接续推进';f.detail='多次观察仍未见活动或合理等待说明；尚不能认定业务失败。';}
   f.notify=!!f.notifyAfterWindow;
  }
  const issue=key?'observation-'+hash([r.task_id,key,episode]):null;
  const notice=old&&same?old.notice_id:null,diag=old&&same?old.diagnostic_state:'not_requested';
  this.db.prepare('INSERT INTO task_observations VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET body=excluded.body,issue_key=excluded.issue_key,episode=excluded.episode,first_seen=excluded.first_seen,observations=excluded.observations,observed_at=excluded.observed_at,notice_id=excluded.notice_id,result_run=excluded.result_run,diagnostic_state=excluded.diagnostic_state,diagnostic=excluded.diagnostic').run(r.task_id,JSON.stringify({...f,issue_id:issue}),key,episode,first,count,now,notice,old?.result_run??this.db.prepare('SELECT result_run FROM task_observation_dirty WHERE task_id=?').get(r.task_id)?.result_run??Math.max(0,r.runs-Number(['running','claimed'].includes(r.state))),diag,same?old.diagnostic:null);
  const events=[];
  if(f.notify&&!notice)events.push({id:issue,task_id:r.task_id,category:'attention',text:f.title+'。'+f.detail,common:f.common??null});
  const baseline=old?.result_run??this.db.prepare('SELECT result_run FROM task_observation_dirty WHERE task_id=?').get(r.task_id)?.result_run;
  if(baseline!==undefined&&r.runs>baseline&&['idle','waiting','scheduled'].includes(r.state)&&JSON.parse(r.report??'null')?.outcome==='ready')events.push({id:'observation-result-'+hash([r.task_id,r.runs]),task_id:r.task_id,category:'result',text:'本轮成果已就绪。'+JSON.parse(r.report).summary.slice(0,700),resultRun:r.runs});
  return events;
 }
 noticeCurrent(id,event){const row=this.db.prepare('SELECT body,issue_key FROM task_observations WHERE task_id=?').get(id),r=this.g.execution.get(id);if(!row||!r||this.g.continuity.state(id).state!=='active')return false;const b=JSON.parse(row.body),f=this.facts(r);return b.issue_id===event&&b.notify===true&&hash([r.revision,f.reason])===row.issue_key;}
 view(id){
  const row=this.db.prepare('SELECT * FROM task_observations WHERE task_id=?').get(id);if(!row)return {enabled:true,kind:'unknown',title:'尚未核对',last_checked_at:null,grants_execution:false};
  const body=JSON.parse(row.body),r=this.g.execution.get(id),settled=r&&(r.state==='idle'||r.state==='waiting'&&r.due>this.now()||this.g.continuity.state(id).state!=='active'),stale=!settled&&this.now()-row.observed_at>Math.max(3*(this.c.intervalMs??15000),this.c.windowMs??60000);
  const control=r?this.g.continuity.state(id).state:'active',changed=r&&(body.evidence?.execution_state!==r.state||body.evidence?.execution_round!==r.runs);
  return {...body,...(control!=='active'?{...this.facts(r),diagnosis:null}:changed?{kind:'unknown',title:'状态已变化，待核对',detail:'执行记录已更新，原诊断不作为当前结论。',diagnosis:null}:{}),...(stale?{kind:'unknown',title:'状态记录已过期',detail:'显示的是最后核对的记录，不能据此判断当前执行。'}:{}),last_checked_at:row.observed_at,stale,grants_execution:false,diagnostic_state:row.diagnostic_state,diagnosis:!changed&&control==='active'&&row.diagnostic?JSON.parse(row.diagnostic):null,model_budget:this.budgets?.view('task-observer-budget')??null};
 }
 tick(){
  if(this.closed||this.g.closed||this.g.maintenance?.blocked)return;
  try{
   this.lastError=null;
   const ids=this.db.prepare("SELECT task_id FROM managed_executions WHERE task_id>? AND state NOT IN ('idle','fenced') UNION SELECT task_id FROM task_observation_dirty WHERE task_id>? UNION SELECT task_id FROM task_observations WHERE task_id>? AND issue_key IS NOT NULL ORDER BY task_id LIMIT 50").all(this.cursor,this.cursor,this.cursor);
   const rows=ids.map(({task_id})=>this.g.execution.get(task_id)).filter(Boolean);
   this.cursor=ids.length===50?ids.at(-1).task_id:'';const events=[],observed=[];
   for(const r of rows)try{events.push(...this.observe(r));observed.push(r.task_id);}catch{this.lastError='TASK_OBSERVER_SOURCE_UNAVAILABLE';}
   if(events.length){this.g.notifications.observe(events);for(const e of events){if(e.resultRun)this.db.prepare('UPDATE task_observations SET result_run=? WHERE task_id=?').run(e.resultRun,e.task_id);else this.db.prepare('UPDATE task_observations SET notice_id=? WHERE task_id=?').run(e.id,e.task_id);}}
   for(const id of observed)this.db.prepare('DELETE FROM task_observation_dirty WHERE task_id=?').run(id);
   if(!this.pending&&this.review){const row=this.db.prepare("SELECT * FROM task_observations WHERE diagnostic_state='not_requested' AND json_extract(body,'$.kind')='suspected' ORDER BY observed_at,task_id LIMIT 1").get();if(row)this.pending=this.diagnose(row).finally(()=>{this.pending=null;});}
  }catch{this.lastError='TASK_OBSERVER_UNAVAILABLE';}
 }
 async diagnose(row){
  const stamp=[row.task_id,row.episode,row.issue_key];
  this.db.prepare("UPDATE task_observations SET diagnostic_state='pending' WHERE task_id=? AND episode=? AND issue_key=?").run(...stamp);
  try{
   const head=this.g.catalog.head(row.task_id),raw=JSON.parse(row.body);
   const result=await this.review.run({task:head.title,goal:head.goal.slice(0,5000),observation:raw},this.controller.signal);
   const valid=object(result)&&Object.keys(result).every(k=>['summary','missing_evidence','suggestion'].includes(k))&&['summary','missing_evidence','suggestion'].every(k=>typeof result[k]==='string'&&result[k].length<=1000);
   if(!valid)throw Error('TASK_OBSERVER_DIAGNOSIS_INVALID');
   const current=this.g.execution.get(row.task_id);
   if(this.g.catalog.head(row.task_id).spec_revision!==head.spec_revision||!current||this.g.continuity.state(row.task_id).state!=='active'||hash([current.revision,this.facts(current).reason])!==row.issue_key)throw Error('TASK_OBSERVER_STALE_DIAGNOSIS');
   if(!this.closed)this.db.prepare("UPDATE task_observations SET diagnostic_state='reviewed',diagnostic=? WHERE task_id=? AND episode=? AND issue_key=?").run(JSON.stringify({...result,is_hypothesis:true,grants_execution:false}),...stamp);
  }catch{if(!this.closed)this.db.prepare("UPDATE task_observations SET diagnostic_state='unavailable' WHERE task_id=? AND episode=? AND issue_key=?").run(...stamp);}
 }
 start(){this.tick();this.timer=setInterval(()=>this.tick(),this.c.intervalMs??15000);this.timer.unref?.();}
 async close(){this.closed=true;clearInterval(this.timer);this.controller.abort();await this.pending;this.review?.dispose();}
}
function providerCause(r,a){const error=code(r.error);return error&&/^WORKER_MODEL_(QUOTA|RATE_LIMIT|MISSING_CREDENTIAL|INVALID_CREDENTIAL)$/.test(error)?hash([r.role,(a?.proposal.model_policy??JSON.parse(r.authority).model_policy).provider,error]):null;}
