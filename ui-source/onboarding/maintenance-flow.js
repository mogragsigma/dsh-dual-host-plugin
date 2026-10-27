// Browser references are query aids only; approval always binds a fresh server plan.
const referenceKey='dsh-onboarding-maintenance-reference-v1';
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const terminal=r=>['committed','rolled_back','uninstalled'].includes(r?.state);
export function maintenanceActions(s,caps,now=Date.now()){
 const pending=s.uncertain||s.current?.canRecover===true||!!s.current?.id&&!terminal(s.current);
 return {preview:!s.busy&&!!s.current&&!pending&&[1,2].includes(caps.contract),
  apply:!s.busy&&caps.contract===2&&caps.mutation===true&&s.plan?.contract===2&&s.plan.canApply===true&&s.plan.mutationAvailable===true&&now<s.plan.expiresAt&&!s.recovery,
  recover:!s.busy&&caps.contract===2&&caps.mutation===true&&s.current?.canRecover===true,
  recoveryApply:!s.busy&&caps.contract===2&&caps.mutation===true&&s.recovery?.confirmRequired===true&&now<s.recovery.expiresAt};
}
export function createMaintenanceFlow(request,changed,caps,storage,now=Date.now){
 let reference=null;try{const x=JSON.parse(storage?.getItem(referenceKey)??'null');if(uuid(x?.id))reference={id:x.id};}catch{}
 let s={current:null,receipt:null,plan:null,recovery:null,busy:false,error:'',uncertain:!!reference,reference,observedAt:null};
 const emit=patch=>{s={...s,...patch};changed(s);};
 async function act(action,confirmed=false){
  if(s.busy)return false;const gates=maintenanceActions(s,caps,now());
  if(['upgrade','repair','uninstall'].includes(action)&&!gates.preview)return false;
  if(action==='apply'&&(!gates.apply||confirmed!==true))return false;
  if(action==='recovery_preview'&&!gates.recover)return false;
  if(action==='recover'&&(!gates.recoveryApply||confirmed!==true))return false;
  if(!['refresh','upgrade','repair','uninstall','apply','recovery_preview','recover'].includes(action))return false;
  const plan=action==='recover'?s.recovery:s.plan;
  emit({busy:true,error:'',plan:null,recovery:null});
  try{
   if(action==='refresh'){
    const current=await request('maintenance_status',{});
    emit({current,observedAt:now()});
    // An active server transaction outranks an older browser query reference.
    // Never hide recovery behind a historical success or a missing old receipt.
    const active=uuid(current.id)&&(current.canRecover===true||!terminal(current));
    const receipt=active?current:s.reference?await request('maintenance_status',{id:s.reference.id}):current.lastReceipt??(current.id?current:null);
    const expected=active?current.id:s.reference?.id;
    if(expected&&receipt?.id!==expected)throw Error('ONBOARDING_TRANSPORT_RESPONSE_INVALID');
    emit({receipt,uncertain:active?!terminal(current):!!s.reference&&!terminal(receipt)});
   }else if(['upgrade','repair','uninstall'].includes(action)){
    emit({plan:await request('maintenance_preview',{action})});
   }else if(action==='recovery_preview'){
    emit({recovery:await request('maintenance_recoveryPreview',{id:s.current.id})});
   }else{
    // Persist only a receipt query reference before dispatch, never a confirmation.
    if(!storage)throw Error('ONBOARDING_MAINTENANCE_REFERENCE_UNAVAILABLE');
    storage.setItem(referenceKey,JSON.stringify({id:plan.id}));
    emit({reference:{id:plan.id},uncertain:true});
    const receipt=await request(action==='apply'?'maintenance_apply':'maintenance_recover',{id:plan.id,fingerprint:plan.fingerprint,confirm:true});
    if(receipt?.id!==plan.id)throw Error('ONBOARDING_TRANSPORT_RESPONSE_INVALID');
    emit({receipt,current:null,observedAt:null,uncertain:!terminal(receipt)});
   }
   return true;
  }catch(e){emit({error:/^ONBOARDING_[A-Z_]+$/.test(e?.message)?e.message:'ONBOARDING_UNAVAILABLE'});return false;}
  finally{emit({busy:false});}
 }
 return {get:()=>s,act,cancel:()=>{if(!s.busy)emit({plan:null,recovery:null});}};
}
