import {createHash} from 'node:crypto';
import {parseEnvelope} from './task-envelope.js';
import {isSearchJobVersion} from './job-version.js';
import {sourceUrl} from './source-web.js';
const sha=x=>createHash('sha256').update(x).digest('hex');
const base='https://api.deepseek.com/anthropic/v1';
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
// Public root exports only. The adapter's default model/settings/account route are never reused.
export async function createTaskSearchReader(ctx,config){
 const [{DeepSeekSearchProvider},{credentialRef},{proxyRouteFor}]=await Promise.all([import('@deepseek-ai/dsh-web-search-deepseek'),import('@deepseek-ai/dsh-credentials'),import('@deepseek-ai/dsh-http-proxy')]);
 const reference=credentialRef(config.credentialRef);
 return {async search(query,policy,signal,recordRequest){
  if(policy.provider!=='deepseek-official'||policy.reasoningEffort!=='disabled')throw Error('SOURCE_SEARCH_PROVIDER_UNSUPPORTED');
  if(proxyRouteFor(new URL(base)).proxied||Object.entries(process.env).some(([k,v])=>/^(?:https?|all)_proxy$/i.test(k)&&v))throw Error('SOURCE_PROXY_UNSUPPORTED');
  const credentials=ctx.get?.('credentials')??ctx.credentials;if(!credentials?.resolve)throw Error('SOURCE_SEARCH_CREDENTIAL_UNAVAILABLE');
  const provider=new DeepSeekSearchProvider(()=>({baseURL:base,model:policy.model,apiVersion:'2023-06-01',maxTokens:2048,maxUses:1,
   apiKeyEnv:reference,resolveApiKey:async()=>{signal.throwIfAborted();return (await credentials.resolve(reference))?.value;},recordRequest}));
  return provider.search({query,maxResults:5},signal);
 }};
}
export class TaskSearch {
 constructor(sources,config,io={}){
  this.s=sources;this.g=sources.g;this.db=sources.db;this.pending=new Map();this.state=config?'loading':'disabled';this.reader=null;
  if(config&&(!object(config)||Object.keys(config).some(k=>k!=='credentialRef')||typeof config.credentialRef!=='string'||!/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(config.credentialRef)))throw Error('SOURCE_SEARCH_CONFIG_INVALID');
  this.db.exec('CREATE TABLE IF NOT EXISTS task_search_operations(event_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,run_id TEXT NOT NULL,state TEXT NOT NULL,error TEXT,request TEXT,created INTEGER NOT NULL);');
  this.ready=config?(io.createSearchReader??createTaskSearchReader)(this.g.ctx,config).then(r=>{if(typeof r?.search!=='function')throw Error();this.reader=r;this.state='ready';}).catch(()=>{this.state='unavailable';}):Promise.resolve();
 }
 admit(job){
  const e=parseEnvelope(job.goal);if(!e?.search)return;
  if(!isSearchJobVersion(job.version))throw Error('SOURCE_SEARCH_VERSION_REQUIRED');
  if(this.state!=='ready')throw Error('SOURCE_SEARCH_UNAVAILABLE');
  if(e.search.model_policy.provider!=='deepseek-official')throw Error('SOURCE_SEARCH_PROVIDER_UNSUPPORTED');
  if(this.uncertain(job))throw Error('SOURCE_SEARCH_DISPATCH_UNCERTAIN');
 }
 policy(worker,agent){
  const {b}=this.s.context(worker,agent),e=parseEnvelope(b.job.goal);
  if(!e.search)throw Error('SOURCE_SEARCH_NOT_AUTHORIZED');
  if(!isSearchJobVersion(b.job.version))throw Error('SOURCE_SEARCH_VERSION_REQUIRED');
  if(this.state!=='ready')throw Error('SOURCE_SEARCH_UNAVAILABLE');
  if(e.search.model_policy.provider!=='deepseek-official')throw Error('SOURCE_SEARCH_PROVIDER_UNSUPPORTED');
  return e.search;
 }
 capabilities(){return {enabled:this.state==='ready',state:this.state,contract:1,providers:['deepseek-official'],model:'explicit per-task search stage; no fallback',reasoningEffort:'disabled',max_requests_per_run:2,shared_model_dispatch_limit:6,max_results:5,credential:'Host-only public credential resolver; never copied to worker',page_content_read:false};}
 uncertain(job){
  const runs=this.g.scheduler.jobs.db.prepare('SELECT id FROM runs WHERE job_id=?').all(job.id);
  return runs.some(({id})=>this.db.prepare("SELECT event_id,state FROM task_search_operations WHERE run_id=? AND state IN ('pending','uncertain')").all(id).some(o=>o.state==='uncertain'||!this.pending.has(o.event_id)));
 }
 async run(worker,agent,a,callId,signal){
  if(!object(a)||Object.keys(a).some(k=>k!=='query')||typeof a.query!=='string'||!a.query.trim()||a.query.length>300||/[\x00-\x1f]/.test(a.query)||typeof callId!=='string'||!callId||callId.length>256)throw Error('SOURCE_ARGUMENT_INVALID');
  const {b,revision}=this.s.context(worker,agent),policy=this.policy(worker,agent);if(b.report)throw Error('SOURCE_BATCH_ALREADY_FINAL');
  const event='search:'+b.job.run_id+':'+callId,fp=sha(JSON.stringify([b.job.task_id,revision,b.job.claim,a.query,policy]));
  const old=this.db.prepare('SELECT * FROM task_search_operations WHERE event_id=?').get(event);
  if(old){if(old.fingerprint!==fp)throw Error('SOURCE_EVENT_CONFLICT');const saved=this.db.prepare('SELECT record FROM task_source_reads WHERE event_id=?').get(event);if(saved)return {...this.s.result(JSON.parse(saved.record)),replayed:true};if(this.pending.has(event))return this.pending.get(event);throw Error(old.error??'SOURCE_OPERATION_UNCERTAIN');}
  if(this.uncertain(b.job))throw Error('SOURCE_SEARCH_DISPATCH_UNCERTAIN');
  this.s.checkReadLimit(b.job.run_id);
  if(this.db.prepare('SELECT count(*) n FROM task_search_operations WHERE run_id=?').get(b.job.run_id).n>=policy.max_requests)throw Error('SOURCE_SEARCH_BUDGET_EXHAUSTED');
  const deadline=AbortSignal.any([b.signal,signal,AbortSignal.timeout(45000)].filter(Boolean));deadline.throwIfAborted();
  this.db.prepare("INSERT INTO task_search_operations VALUES (?,?,?,'pending',NULL,NULL,?)").run(event,fp,b.job.run_id,this.g.now());
  let recorded=false,returned=false;
  const record=request=>{
   deadline.throwIfAborted();this.policy(worker,agent);if(b.report)throw Error('SOURCE_BATCH_ALREADY_FINAL');
   const expected={endpoint:base+'/messages',apiVersion:'2023-06-01',body:{model:policy.model_policy.model,max_tokens:2048,messages:[{role:'user',content:[{type:'text',text:'Perform a web search for the query: '+a.query}]}],tools:[{type:'web_search_20250305',name:'web_search',max_uses:1}],thinking:{type:'disabled'}}};
   // Structural comparison doesn't accept extra messages, tools, hidden context or default models.
   if(recorded||!same(request,expected))throw Error('SOURCE_SEARCH_REQUEST_CHANGED');
   worker.reserveSearchRequest(agent,{...policy.model_policy,maxTokens:2048});
   this.db.prepare('UPDATE task_search_operations SET request=? WHERE event_id=?').run(JSON.stringify(expected),event);recorded=true;
  };
  const work=Promise.resolve().then(async()=>{try{
   const result=await this.reader.search(a.query,policy.model_policy,deadline,record);returned=true;deadline.throwIfAborted();
   this.policy(worker,agent);if(b.report)throw Error('SOURCE_BATCH_ALREADY_FINAL');if(!recorded)throw Error('SOURCE_SEARCH_DISPATCH_UNVERIFIED');
   if(!object(result)||!Array.isArray(result.sources)||result.sources.length>100||typeof result.truncated!=='boolean')throw Error('SOURCE_SEARCH_RESULT_INVALID');
   const id='evidence-'+sha(event).slice(0,40),seen=new Set(),items=[];let rejected=0;
   for(const raw of result.sources){
    let url;try{url=sourceUrl(raw?.url).href;}catch{rejected++;continue;}
    if(seen.has(url))continue;seen.add(url);
    if(['title','snippet','publishedAt'].some(k=>raw[k]!==undefined&&(typeof raw[k]!=='string'||raw[k].includes('\0')||raw[k].length>(k==='snippet'?8000:k==='title'?500:128))))throw Error('SOURCE_SEARCH_RESULT_INVALID');
    if(items.length<5)items.push({url,...Object.fromEntries(['title','snippet','publishedAt'].filter(k=>raw[k]!==undefined).map(k=>[k,raw[k]])),source_id:'search-source-'+sha(id+':'+url).slice(0,32)});
   }
   if(!items.length&&rejected)throw Error('SOURCE_SEARCH_RESULT_INVALID');
   const content=JSON.stringify({query:a.query,sources:items,truncated:result.truncated||seen.size>5,rejected_urls:rejected,page_content_read:false});
   if(Buffer.byteLength(content)>65536)throw Error('SOURCE_TOO_LARGE');
   const r={id,source_id:'search-'+sha(event).slice(0,32),task_id:b.job.task_id,spec_revision:revision,run_id:b.job.run_id,claim:b.job.claim,title:'搜索：'+a.query.slice(0,100),kind:'search',uri:null,host:this.g.c.role,format:'json',size:Buffer.byteLength(content),sha256:sha(content),read_at:this.g.now(),content,search:{query:a.query,scope:policy.scope,...policy.model_policy,max_server_uses:1,page_content_read:false}};
   this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO task_source_reads VALUES (?,?,?,?,?,?)').run(id,r.task_id,r.run_id,event,fp,JSON.stringify(r));this.db.prepare("UPDATE task_search_operations SET state='completed' WHERE event_id=?").run(event);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
   return this.s.result(r);
  }catch(e){const uncertain=recorded&&!returned,code=uncertain?'SOURCE_SEARCH_DISPATCH_UNCERTAIN':deadline.aborted?'SOURCE_SEARCH_ABORTED':/^SOURCE_[A-Z_]+$/.test(e?.message)?e.message:e?.message==='WORKER_REQUEST_BUDGET'?'SOURCE_SEARCH_MODEL_BUDGET_EXHAUSTED':/^WEB_[A-Z_]+$/.test(e?.code)?'SOURCE_'+e.code:'SOURCE_SEARCH_UNAVAILABLE';this.db.prepare('UPDATE task_search_operations SET state=?,error=? WHERE event_id=?').run(uncertain?'uncertain':'failed',code,event);throw Error(code);}
  finally{this.pending.delete(event);}});this.pending.set(event,work);return work;
 }
}
function same(a,b){if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));}
