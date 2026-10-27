// Only a query reference survives this view. Approval is never stored or replayed.
const key='dsh-im-maintenance-reference-v1';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const bot=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const states=['connected','disconnected','connecting','provisioning','error'];
const scoped=v=>v&&v.hostStopAuthorized===false&&v.pluginSwitchAuthorized===false;
const receipt=v=>v===null||v&&uuid(v.id)&&uuid(v.instanceId)&&bot(v.botId)&&v.channel==='feishu'&&hash(v.configHash)&&['disconnect','reconnect'].includes(v.action)&&['intent','needs_review','acknowledged','reviewed'].includes(v.phase)&&Number.isSafeInteger(v.updatedAt)&&(v.review===null||v.phase==='reviewed'&&uuid(v.review?.id)&&uuid(v.review?.instanceId)&&Number.isSafeInteger(v.review?.at));
const valid=v=>scoped(v)&&v.contract===1&&v.queryContract===1&&v.scope==='single_bot_current_host'&&uuid(v.instanceId)&&Number.isSafeInteger(v.revision)&&v.revision>=0&&['observed','unavailable'].includes(v.inventoryState)&&typeof v.operationInFlight==='boolean'&&typeof v.pending==='boolean'&&receipt(v.receipt)&&v.pending===!!(v.receipt&&['intent','needs_review'].includes(v.receipt.phase))&&v.lossless===false&&v.configurationRetainedByContract===true&&v.configurationSecretsVerified===false&&v.restartMayReconnect===true&&v.automaticDisconnect===false&&Array.isArray(v.bots)&&v.bots.every(r=>bot(r.botId)&&r.channel==='feishu'&&typeof r.name==='string'&&typeof r.configured==='boolean'&&typeof r.connected==='boolean'&&states.includes(r.state)&&r.connected===(r.state==='connected')&&hash(r.configHash))&&new Set(v.bots.map(r=>r.botId)).size===v.bots.length;
export function imMaintenanceActions(s,contract,now=Date.now(),allowMutation=true){
 const c=s.current,ready=contract===1&&allowMutation&&!s.busy&&s.fresh&&!s.uncertain&&!s.storageError&&valid(c)&&c.inventoryState==='observed'&&!c.operationInFlight,selected=c?.bots.find(r=>r.botId===s.selected&&r.configured);
 return {disconnect:!!(ready&&!c.pending&&selected?.connected),reconnect:!!(ready&&!c.pending&&selected&&!selected.connected&&selected.state==='disconnected'),review:!!(ready&&c.pending),confirm:!!(ready&&s.plan&&now<s.plan.expiresAt)};
}
export function createImMaintenanceFlow(request,changed,contract,storage,now=Date.now,allowMutation=true){
 let reference=null,storageError=false;
 try{if(!storage)throw Error();const v=JSON.parse(storage.getItem(key)??'null');if(v!==null){if(!uuid(v.operationId)||Object.keys(v).some(k=>!['operationId','decisionId'].includes(k))||Object.hasOwn(v,'decisionId')&&!uuid(v.decisionId))throw Error();reference=v;}}catch{storageError=true;}
 let s={current:null,receipt:null,plan:null,selected:'',reference,storageError,busy:false,error:'',fresh:false,uncertain:!!reference||storageError,observedAt:null};
 const emit=p=>{s={...s,...p};changed(s);},invalid=()=>{throw Error('ONBOARDING_TRANSPORT_RESPONSE_INVALID');};
 function observe(v,ref){
  if(!valid(v))invalid();
  if(ref&&(v.requestedOperationId!==ref.operationId||!Object.hasOwn(v,'requestedReceipt')||!receipt(v.requestedReceipt)||v.requestedReceipt&&v.requestedReceipt.id!==ref.operationId))invalid();
  const r=ref?v.requestedReceipt:v.receipt;
  return {current:v,receipt:r,fresh:true,uncertain:s.storageError||!!ref&&(!r||!!ref.decisionId&&r.review?.id!==ref.decisionId),observedAt:now()};
 }
 async function act(action,confirmed=false){
  if(s.busy||contract!==1||!['refresh','disconnect','reconnect','review','confirm'].includes(action))return false;
  const g=imMaintenanceActions(s,contract,now(),allowMutation);
  if(action!=='refresh'&&(!g[action]||action==='confirm'&&confirmed!==true))return false;
  const p=s.plan;emit({busy:true,error:'',plan:null});
  try{
   if(action==='refresh')emit(observe(await request('im_maintenance_status',s.reference?{operationId:s.reference.operationId}:{}),s.reference));
   else if(action==='confirm'){
    const ref=p.kind==='review'?{operationId:p.operationId,decisionId:p.id}:{operationId:p.id};
    try{if(!storage)throw Error();storage.setItem(key,JSON.stringify(ref));if(storage.getItem(key)!==JSON.stringify(ref))throw Error();}catch{throw Error('ONBOARDING_IM_MAINTENANCE_REFERENCE_UNAVAILABLE');}
    emit({reference:ref,uncertain:true,fresh:false});
    const v=await request('im_maintenance_'+(p.kind==='review'?'reconcileApply':'apply'),{id:p.id,fingerprint:p.fingerprint,confirm:true,acknowledgeLoss:true});
    if(!valid(v)||v.instanceId!==p.instanceId||v.revision<=p.revision||v.receipt?.id!==ref.operationId||ref.decisionId&&v.receipt.review?.id!==ref.decisionId||p.kind==='action'&&(v.receipt.botId!==p.botId||v.receipt.action!==p.action||v.receipt.configHash!==p.configHash))invalid();
    emit(observe({...v,requestedOperationId:ref.operationId,requestedReceipt:v.receipt},ref));
   }else{
    const c=s.current,selected=c.bots.find(r=>r.botId===s.selected);
    const p=await request('im_maintenance_'+(action==='review'?'reconcilePreview':'preview'),action==='review'?{}:{action,botId:s.selected});
    if(!scoped(p)||!uuid(p.id)||p.instanceId!==c.instanceId||p.revision!==c.revision||!hash(p.fingerprint)||!hash(p.observationHash)||!Number.isSafeInteger(p.expiresAt)||p.expiresAt<=now())invalid();
    if(action==='review'?(p.kind!=='review'||p.scope!=='ledger_only'||p.priorEffectVerified!==false||p.operationId!==c.receipt?.id||!states.includes(p.observedState)):(p.kind!=='action'||p.scope!=='single_bot_current_host'||p.action!==action||p.botId!==selected?.botId||p.channel!=='feishu'||p.configHash!==selected.configHash||p.botName!==selected.name||p.mayAbortInFlight!==true||p.restartMayReconnect!==true))invalid();
    emit({plan:p});
   }
   return true;
  }catch(e){emit({fresh:false,error:/^ONBOARDING_[A-Z_]+$/.test(e?.message)?e.message:'ONBOARDING_UNAVAILABLE'});return false;}
  finally{emit({busy:false});}
 }
 return {get:()=>s,act,select:selected=>{if(!s.busy)emit({selected,plan:null});},cancel:()=>{if(!s.busy)emit({plan:null});}};
}
