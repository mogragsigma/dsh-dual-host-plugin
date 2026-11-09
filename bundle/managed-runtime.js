// R3 primitives shared by the coordinator and managed execution endpoints.
// No IM identity, session deletion, implicit retry or replacement-session recovery.
import {CLOUD_TASK_POLICY} from './managed-cloud-policy.js';
import {randomUUID} from 'node:crypto';
import {isAbsolute,normalize} from 'node:path';

const json=JSON.stringify;
export const ARCHIVE_IDLE_MS=7*86400000;
const fail=code=>{throw Error('TASK_RUNTIME_'+code);};
const text=s=>typeof s==='string'&&s.length>0&&s.length<=512&&!s.includes('\0');
const atomic=(db,fn)=>{if(db.isTransaction)return fn();db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}};

// DSH rc.1 exposes Agent.model; rc.5 exposes a scoped public selection helper.
// Keep one selection per live Agent and release its listeners with that scope.
const legacySelections=new WeakMap();
export async function selectManagedModel(agent,policy,load=()=>import('@deepseek-ai/dsh-agent')){
 if(typeof agent?.model?.select==='function'){agent.model.select(policy);return;}
 const existing=legacySelections.get(agent);if(existing){existing.current={...policy};return;}
 const native=await load();
 if(typeof native.installModelSelection!=='function'||native.installModelSelection.length<2||typeof agent?.ctx?.effect!=='function')throw Error('TASK_EXECUTION_MODEL_SELECTION_UNAVAILABLE');
 const selection={current:{...policy},assembled:undefined};
 const dispose=native.installModelSelection(agent.ctx,selection);
 agent.ctx.effect(()=>()=>{dispose();legacySelections.delete(agent);});
 legacySelections.set(agent,selection);
}

// Same meaning as prototype WorkerSlots: a starting or background-settling worker
// still holds its slot. Durable ownership also prevents an offline peer's lease
// expiry from granting an unsafe replacement. Only a verified drain releases it.
export class ManagedSlots {
 constructor(db,now=Date.now,{localEnabled=true}={}){
  this.db=db;this.now=now;this.localEnabled=localEnabled;
  db.exec(`CREATE TABLE IF NOT EXISTS managed_slots(
   task_id TEXT PRIMARY KEY,claim TEXT UNIQUE NOT NULL,role TEXT NOT NULL,
   resources TEXT NOT NULL,person INTEGER NOT NULL,created INTEGER NOT NULL);`);
 }
 list(){return this.db.prepare('SELECT * FROM managed_slots ORDER BY created,task_id').all();}
 reserve({task_id,role,resources=[],humanFollowup=false}){
  if(!text(task_id)||!['local','cloud'].includes(role)||typeof humanFollowup!=='boolean'||!Array.isArray(resources)||resources.length>16||resources.some(x=>!text(x))||new Set(resources).size!==resources.length)fail('SLOT_INVALID');
  if(role==='local'&&!this.localEnabled)return {reserved:false,reason:'local_execution_retired'};
  return atomic(this.db,()=>{
   const rows=this.list();
   if(rows.some(r=>r.task_id===task_id))return {reserved:false,reason:'task_running'};
   if(rows.some(r=>JSON.parse(r.resources).some(x=>resources.includes(x))))return {reserved:false,reason:'resource_busy'};
   // CR-02: cloud 3+1, local one independently bounded worker, not a shared pool.
   const used=rows.filter(r=>r.role===role).length,limit=role==='local'?1:3+(humanFollowup?1:0);
   if(used>=limit)return {reserved:false,reason:'worker_busy'};
   const claim=randomUUID();
   this.db.prepare('INSERT INTO managed_slots VALUES (?,?,?,?,?,?)').run(task_id,claim,role,json([...resources].sort()),Number(humanFollowup),this.now());
   return {reserved:true,claim,task_id,extra_slot:role==='cloud'&&used>=3};
  });
 }
 assert(task,claim){const r=this.db.prepare('SELECT * FROM managed_slots WHERE task_id=?').get(task);if(!r||r.claim!==claim)fail('STALE_SLOT');return r;}
 release(task,claim,{drained}={}){this.assert(task,claim);if(drained!==true)fail('DRAIN_REQUIRED');this.db.prepare('DELETE FROM managed_slots WHERE task_id=? AND claim=?').run(task,claim);}
 snapshot(){const rows=this.list();return {ordinary:3,human_followup_extra:1,local_limit:this.localEnabled?1:0,cloud_held:rows.filter(r=>r.role==='cloud').length,local_held:rows.filter(r=>r.role==='local').length,held:rows.length,unknown_owners_still_hold:true};}
}

