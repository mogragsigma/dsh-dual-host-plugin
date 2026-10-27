// No polling. Opening a page reads only the local receipt, never starts or resumes work.
export function nodeActions(s,now=Date.now()){
 const idle=s.loaded&&!s.busy,terminal=!s.record||['not_started','rolled_back'].includes(s.record.state),r=s.record?.receipt;
 const fresh=idle&&s.fresh&&now-s.observedAt<60000;
 return {load:!s.busy,refresh:idle,preview:idle&&terminal&&!s.uncertain,start:idle&&terminal&&!s.uncertain&&s.plan?.canStart===true&&s.plan.expiresAt>now,
  stop:fresh&&r?.workerActive===true,rollback:fresh&&!terminal&&r?.workerActive===false&&['ready','failed','stopped','needs_review','rolling_back'].includes(r.state)};
}
export function createNodeFlow(request,notify,onMutation=()=>{},now=Date.now){
 let s={loaded:false,busy:false,fresh:false,uncertain:false,record:null,plan:null,error:null,observedAt:null},live=true;
 const emit=change=>{s={...s,...change};if(live)notify(s);};
 async function act(action,confirmed=false){
  if(!live||s.busy)return false;
  if(!nodeActions(s,now())[action]){emit({error:'REFRESH_REQUIRED'});return false;}
  const mutation=['start','stop','rollback'].includes(action);
  if(mutation&&confirmed!==true){emit({error:'CONFIRMATION_REQUIRED'});return false;}
  const plan=s.plan,record=s.record;emit({busy:true,error:null,fresh:false,plan:null});
  try{
   if(mutation){emit({uncertain:true});onMutation();}
   if(action==='load'||action==='refresh'){const record=await request('node_status',{refresh:action==='refresh'});emit({record,uncertain:['outcome_unknown','rollback_requested'].includes(record.state),loaded:true,fresh:action==='refresh',observedAt:action==='refresh'?now():null});}
   else if(action==='preview'){const b=await request('ssh_status',{});if(!b.configured)throw Error('ONBOARDING_SSH_NOT_BOUND');emit({plan:await request('node_preview',{expectedRevision:b.revision})});}
   else if(action==='start')emit({record:await request('node_start',{id:plan.id,fingerprint:plan.fingerprint,confirm:true})});
   else emit({record:await request('node_action',{action,operationId:record.operationId,expectedRevision:record.revision,confirm:true})});
   return true;
  }catch(e){emit({error:/^ONBOARDING_[A-Z_]+$/.test(e.message)?e.message:'UNCONFIRMED'});return false;}
  finally{emit({busy:false});}
 }
 return {act,get:()=>s,resume:()=>{live=true;},dispose:()=>{live=false;}};
}
