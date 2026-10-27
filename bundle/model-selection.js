// Target-Host public catalog only. Never read credentials, infer dated aliases,
// generate text, persist a default, or mutate a task/approval while resolving.
import {createHash} from 'node:crypto';
import {bounded} from './recovery.js';
const text=(v,n=200)=>typeof v==='string'&&v.length>0&&v.length<=n&&!/[\u0000-\u001f]/u.test(v);
const key=v=>v.normalize('NFKC').toLowerCase().trim().replace(/^ds(?=[\s_-]|$)/u,'deepseek').replace(/[\s_-]+/gu,'');
// Normalize common selection wording, not arbitrary substrings or spelling.
// Negative/conditional/multiple-choice sentences remain unmatched.
const providerKey=v=>key(v.normalize('NFKC').trim().replace(/^(?:我想选择|我想用|我要用|我选择|我选|请使用|请用|就用|使用|选择|用|走|(?:use|via|choose)\s+)\s*/iu,'').replace(/(?:那个|这个|渠道|直连|接入|就好|即可|吧|的|[，。!?！])+$/gu,'').replace(/官方/gu,'official').replace(/[()]/gu,''));
const providerMatches=(m,hint)=>[m.provider,m.provider_name].some(n=>providerKey(n)===hint||
 n.normalize('NFKC').toLowerCase().replace(/官方/gu,' official ').split(/[\s_()·-]+/u).some(part=>providerKey(part)===hint));