// Counts actual dispatched model requests, not model turns or token billing.
// The caller must route root, descendant, auxiliary and retry streams here BEFORE
// dispatch. Failed/unknown calls are charged; a restart never refunds them.
export class ManagedBudget {
 constructor(db,now=Date.now){
  this.db=db;this.now=now;
  db.exec(`CREATE TABLE IF NOT EXISTS managed_budgets(task_id TEXT PRIMARY KEY,policy TEXT NOT NULL,max_requests INTEGER NOT NULL,end_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS managed_model_requests(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,purpose TEXT NOT NULL,created INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS managed_model_requests_task ON managed_model_requests(task_id);`);
  if(!db.prepare('PRAGMA table_info(managed_model_requests)').all().some(x=>x.name==='usage'))db.exec('ALTER TABLE managed_model_requests ADD COLUMN usage TEXT');
  if(!db.prepare('PRAGMA table_info(managed_model_requests)').all().some(x=>x.name==='policy'))db.exec('ALTER TABLE managed_model_requests ADD COLUMN policy TEXT');
  if(!db.prepare('PRAGMA table_info(managed_budgets)').all().some(x=>x.name==='mode'))db.exec("ALTER TABLE managed_budgets ADD COLUMN mode TEXT NOT NULL DEFAULT 'capped'");
  if(!db.prepare('PRAGMA table_info(managed_budgets)').all().some(x=>x.name==='search'))db.exec('ALTER TABLE managed_budgets ADD COLUMN search TEXT');
 }
 bind(task,policy,{maxRequests,endAt,search,executionPolicy},{amend=false}={}){
  const unlimited=executionPolicy===CLOUD_TASK_POLICY;
  if(unlimited){maxRequests=0;endAt??=0;} // explicit no-limit discriminator, never a huge cap
  if(!text(task)||!policy||!text(policy.provider)||!text(policy.model)||Object.keys(policy).some(k=>!['provider','model','reasoningEffort'].includes(k))||policy.reasoningEffort!==undefined&&!text(policy.reasoningEffort)||(!unlimited&&(!Number.isSafeInteger(maxRequests)||maxRequests<1||maxRequests>100000))||!Number.isSafeInteger(endAt)||endAt!==0&&endAt<=this.now()||!unlimited&&endAt===0)fail('BUDGET_INVALID');
  const saved={provider:policy.provider,model:policy.model,...(policy.reasoningEffort!==undefined?{reasoningEffort:policy.reasoningEffort}:{})};
  const old=this.db.prepare('SELECT * FROM managed_budgets WHERE task_id=?').get(task);
  const auxiliary=search?json(search):null;
  const mode=unlimited?'unlimited':'capped';
  if(old){
   if(!unlimited&&amend&&search&&search.max_requests<this.searchUsed(task))fail('BUDGET_BELOW_USED');
   if(amend){if(!unlimited&&maxRequests<this.view(task).used)fail('BUDGET_BELOW_USED');this.db.prepare('UPDATE managed_budgets SET policy=?,max_requests=?,end_at=?,search=?,mode=? WHERE task_id=?').run(json(saved),maxRequests,endAt,auxiliary,mode,task);}
   else if(old.policy!==json(saved)||old.max_requests!==maxRequests||old.end_at!==endAt||old.search!==auxiliary||old.mode!==mode)fail('BUDGET_CHANGED');
   return this.view(task);
  }
  this.db.prepare('INSERT INTO managed_budgets(task_id,policy,max_requests,end_at,search,mode) VALUES (?,?,?,?,?,?)').run(task,json(saved),maxRequests,endAt,auxiliary,mode);return this.view(task);
 }
 view(task){const r=this.db.prepare('SELECT * FROM managed_budgets WHERE task_id=?').get(task);if(!r)fail('BUDGET_NOT_FOUND');return {...r,max_requests:r.mode==='unlimited'?null:r.max_requests,end_at:r.end_at||null,policy:JSON.parse(r.policy),search:r.search?JSON.parse(r.search):null,search_used:this.searchUsed(task),usage_status:'unknown-unless-native-reported',request_count_scope:'native llm streams and managed_search; native web_search internal requests unknown',used:this.db.prepare('SELECT count(*) n FROM managed_model_requests WHERE task_id=?').get(task).n};}
 usage(task,id,usage){
  if(!id||!usage||typeof usage!=='object')return {recorded:false,status:'unknown'};
  const safe=Object.fromEntries(Object.entries(usage).filter(([k,v])=>/^(inputTokens|outputTokens|totalTokens|cachedInputTokens)$/.test(k)&&Number.isFinite(v)&&v>=0));
  if(!Object.keys(safe).length)return {recorded:false,status:'unknown'};
  try{const r=this.db.prepare('UPDATE managed_model_requests SET usage=? WHERE task_id=? AND id=?').run(json(safe),task,id);return {recorded:r.changes===1,status:r.changes?'reported':'unknown'};}catch{return {recorded:false,status:'unknown'};}
 }
 searchUsed(task){return this.db.prepare("SELECT count(*) n FROM managed_model_requests WHERE task_id=? AND purpose='managed-search'").get(task).n;}
 reserve(task,policy,purpose,{search=false}={}){
  if(!text(purpose))fail('REQUEST_INVALID');
  return atomic(this.db,()=>{
   const b=this.view(task),p=search?b.search?.model_policy:b.policy;
   if(search&&(!p||b.mode!=='unlimited'&&b.search_used>=b.search.max_requests))fail('SEARCH_BUDGET_EXHAUSTED');
   if(!search&&purpose==='managed-search')fail('REQUEST_INVALID');
   if(policy?.provider!==p.provider||policy?.model!==p.model||p.reasoningEffort!==undefined&&policy.reasoningEffort!==p.reasoningEffort)fail('MODEL_CHANGED');
   if(b.end_at&&this.now()>=b.end_at)fail('DEADLINE');if(b.mode!=='unlimited'&&b.used>=b.max_requests)fail('BUDGET_EXHAUSTED');
   const id=randomUUID();this.db.prepare('INSERT INTO managed_model_requests(id,task_id,purpose,created,policy) VALUES (?,?,?,?,?)').run(id,task,search?'managed-search':purpose,this.now(),json(p));return {id,used:b.used+1,limit:b.max_requests};
  });
 }
}

