import {validateAutonomousSearch} from './search-contract.js';
// Reuse the existing public DeepSeek search adapter; no second search provider.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createTaskSearchReader} from './source-search.js';
import {sourceUrl} from './source-web.js';
const fail=s=>{throw Error('TASK_SEARCH_'+s);};
export function validateManagedSearch(c){if(c!==undefined&&(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!['credentialRef','model_policy'].includes(k))||typeof c.credentialRef!=='string'||!/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(c.credentialRef)))fail('CONFIG_INVALID');if(c?.model_policy)validateAutonomousSearch({scope:'configured',model_policy:c.model_policy});}
export class ManagedSearch {
 constructor(endpoint,config,createReader=createTaskSearchReader){
  validateManagedSearch(config);this.ep=endpoint;this.db=endpoint.db;this.pending=new Map();
  this.db.exec('CREATE TABLE IF NOT EXISTS managed_search_operations(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,result TEXT,error TEXT);');
  this.ready=config?createReader(endpoint.ctx,config).then(r=>{this.reader=r;}).catch(()=>{}):Promise.resolve();
 }
 async run(b,agent,a,callId,signal){
  if(!a||Object.keys(a).join()!=='query'||typeof a.query!=='string'||!a.query.trim()||a.query.length>300||/[\x00-\x1f]/.test(a.query)||typeof callId!=='string'||!callId||callId.length>256)fail('ARGUMENT_INVALID');
  const policy=b.item.spec.search;if(!policy)fail('NOT_AUTHORIZED');
  await this.ready;if(!this.reader)fail('UNAVAILABLE');
  await this.ep.validate(b);
  const id=JSON.stringify([b.item.claim,agent.id,callId]),fp=createHash('sha256').update(JSON.stringify([b.item.task_id,policy,a.query])).digest('hex');
  const old=this.db.prepare('SELECT * FROM managed_search_operations WHERE id=?').get(id);
  if(old){if(old.fingerprint!==fp)fail('EVENT_CONFLICT');if(old.state==='completed')return JSON.parse(old.result);if(this.pending.has(id))return this.pending.get(id);fail(old.error??'DISPATCH_UNCERTAIN');}
  if(this.db.prepare("SELECT 1 FROM managed_search_operations WHERE task_id=? AND state IN ('pending','uncertain')").get(b.item.task_id))fail('DISPATCH_UNCERTAIN');
  this.db.prepare("INSERT INTO managed_search_operations VALUES (?,?,?,'pending',NULL,NULL)").run(id,b.item.task_id,fp);
  const work=this.dispatch(b,a,policy,id,signal).finally(()=>this.pending.delete(id));this.pending.set(id,work);return work;
 }
 async dispatch(b,a,policy,id,signal){
  const deadline=AbortSignal.any([b.controller.signal,signal,AbortSignal.timeout(45000)].filter(Boolean));let reserved=false,recorded=false,returned=false;
  try{
   deadline.throwIfAborted();await this.ep.validate(b);
   // Reserve before credential resolution/HTTP. A lost reserve acknowledgement is
   // uncertain, never refunded/retried; native provider's sync callback cannot await A2A.
   reserved=true;await this.ep.call('reserve',{task_id:b.item.task_id,claim:b.item.claim,instance_id:b.item.instance,channel:'search',policy:policy.model_policy,purpose:'managed-search'});
   const expected={endpoint:'https://api.deepseek.com/anthropic/v1/messages',apiVersion:'2023-06-01',body:{model:policy.model_policy.model,max_tokens:2048,messages:[{role:'user',content:[{type:'text',text:'Perform a web search for the query: '+a.query}]}],tools:[{type:'web_search_20250305',name:'web_search',max_uses:1}],thinking:{type:'disabled'}}};
   const result=await this.reader.search(a.query,policy.model_policy,deadline,request=>{
    deadline.throwIfAborted();if(this.ep.closed||performance.now()>=b.validUntil)fail('CANCELLED');
    if(recorded||!isDeepStrictEqual(request,expected))fail('REQUEST_CHANGED');recorded=true;
   });returned=true;deadline.throwIfAborted();await this.ep.validate(b);
   if(!recorded)fail('DISPATCH_UNVERIFIED');
   if(!result||!Array.isArray(result.sources)||result.sources.length>100||typeof result.truncated!=='boolean')fail('RESULT_INVALID');
   const sources=[],seen=new Set();let rejected=0;
   for(const item of result.sources){let url;try{url=sourceUrl(item?.url).href;}catch{rejected++;continue;}
    if(seen.has(url))continue;seen.add(url);
    for(const [k,max] of [['title',500],['snippet',8000],['publishedAt',128]])if(item[k]!==undefined&&(typeof item[k]!=='string'||item[k].length>max||item[k].includes('\0')))fail('RESULT_INVALID');
    if(sources.length<5)sources.push({url,...Object.fromEntries(['title','snippet','publishedAt'].filter(k=>item[k]!==undefined).map(k=>[k,item[k]]))});
   }
   const output={query:a.query,scope:policy.scope,model_policy:policy.model_policy,sources,truncated:result.truncated||seen.size>5,rejected_urls:rejected,page_content_read:false,verification:"search-snippets-only; read source body with native web_fetch before confirming claims; errors or truncated/missing body remain unverified",untrusted_external_content:true};
   this.db.prepare("UPDATE managed_search_operations SET state='completed',result=? WHERE id=?").run(JSON.stringify(output),id);return output;
  }catch(e){
   const code=/^(TASK_SEARCH|TASK_RUNTIME|TASK_EXECUTION)_[A-Z_]+$/.test(e?.message)?e.message:'TASK_SEARCH_UNAVAILABLE';
   // Reserve refusal is definitive. Network/ACK uncertainty is not a retry license.
   const refused=/^TASK_RUNTIME_(?:SEARCH_BUDGET_EXHAUSTED|BUDGET_EXHAUSTED|MODEL_CHANGED|DEADLINE)$/.test(code);
   const uncertain=reserved&&!returned&&!refused;
   this.db.prepare('UPDATE managed_search_operations SET state=?,error=? WHERE id=?').run(uncertain?'uncertain':'failed',uncertain?'DISPATCH_UNCERTAIN':code.replace(/^TASK_SEARCH_/,''),id);throw Error(uncertain?'TASK_SEARCH_DISPATCH_UNCERTAIN':code);
  }
 }
}
