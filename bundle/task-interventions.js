import {createHash} from 'node:crypto';
import {interventionFacts} from './intervention-state.js';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
// Own observation ledger, not a second approval or scheduler state machine.
// No user-supplied source snapshots, decisions, retries or state-control APIs.
export class TaskInterventions {
 constructor(store,now=Date.now){
  this.store=store;this.db=store.db;this.now=now;
  this.db.exec(`CREATE TABLE IF NOT EXISTS task_interventions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,source_kind TEXT NOT NULL,source_id TEXT NOT NULL,source_revision INTEGER,version INTEGER NOT NULL,lifecycle TEXT NOT NULL,body TEXT NOT NULL,fingerprint TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,last_seen INTEGER NOT NULL,observation TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS task_intervention_observations(task_id TEXT PRIMARY KEY,observed_at INTEGER NOT NULL,source_revision INTEGER);
   CREATE INDEX IF NOT EXISTS task_interventions_task ON task_interventions(task_id,lifecycle,updated);
   CREATE TABLE IF NOT EXISTS task_intervention_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,item_id TEXT NOT NULL,version INTEGER NOT NULL,event TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(item_id,version));`);
 }
 observe(item,at=this.now()){
  if(!item||typeof item.task_id!=='string'||!Number.isFinite(at))throw Error('INTERVENTION_SOURCE_INVALID');
  const facts=interventionFacts(item,at);
  return this.store.tx(()=>{
   this.store.task(item.task_id);
   const revision=this.db.prepare('SELECT spec_revision FROM task_catalog WHERE task_id=?').get(item.task_id)?.spec_revision??null;
   if(revision!==item.spec_revision)throw Error('INTERVENTION_SOURCE_CHANGED');
   const seen=new Set();
   const put=(id,old,fact,event,observation)=>{
    const body=JSON.stringify(fact),fp=digest(fact),version=(old?.version??0)+1;
    if(old?.fingerprint===fp&&old.observation===observation){this.db.prepare('UPDATE task_interventions SET last_seen=? WHERE id=?').run(at,id);return;}
    this.db.prepare('INSERT INTO task_interventions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,lifecycle=excluded.lifecycle,body=excluded.body,fingerprint=excluded.fingerprint,updated=excluded.updated,last_seen=excluded.last_seen,observation=excluded.observation').run(id,item.task_id,fact.source_kind,fact.source_id,fact.source_revision,version,fact.lifecycle,body,fp,old?.created??at,at,observation==='seen'?at:old.last_seen,observation);
    this.db.prepare('INSERT INTO task_intervention_events(item_id,version,event,body,created) VALUES (?,?,?,?,?)').run(id,version,event,body,at);
   };
   for(const fact of facts){
    if(typeof fact.source_id!=='string')continue;
    const id='intervention-'+digest([item.task_id,fact.source_kind,fact.source_id,fact.source_revision]),old=this.db.prepare('SELECT * FROM task_interventions WHERE id=?').get(id);seen.add(id);
    if(!old&&fact.lifecycle!=='open')continue;
    put(id,old,fact,!old?'observed':old.lifecycle!==fact.lifecycle?'source_state_changed':'source_updated','seen');
   }
   // Bounded source windows / missing subsystems are not completion evidence.
   for(const old of this.db.prepare("SELECT * FROM task_interventions WHERE task_id=? AND lifecycle IN ('open','unverified')").all(item.task_id))if(!seen.has(old.id)&&old.observation!=='not_in_latest_window'){
    const fact={...JSON.parse(old.body),lifecycle:'unverified',next:'本次未读取到原记录；刷新或核对原来源，不重复批准或重试。'};
    put(old.id,old,fact,'source_not_observed','not_in_latest_window');
   }
   this.db.prepare('INSERT INTO task_intervention_observations VALUES (?,?,?) ON CONFLICT(task_id) DO UPDATE SET observed_at=excluded.observed_at,source_revision=excluded.source_revision').run(item.task_id,at,item.spec_revision);
   return this.view(item.task_id);
  });
 }
 view(task){
  this.store.task(task);
  const rows=this.db.prepare("SELECT * FROM task_interventions WHERE task_id=? ORDER BY CASE WHEN lifecycle IN ('open','unverified') THEN 0 ELSE 1 END,updated DESC,id LIMIT 100").all(task);
  const total=this.db.prepare('SELECT count(*) n FROM task_interventions WHERE task_id=?').get(task).n;
  const observed=this.db.prepare('SELECT observed_at,source_revision FROM task_intervention_observations WHERE task_id=?').get(task);
  return {schema:1,initialized:!!observed,last_observed_at:observed?.observed_at??null,observed_revision:observed?.source_revision??null,authority:'cloud_observation_ledger',is_authorization:false,grants_execution:false,display_limit:100,total,has_more:total>rows.length,
   items:rows.map(r=>({...JSON.parse(r.body),
    handling:this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='intervention_operations'").get()?this.db.prepare('SELECT id,plan,state,result,created FROM intervention_operations WHERE intervention_id=? ORDER BY rowid DESC LIMIT 8').all(r.id).map(o=>({id:o.id,action:JSON.parse(o.plan).action,text:JSON.parse(o.plan).text,state:o.state,result:o.result?JSON.parse(o.result):null,created:o.created})):[],id:r.id,version:r.version,created:r.created,updated:r.updated,last_seen:r.last_seen,observation:r.observation,
    events:this.db.prepare('SELECT version,event,body,created FROM task_intervention_events WHERE item_id=? ORDER BY version DESC LIMIT 20').all(r.id).map(e=>({version:e.version,event:e.event,created:e.created,lifecycle:JSON.parse(e.body).lifecycle,user_opinion:JSON.parse(e.body).user_opinion,result:JSON.parse(e.body).result})),events_total:r.version})),
   active_total:this.db.prepare("SELECT count(*) n FROM task_interventions WHERE task_id=? AND lifecycle IN ('open','unverified')").get(task).n};
 }
}