const fingerprint=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const MAX_PROVIDERS=64,MAX_MODELS=512,MAX_TOTAL=4096;
function aliases(config){
 const items=config?.aliases??[];
 if(!Array.isArray(items)||items.length>128||items.some(x=>!x||Object.keys(x).some(k=>!['alias','provider','model'].includes(k))||!text(x.alias)||!text(x.provider)||!text(x.model)))throw Error('MODEL_ALIAS_CONFIG_INVALID');
 return items;
}
export class ModelSelection {
 constructor(g){this.g=g;this.aliases=aliases(g.c.modelSelection);this.pending=null;}
 available(){const llm=this.g.ctx.llm;return ['listProviders','listModels','resolveCallConfig'].every(k=>typeof llm?.[k]==='function');}
 async catalog(){
  // Coalesce concurrent discovery; a failed/hung adapter cannot cause unbounded
  // background discovery. No persistent cache and no stale success fallback.
  if(this.pending)return bounded(this.pending,6000,'MODEL_CATALOG_TIMEOUT');
  const read=(async()=>{
   const llm=this.g.ctx.llm,providers=llm.listProviders(),items=[],errors=[];
   if(!Array.isArray(providers)||providers.length>MAX_PROVIDERS||providers.some(p=>!text(p.id)||!text(p.name))||new Set(providers.map(p=>p.id)).size!==providers.length)throw Error('MODEL_CATALOG_INVALID');
   await Promise.all(providers.map(async p=>{
    try{
     const models=await llm.listModels(p.id);
     if(!Array.isArray(models)||models.length>MAX_MODELS||models.some(m=>m.provider!==p.id||!text(m.id)||!text(m.name))||new Set(models.map(m=>m.id)).size!==models.length)throw Error('MODEL_CATALOG_INVALID');
     items.push(...models.map(m=>({provider:p.id,provider_name:p.name,model:m.id,model_name:m.name})));
    }catch{errors.push({provider:p.id,code:'MODEL_CATALOG_PROVIDER_UNAVAILABLE'});}
   }));
   if(items.length>MAX_TOTAL)throw Error('MODEL_CATALOG_LIMIT');
   items.sort((a,b)=>a.provider.localeCompare(b.provider)||a.model.localeCompare(b.model));errors.sort((a,b)=>a.provider.localeCompare(b.provider));
   return {items,errors};
  })().catch(e=>{throw Error(['MODEL_CATALOG_INVALID','MODEL_CATALOG_LIMIT'].includes(e?.message)?e.message:'MODEL_CATALOG_UNAVAILABLE');});
  this.pending=read;read.finally(()=>{if(this.pending===read)this.pending=null;}).catch(()=>{});
  return bounded(read,6000,'MODEL_CATALOG_TIMEOUT');
 }
 async resolve(a){
  if(!a||Object.keys(a).some(k=>!['host','query','provider_hint','reasoningEffort'].includes(k))||a.host!==this.g.c.role||typeof a.query!=='string'||a.query.length>200||/[\u0000-\u001f]/u.test(a.query)||a.provider_hint!==undefined&&!text(a.provider_hint)||a.reasoningEffort!==undefined&&!text(a.reasoningEffort,64))throw Error('MODEL_SELECTION_INVALID');
  if(!this.available())throw Error('CAPABILITY_UNAVAILABLE');
  const {items,errors}=await this.catalog(),base={schema:1,host:a.host,observed_at:this.g.now(),catalog_fingerprint:fingerprint({items,errors,aliases:this.aliases}),freshness:'live_response',execution_authorized:false,provider_io_verified:false};
  const hint=a.provider_hint===undefined?null:providerKey(a.provider_hint);
  if(hint==='')throw Error('MODEL_SELECTION_INVALID');
  const eligible=items.filter(m=>!hint||providerMatches(m,hint));
  const q=key(a.query),mapped=this.aliases.filter(x=>key(x.alias)===q);
  const candidates=eligible.filter(m=>[key(m.model),key(m.model_name)].includes(q)||mapped.some(x=>x.provider===m.provider&&x.model===m.model));
  const page=xs=>({candidates:xs.slice(0,30),candidate_count:xs.length,truncated:xs.length>30});
  if(errors.length)return {...base,status:'catalog_incomplete',...page(candidates),errors,instruction:'目标端模型清单读取不完整，不能宣称唯一匹配；不改用本地缓存、不自动换模型。'};
  if(!q)return {...base,status:'catalog',...page(eligible),instruction:'按展示名或简称选择；无需输入 provider 标识。'};
  if(candidates.length!==1){
   // Suggestions are advisory only; fuzzy spelling/version matches never execute.
   const suggestions=candidates.length?[]:eligible.filter(m=>key(m.model).includes(q)||q.includes(key(m.model))||key(m.model).split(/[.\d]/u)[0].startsWith(q.slice(0,6))).slice(0,5);
   return {...base,status:candidates.length?'ambiguous':'not_found',...page(candidates),suggestions,instruction:candidates.length?'用普通文字列出模型和渠道名称，询问用户选择；不要要求技术编号、ask_user_question 或飞书卡片回调。':'没有确定匹配。用普通文字说明候选或请用户描述模型；禁止把相近版本当成同一模型。'};
  }
  const chosen=candidates[0],policy={provider:chosen.provider,model:chosen.model,...(a.reasoningEffort!==undefined?{reasoningEffort:a.reasoningEffort}:a.host==='cloud'?{reasoningEffort:'high'}:{})};
  let resolved;
  try{resolved=await bounded(this.g.ctx.llm.resolveCallConfig(policy,AbortSignal.timeout(2000)),2200,'MODEL_SELECTION_TIMEOUT');}
  catch{return {...base,status:'route_unavailable',...page(candidates),instruction:'目标端不能确认该模型及思考程度；保持任务未执行，不降低程度、不自动替换。'};}
  if(resolved.provider!==policy.provider||resolved.model!==policy.model||policy.reasoningEffort!==undefined&&resolved.reasoningEffort!==policy.reasoningEffort)throw Error('MODEL_ROUTE_CHANGED');
  // Re-read once after validation: changes during discovery/validation are not
  // proof of a unique route, and never silently change an existing task policy.
  const current=await this.catalog();
  if(fingerprint(current)!==fingerprint({items,errors}))return {...base,status:'catalog_changed',instruction:'目标端配置刚发生变化，请重新解析；不沿用刚才的选择。'};
  return {...base,status:'resolved',selection:chosen,model_policy:{provider:resolved.provider,model:resolved.model,...(resolved.reasoningEffort!==undefined?{reasoningEffort:resolved.reasoningEffort}:{})},instruction:'唯一匹配，直接展示友好模型名和渠道并使用精确策略，无需追问 provider。解析不等于审批或调度；旧任务恢复仍使用原策略。'};
 }
}
