import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
const text=(v,n,code)=>{if(typeof v!=='string'||!v.trim()||v.length>n)throw Error(code);return v;};
export function validPolicy(p){
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['provider','model','reasoningEffort'].includes(k)))throw Error('INVALID_MODEL_POLICY');
 for(const k of ['provider','model'])text(p[k],128,'MODEL_POLICY_REQUIRED');
 if(p.reasoningEffort!==undefined)text(p.reasoningEffort,64,'INVALID_MODEL_POLICY');
 return {provider:p.provider,model:p.model,...(p.reasoningEffort!==undefined?{reasoningEffort:p.reasoningEffort}:{})};
}
export function validSources(sources){
 if(!Array.isArray(sources)||sources.length>16)throw Error('CONTEXT_LIMIT');
 const seen=new Set();
 for(const s of sources){
  if(!s||!['local','cloud'].includes(s.role))throw Error('INVALID_CONTEXT_SOURCE');
  for(const k of ['message_id','session_id'])text(s[k],256,'INVALID_CONTEXT_SOURCE');
  text(s.text,8000,'REQUEST_SIZE_UNSUPPORTED');
  if(s.sha256!==hash(s.text)||seen.has(s.role+':'+s.session_id+':'+s.message_id))throw Error('INVALID_CONTEXT_SOURCE');
  seen.add(s.role+':'+s.session_id+':'+s.message_id);
 }
 return sources.map(s=>({role:s.role,session_id:s.session_id,message_id:s.message_id,text:s.text,sha256:s.sha256}));
}
export function validReferences(refs,sources){
 if(!Array.isArray(refs)||refs.length>12)throw Error('REFERENCE_LIMIT');
 return refs.map(r=>{
  if(!r||!['url','file-reference'].includes(r.kind))throw Error('UNSUPPORTED_REFERENCE');
  text(r.title,120,'INVALID_REFERENCE');text(r.uri,1000,'INVALID_REFERENCE');
  if(!sources.some(s=>s.text.includes(r.uri)))throw Error('REFERENCE_NOT_IN_USER_CONTEXT');
  if(r.kind==='url'){
   let u;try{u=new URL(r.uri);}catch{throw Error('INVALID_REFERENCE');}
   if(u.protocol!=='https:'||u.username||u.password)throw Error('UNSUPPORTED_REFERENCE');
  }else if(!['local','cloud'].includes(r.host)||!r.uri.startsWith('/')||r.uri.includes('\0'))throw Error('INVALID_REFERENCE');
  return {kind:r.kind,title:r.title,uri:r.uri,...(r.kind==='file-reference'?{host:r.host}:{}),availability:'unverified',content_read:false};
 });
}
export function validSuggestions(items){
 if(!Array.isArray(items)||items.length>6)throw Error('SPLIT_LIMIT');
 return items.map(x=>({title:text(x.title,120,'INVALID_SPLIT'),summary:text(x.summary,500,'INVALID_SPLIT'),status:'suggestion_only'}));
}