// Persist exactly the target Host's resolved route. An execution-role default is
// subordinate to an explicit task route; absent effort is not forced to `high`.
export async function resolveManagedModel(ctx,explicit,roleDefault){
 const input=explicit??roleDefault??{};
 if(!ctx.llm?.resolveCallConfig)fail('MODEL_UNAVAILABLE');
 const p=await ctx.llm.resolveCallConfig(input,AbortSignal.timeout(5000));
 if(!text(p?.provider)||!text(p?.model)||input.provider&&p.provider!==input.provider||input.model&&p.model!==input.model||input.reasoningEffort!==undefined&&p.reasoningEffort!==input.reasoningEffort)fail('MODEL_CHANGED');
 return {provider:p.provider,model:p.model,...(p.reasoningEffort!==undefined?{reasoningEffort:p.reasoningEffort}:{})};
}

export class ManagedSessions {
 constructor(ctx,db,{now=Date.now,canResume=()=>false,canArchive=()=>false,hasBackground=async()=>true}={}){
  this.ctx=ctx;this.db=db;this.now=now;this.canResume=canResume;this.canArchive=canArchive;this.hasBackground=hasBackground;this.handles=new Map();this.pending=new Set();
  db.exec(`CREATE TABLE IF NOT EXISTS managed_sessions(task_id TEXT PRIMARY KEY,role TEXT NOT NULL,
   session_id TEXT UNIQUE NOT NULL,workspace TEXT NOT NULL,state TEXT NOT NULL,last_used INTEGER NOT NULL,error TEXT);`);
 }
 get(task){return this.db.prepare('SELECT * FROM managed_sessions WHERE task_id=?').get(task);}
 owned(id){return this.db.prepare('SELECT * FROM managed_sessions WHERE session_id=?').get(id);}
 touch(id){if(this.owned(id))this.db.prepare('UPDATE managed_sessions SET last_used=? WHERE session_id=?').run(this.now(),id);}
 update(task,state,error=null){this.db.prepare('UPDATE managed_sessions SET state=?,error=? WHERE task_id=?').run(state,error,task);}
 async open({task_id,role,workspace,agentOptions,setup}){
  if(!text(task_id)||!['local','cloud'].includes(role)||!text(workspace)||!isAbsolute(workspace)||normalize(workspace)!==workspace)fail('SESSION_INVALID');
  if(this.pending.has(task_id)||this.handles.has(task_id))fail('SESSION_BUSY');
  if(!await this.canResume(task_id))fail('EXECUTION_FENCED');
  this.pending.add(task_id);let handle,changed=false;
  try{
   let row=this.get(task_id),fresh=!row;
   if(row&&(row.role!==role||row.workspace!==workspace))fail('SESSION_BINDING_CHANGED');
   if(row&&['creating','running','uncertain'].includes(row.state))fail('SESSION_RECONCILE_REQUIRED');
   if(!this.ctx.workspaceRegistry?.unarchiveSession||!this.ctx.workspaceRegistry?.archiveSession)fail('ARCHIVE_API_UNAVAILABLE');
   if(!row){
    const id='managed-'+randomUUID();
    this.db.prepare("INSERT INTO managed_sessions VALUES (?,?,?,?,'creating',?,NULL)").run(task_id,role,id,workspace,this.now());row=this.get(task_id);changed=true;
   }
   // Public API deliberately does not prove existence. resume() MUST load the
   // same persisted identity successfully; never fall back to create().
   if(!fresh){changed=true;await this.ctx.workspaceRegistry.unarchiveSession(row.session_id);}
   if(!await this.canResume(task_id))fail('EXECUTION_FENCED');
   const options={agentOptions,setup:async(a,agent)=>{
    if(agent.id!==row.session_id||agent.session.header.cwd!==workspace)fail('SESSION_BINDING_CHANGED');
    const inner=await setup?.(a,agent);
    // The publication gate is synchronous by native contract. Do not mistake
    // an unresolved Promise for an affirmative authority decision.
    return {commit:()=>{if(this.canResume(task_id)!==true)fail('EXECUTION_FENCED');inner?.commit?.();}};
   }};
   handle=await this.ctx.agents.withoutInitiator(()=>fresh?
    this.ctx.agents.create({...options,sessionId:row.session_id,meta:{cwd:workspace}}):
    this.ctx.agents.resume({...options,resumeSessionId:row.session_id}));
   if(!await this.canResume(task_id))fail('EXECUTION_FENCED');
   this.handles.set(task_id,handle);this.update(task_id,'running');this.touch(row.session_id);return handle;
  }catch(e){
   if(handle)try{await handle.dispose();}catch{this.handles.set(task_id,handle);}
   if(changed)this.update(task_id,'uncertain',String(e.code??e.message).slice(0,200));throw e;
  }finally{this.pending.delete(task_id);}
 }
 async idle(task){
  const handle=this.handles.get(task),row=this.get(task);if(!handle||!row)fail('SESSION_NOT_OWNED');
  try{
   if(handle.agent.status!=='idle'||await this.hasBackground(row.session_id))fail('SESSION_BUSY');
   if(await this.ctx.sessions.flush(handle.agent.session)!==true)fail('PERSISTENCE_UNAVAILABLE');
   await handle.dispose();this.handles.delete(task);this.update(task,'idle');this.touch(row.session_id);
  }catch(e){this.update(task,'uncertain',String(e.code??e.message).slice(0,200));throw e;}
 }
 async archiveIdle(){
  const results=[];
  for(const row of this.db.prepare("SELECT * FROM managed_sessions WHERE state='idle' AND last_used<=?").all(this.now()-ARCHIVE_IDLE_MS)){
   if(this.pending.has(row.task_id)||this.handles.has(row.task_id)||!await this.canArchive(row.task_id)||await this.hasBackground(row.session_id)||this.ctx.agents.get(row.session_id))continue;
   this.pending.add(row.task_id);
   try{
    // No stopActivity: the native registry independently refuses active work.
    await this.ctx.workspaceRegistry.archiveSession(row.session_id);
    this.update(row.task_id,'archived');results.push({task_id:row.task_id,archived:true});
   }catch(e){results.push({task_id:row.task_id,archived:false,error:String(e.code??e.message).slice(0,200)});}
   finally{this.pending.delete(row.task_id);}
  }
  return results;
 }
}
