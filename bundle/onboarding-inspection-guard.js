// Restrict only this invocation's inspection sessions; never intercept Host-wide LLM traffic.
const presets=['standard','ptc','cordis','minimal'];
export function inspectionSessionIds(nonce){
 if(typeof nonce!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(nonce))throw Error('NATIVE_INSPECTION_NONCE');
 return presets.map(p=>'onboarding-check-'+nonce+'-'+p);
}
export function createNativeInspectionGuard(ctx,nonce){
 const ids=new Set(inspectionSessionIds(nonce));let attempts=0,closed=false;
 const off=ctx.on('agent/request',async({agent},next)=>{
  if(!closed&&ids.has(agent?.id)){attempts++;throw Error('NATIVE_ADMISSION_NO_MODEL');}
  return next();
 },{prepend:true});
 if(typeof off!=='function')throw Error('NATIVE_INSPECTION_EVENT_CONTRACT');
 return {get attempts(){return attempts;},scope:'inspection_agents_only',dispose(){if(closed)return;closed=true;off();}};
}
