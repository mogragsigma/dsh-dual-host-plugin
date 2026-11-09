import {selectedHumanContext} from './task-envelope.js';
// Defaults are resolved by the execution Host. An entry only overrides them
// when it can quote the user's actual model name, using the existing resolver.
export async function nativeModelChoice(g,a,e){
 if(a.model_policy!=null)throw Error('TASK_MODEL_USE_USER_QUERY');
 if(a.model_query===undefined)return null;
 const sources=selectedHumanContext(e.agent,g.c.role,a.context_message_ids);
 if(typeof a.model_query!=='string'||!a.model_query.trim()||!sources.some(s=>s.text.includes(a.model_query))||a.provider_hint!==undefined&&!sources.some(s=>s.text.includes(a.provider_hint)))throw Error('TASK_MODEL_USER_QUERY_REQUIRED');
 const r=await g.call('model_resolve',{host:'cloud',query:a.model_query,...(a.provider_hint!==undefined?{provider_hint:a.provider_hint}:{})});
 if(r.status!=='resolved')throw Error('TASK_MODEL_SELECTION_'+String(r.status).toUpperCase());
 return r.model_policy;
}
