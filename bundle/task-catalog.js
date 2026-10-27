import {validateSearch,taskExecutor} from './search-contract.js';
import {createHash} from 'node:crypto';
import {parseEnvelope} from './task-envelope.js';
import {newCloudPolicy,validPolicy,validSources,validReferences,validSuggestions} from './task-context.js';
const hash=x=>createHash('sha256').update(x).digest('hex');
const json=JSON.stringify;
const text=(v,n,code)=>{if(typeof v!=='string'||!v.trim()||v.length>n)throw Error(code);return v;};
export class TaskCatalog {
 constructor(store){
  this.store=store;this.db=store.db;
  this.db.exec(`CREATE TABLE IF NOT EXISTS task_catalog(task_id TEXT PRIMARY KEY,title TEXT NOT NULL,spec_revision INTEGER NOT NULL,legacy INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS task_revisions(task_id TEXT,revision INTEGER,title TEXT,goal TEXT,source TEXT,created INTEGER,PRIMARY KEY(task_id,revision));
   CREATE TABLE IF NOT EXISTS task_catalog_events(event_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL);`);
 }
 ensure(id){
  this.store.task(id);let c=this.db.prepare('SELECT * FROM task_catalog WHERE task_id=?').get(id);if(c)return c;
  const first=this.db.prepare('SELECT * FROM ingress WHERE task_id=? ORDER BY rowid LIMIT 1').get(id);if(!first)throw Error('TASK_NOT_FOUND');
  const e=parseEnvelope(first.goal),title=(e?.title??e?.entry_interpretation??first.goal).trim().slice(0,120)||'未命名历史任务';
  this.db.prepare('INSERT OR IGNORE INTO task_revisions VALUES (?,1,?,?,?,?)').run(id,title,first.goal,json({kind:'initial-ingress',ingress_id:first.id}),Date.now());
  this.db.prepare('INSERT OR IGNORE INTO task_catalog VALUES (?,?,1,?)').run(id,title,e?0:1);
  return this.db.prepare('SELECT * FROM task_catalog WHERE task_id=?').get(id);
 }
 head(id){const c=this.ensure(id);return {...c,...this.db.prepare('SELECT goal,source,created FROM task_revisions WHERE task_id=? AND revision=?').get(id,c.spec_revision)};}
 view(id){
  const h=this.head(id),e=parseEnvelope(h.goal);
  return {task_id:id,title:h.title,spec_revision:h.spec_revision,legacy_readonly:!!h.legacy,intent:e?.intent??'legacy',model_policy:e?.model_policy??null,request:e,
   references:e?.task_context?.references??[],split_suggestions:e?.task_context?.split_suggestions??[],
   revisions:this.db.prepare('SELECT revision,title,source,created,goal FROM task_revisions WHERE task_id=? ORDER BY revision').all(id).map(({goal,...x})=>{const e=parseEnvelope(goal);return {...x,source:JSON.parse(x.source),intent:e?.intent??'legacy',model_policy:e?.model_policy??null};})};
 }
 find({query='',limit=20,after=0}={}){
  if(typeof query!=='string'||query.length>120||!Number.isInteger(limit)||limit<1||limit>50||!Number.isInteger(after)||after<0)throw Error('INVALID_CATALOG_QUERY');
  // Lazy migration leaves every historical task/ingress row intact.
  for(const {id} of this.db.prepare('SELECT id FROM tasks').all())this.ensure(id);
  const q=query.normalize('NFKC').trim().toLocaleLowerCase();
  const all=this.db.prepare('SELECT task_id,title,spec_revision,legacy FROM task_catalog ORDER BY task_id').all().filter(x=>this.db.prepare('SELECT title FROM task_revisions WHERE task_id=?').all(x.task_id).some(r=>r.title.normalize('NFKC').toLocaleLowerCase().includes(q)));
  const items=all.slice(after,after+limit).map(x=>{const h=this.head(x.task_id),e=parseEnvelope(h.goal);return {task_id:x.task_id,title:x.title,spec_revision:x.spec_revision,legacy_readonly:!!x.legacy,intent:e?.intent??'legacy',model_policy:e?.model_policy??null};});
  return {items,total:all.length,next_cursor:after+limit<all.length?after+limit:null,requires_clarification:!!q&&all.length>1};
 }
 amend(node,a,assertQuiescent){
  if(!a||!['local','cloud'].includes(node)||!Number.isInteger(a.expected_revision)||a.expected_revision<1)throw Error('INVALID_TASK_REVISION');
  text(a.event_id,256,'INVALID_UPDATE_EVENT');text(a.task_id,128,'TASK_NOT_FOUND');text(a.summary,2000,'INVALID_GOAL');
  const sources=validSources(a.sources);if(!sources.length||sources.some(s=>s.role!==node))throw Error('CONTEXT_ORIGIN_MISMATCH');
  if(!['register','plan'].includes(a.intent))throw Error('TASK_INTENT_REQUIRED');
  const policy=a.model_policy==null?null:validPolicy(a.model_policy);if(a.intent==='plan'&&!policy)throw Error('MODEL_POLICY_REQUIRED');
  const title=a.title===undefined?undefined:text(a.title,120,'INVALID_TASK_TITLE');
  const changes={task_id:a.task_id,expected_revision:a.expected_revision,summary:a.summary,sources,title,intent:a.intent,model_policy:policy,
   references:a.references??[],split_suggestions:a.split_suggestions,...(a.search?{search:a.search}:{}),...(a.notification_contract?{notification_contract:a.notification_contract}:{})};
  if(a.references!==undefined&&!Array.isArray(a.references))throw Error('REFERENCE_LIMIT');
  if(a.split_suggestions!==undefined)validSuggestions(a.split_suggestions);
  const fp=hash(json({node,...changes}));
  return this.store.tx(()=>{
   const old=this.db.prepare('SELECT * FROM task_catalog_events WHERE event_id=?').get(a.event_id);
   if(old){if(old.fingerprint!==fp)throw Error('UPDATE_EVENT_CONFLICT');return JSON.parse(old.result);}
   const h=this.head(a.task_id);if(h.spec_revision!==a.expected_revision)throw Error('TASK_REVISION_CONFLICT');
   if(h.legacy)throw Error('LEGACY_TASK_READONLY');
   if(this.store.task(a.task_id).blocked)throw Error('NEEDS_REVIEW');assertQuiescent(a.task_id);
   const e=parseEnvelope(h.goal),prior=e.task_context?.sources??[{role:e.origin.role,session_id:e.origin.session_id,message_id:e.origin.message_id,text:e.request_text,sha256:e.origin.request_sha256}];
   const merged=[...prior];
   for(const s of sources){const known=merged.find(x=>x.role===s.role&&x.session_id===s.session_id&&x.message_id===s.message_id);if(known){if(known.sha256!==s.sha256)throw Error('INVALID_CONTEXT_SOURCE');}else merged.push(s);}
   validSources(merged);
   const refs=validReferences([...new Map([...(e.task_context?.references??[]),...(a.references??[])].map(r=>[(r.host??'')+':'+r.uri,r])).values()],merged);
   const suggestions=a.split_suggestions===undefined?(e.task_context?.split_suggestions??[]):validSuggestions(a.split_suggestions);
   const search=validateSearch(a.search??null,sources);
   if(a.notification_contract!==undefined&&a.notification_contract!==1)throw Error('INVALID_TASK_ENVELOPE');
   const notify=a.notification_contract??e.notification_contract;
   const revision=h.spec_revision+1,next={...e,...(notify?{notification_contract:notify}:{}),search,executor:taskExecutor({search,notification_contract:notify}),title:title??h.title,entry_interpretation:a.summary,intent:a.intent,model_policy:policy?newCloudPolicy(policy):null,
    task_context:{schema:'dsh-task-context-v1',spec_revision:revision,sources:merged,references:refs,split_suggestions:suggestions}};
   const goal=json(next);if(goal.length>12000)throw Error('CONTEXT_LIMIT');
   const source=json({kind:'direct-user-amendment',role:node,messages:sources.map(s=>({session_id:s.session_id,message_id:s.message_id,sha256:s.sha256})),summary:a.summary});
   this.db.prepare('INSERT INTO task_revisions VALUES (?,?,?,?,?,?)').run(a.task_id,revision,next.title,goal,source,Date.now());
   this.db.prepare('UPDATE task_catalog SET title=?,spec_revision=? WHERE task_id=?').run(next.title,revision,a.task_id);
   const result={task_id:a.task_id,title:next.title,spec_revision:revision,intent:a.intent,model_policy:next.model_policy,status:'revised',execution:'not_scheduled',development:false,publish:false};
   this.db.prepare('INSERT INTO task_catalog_events VALUES (?,?,?)').run(a.event_id,fp,json(result));
   this.store.log('task-revised',{task_id:a.task_id,spec_revision:revision,node,event_id:a.event_id});return result;
  });
 }
}
