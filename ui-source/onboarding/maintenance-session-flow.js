// Browser state is observation only. Persist a query reference, never an approval.
const key='dsh-maintenance-session-reference-v1';
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const pending=r=>r&&!['released','not_held','retired'].includes(r.state);
const methods={acquire:['preview','apply'],release:['releasePreview','releaseApply'],record_observation:['recoveryPreview','recover'],retire_previous_instance:['retirementPreview','retirementApply'],resume_admission:['resumePreview','resumeApply']};
const scoped=v=>v&&v.hostStopAuthorized===false&&v.pluginSwitchAuthorized===false;
const statusValid=v=>scoped(v)&&v.contract===2&&v.persisted===true&&v.scope==='coordinated_components_only'&&uuid(v.instanceId)&&Number.isSafeInteger(v.revision)&&v.revision>=0&&['open','held','needs_review','interrupted'].includes(v.state)&&typeof v.operationInFlight==='boolean'&&(!v.receipt||uuid(v.receipt.id));
export function maintenanceSessionActions(s,contract,now=Date.now()){
 const v=s.current,ready=contract===2&&!s.busy&&s.fresh&&!s.uncertain&&statusValid(v)&&!v.operationInFlight;
 const owned=ready&&pending(v.receipt)&&v.receipt.instanceId===v.instanceId;
 return {acquire:ready&&v.state==='open'&&!v.admission?.blocked,resume_admission:ready&&v.admission?.contract===1&&v.admission.blocked&&!pending(v.receipt),release:owned&&v.live?.operationId===v.receipt.id,
  record_observation:owned&&v.state==='needs_review',retire_previous_instance:ready&&v.state==='interrupted',
  confirm:ready&&!!s.plan&&s.plan.canApply===true&&now<s.plan.expiresAt};
}
export function createMaintenanceSessionFlow(request,changed,contract,storage,now=Date.now){
 let reference=null;try{const v=JSON.parse(storage?.getItem(key)??'null');if(uuid(v?.operationId))reference={operationId:v.operationId,...(uuid(v?.decisionId)?{decisionId:v.decisionId}:{})};else if(uuid(v?.decisionId))reference={operationId:null,decisionId:v.decisionId};}catch{}
 let s={current:null,receipt:null,plan:null,reference,busy:false,error:'',fresh:false,uncertain:!!reference,observedAt:null};
 const emit=patch=>{s={...s,...patch};changed(s);};
 const invalid=()=>{throw Error('ONBOARDING_TRANSPORT_RESPONSE_INVALID');};
 function observed(v,ref){
  if(!statusValid(v))invalid();
  if(ref?.operationId&&(v.requestedOperationId!==ref.operationId||v.requestedReceipt&&v.requestedReceipt.id!==ref.operationId))invalid();
  return {current:v,receipt:ref?.operationId?v.requestedReceipt:v.receipt,fresh:true,uncertain:!!ref&&(ref.decisionId?v.admission?.durable?.decision?.id!==ref.decisionId:!v.requestedReceipt),observedAt:now()};
 }
 async function act(action,confirmed=false){
  if(s.busy||contract!==2)return false;const gates=maintenanceSessionActions(s,contract,now());
  if(action==='confirm'&&(!gates.confirm||confirmed!==true))return false;
  if(action!=='refresh'&&action!=='confirm'&&!gates[action])return false;
  if(!['refresh','confirm',...Object.keys(methods)].includes(action))return false;
  const plan=s.plan;emit({busy:true,error:'',plan:null});
  try{
   if(action==='refresh')emit(observed(await request('maintenance_record_status',s.reference?.operationId?{operationId:s.reference.operationId}:{}),s.reference));
   else if(action==='confirm'){
    const reference={operationId:plan.action==='acquire'?plan.id:plan.operationId,...(plan.action==='resume_admission'?{decisionId:plan.id}:{})};
    if(!storage)throw Error('ONBOARDING_MAINTENANCE_REFERENCE_UNAVAILABLE');
    try{storage.setItem(key,JSON.stringify(reference));}catch{throw Error('ONBOARDING_MAINTENANCE_REFERENCE_UNAVAILABLE');}
    emit({reference,uncertain:true,fresh:false});
    const result=await request('maintenance_record_'+methods[plan.action][1],{id:plan.id,fingerprint:plan.fingerprint,confirm:true});
    if(!statusValid(result)||(result.receipt?.id??null)!==reference.operationId||reference.decisionId&&result.admission?.durable?.decision?.id!==reference.decisionId)invalid();
    emit({...observed(result,null),receipt:result.receipt,uncertain:false});
   }else{
    const p=await request('maintenance_record_'+methods[action][0],{});
    const scope=action==='resume_admission'?'own_execution_startup_only':['record_observation','retire_previous_instance'].includes(action)?'ledger_only':'coordinated_components_only';
    if(!scoped(p)||p.action!==action||p.scope!==scope||!uuid(p.id)||!uuid(p.instanceId)||p.instanceId!==s.current.instanceId||!Number.isFinite(p.expiresAt)||!Number.isSafeInteger(p.revision)||p.revision!==s.current.revision||typeof p.canApply!=='boolean'||!/^[a-f0-9]{64}$/.test(p.fingerprint??'')||action!=='acquire'&&((p.operationId!==null&&!uuid(p.operationId))||p.operationId!==(s.current.receipt?.id??null)))invalid();
    if(scope==='ledger_only'&&(p.componentActions!==0||action==='retire_previous_instance'&&p.signals!==0))invalid();
    emit({plan:p});
   }
   return true;
  }catch(e){emit({fresh:false,error:/^ONBOARDING_[A-Z_]+$/.test(e?.message)?e.message:'ONBOARDING_UNAVAILABLE'});return false;}
  finally{emit({busy:false});}
 }
 return {get:()=>s,act,cancel:()=>{if(!s.busy)emit({plan:null});}};
}
