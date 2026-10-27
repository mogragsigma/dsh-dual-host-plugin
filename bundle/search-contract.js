// A separately declared read-only stage, never a hidden global/default auxiliary model.
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function validateSearch(value,sources){
 if(value==null)return null;
 if(!object(value)||Object.keys(value).some(k=>!['scope','authorization_quote','model_policy','max_requests'].includes(k))||
  typeof value.scope!=='string'||!value.scope.trim()||value.scope.length>500||typeof value.authorization_quote!=='string'||!value.authorization_quote.trim()||value.authorization_quote.length>2000||
  !Number.isInteger(value.max_requests)||value.max_requests<1||value.max_requests>2)throw Error('SOURCE_SEARCH_POLICY_INVALID');
 const p=value.model_policy;
 if(!object(p)||Object.keys(p).some(k=>!['provider','model','reasoningEffort'].includes(k))||['provider','model'].some(k=>typeof p[k]!=='string'||!p[k]||p[k].length>128)||p.reasoningEffort!=='disabled')throw Error('SOURCE_SEARCH_MODEL_REQUIRED');
 // Provenance is Host-captured direct-user text, not a model summary, webpage or peer instruction.
 // Interpretation of positive consent/scope remains the entry's responsibility; substring isn't semantic approval.
 if(!sources.some(s=>s.text.includes(value.authorization_quote))||!value.authorization_quote.includes(value.scope)||!value.authorization_quote.toLowerCase().includes(p.model.toLowerCase()))throw Error('SOURCE_SEARCH_SOURCE_REQUIRED');
 return {scope:value.scope,authorization_quote:value.authorization_quote,model_policy:{provider:p.provider,model:p.model,reasoningEffort:'disabled'},max_requests:value.max_requests};
}
export const searchExecutor='independent-readonly-search-worker';
export const taskExecutor=e=>e.notification_contract===1?(e.search?'independent-readonly-search-notify-worker':'independent-readonly-notify-worker'):(e.search?searchExecutor:'independent-readonly-worker');
export const searchActive=goal=>{try{const e=JSON.parse(goal);return e.notification_contract===1?'active-notify':e.search?'active-search':'active';}catch{return 'active';}};
export const preparedState=goal=>searchActive(goal)==='active-notify'?'prepared-notify':searchActive(goal)==='active-search'?'prepared-search':'prepared';
export const activeSchedule=s=>['active','active-search','active-notify'].includes(s);
