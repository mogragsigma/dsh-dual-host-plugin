// No approval or automatic request survives reopening. Only the server keeps intent.
export const reclaimLabels={refused:'本次确认已失效，执行前拒绝',not_requested:'尚无目标端删除意图',unobserved:'未观察到删除意图，原请求结果仍未知',deleting:'回收尚未完成，需核对',committed:'运行时已回收，用户数据和历史保留',reclamation_outcome_unknown:'原请求结果未知'};
export const reclaimResultLabel=v=>v?.executionState==='running'?'后台回收执行中，手动查询进度':v?.executionState==='interrupted'?'后台回收已中断，恢复须另行确认':reclaimLabels[v?.state]??'尚无回收回执';
const latest=s=>s.record?.requests?.filter(r=>r.targetId===s.id).at(-1);
export function reclaimUiActions(s,{stopped=false}={},now=Date.now()){
 const ready=s.loaded&&!s.busy&&s.record?.supported,r=latest(s),recovery=r&&(r.receipt?.state==='deleting'&&r.receipt?.workerActive!==true||r.state==='requested'&&r.observedAbsent);
 const eligible=ready&&stopped&&s.uninstallCompleted&&!s.otherPending&&!s.uncertain;
 return {load:!s.busy,preview:eligible&&!s.record.blocked,status:ready&&(!!r&&r.receipt?.state!=='refused'||s.uncertain&&!!s.id),recover_preview:eligible&&!!recovery,confirm:eligible&&s.plan?.value.expiresAt>now&&(s.plan.action==='apply'?!s.record.blocked:!!recovery)};
}
export function createReclaimFlow(request,emit,{operationId,onMutation=()=>{},now=Date.now}={}){
 let disposed=false,s={loaded:false,busy:null,error:null,record:null,id:'',plan:null,observation:null,uncertain:false,uncertainKey:null,uninstallCompleted:false,otherPending:false};
 const notify=()=>{if(!disposed)emit({...s});},call=(action,args={})=>request('cloud_version',{action:'reclaim_'+action,operationId,...args});
 async function read(){
  const rec=await call('record'),un=await request('cloud_version',{action:'uninstall_record',operationId}),v=await request('cloud_version',{action:'record',operationId}),a=await request('cloud_version',{action:'rules_record',operationId});
  if([rec,un,v,a].some(x=>x.operationId!==operationId))throw Error('ONBOARDING_CLOUD_HANDOFF_TARGET_CHANGED');
  const plans=rec.plans?.filter(p=>p.kind==='apply')??[],id=rec.requests?.filter(r=>r.receipt?.state!=='refused').at(-1)?.targetId??plans.at(-1)?.id??'';
  s={...s,loaded:true,record:rec,id,uninstallCompleted:un.pending===false&&un.requests?.at(-1)?.receipt?.state==='committed',otherPending:!!(v.pending||a.pending||un.pending)};
  const r=rec.requests?.find(r=>r.key===s.uncertainKey);if(r&&(r.state==='observed'||r.observedAbsent)){s.uncertain=false;s.uncertainKey=null;}
 }
 async function act(action,{confirmed=false,stopped=false}={}){
  if(disposed||s.busy)return false;const enabled=reclaimUiActions(s,{stopped},now());
  if(!enabled[action]||action==='confirm'&&!confirmed){s.error='ONBOARDING_RECLAIM_UI_REFRESH_REQUIRED';notify();return false;}
  const plan=s.plan,effect=action==='confirm'?plan.action:action,mutation=action==='confirm';s={...s,busy:effect,error:null,observation:null,...(mutation?{}:{plan:null})};notify();
  try{
   if(action==='load'){await read();s.observation=null;}
   else{
    if(mutation){s.uncertain=true;s.uncertainKey=effect+':'+plan.value.id;onMutation();}
    const value=await call(effect,mutation?{id:plan.value.id,fingerprint:plan.value.fingerprint,confirm:true}:['status','recover_preview'].includes(action)?{id:s.id}:{});
    s.observation={action:effect,value,observedAt:now()};s.plan=null;
    if(['preview','recover_preview'].includes(action)&&value.id&&value.fingerprint)s.plan={action:action==='preview'?'apply':'recover',value};
    await read();
   }return true;
  }catch(e){s.error=/^ONBOARDING_[A-Z_]+$/.test(e.message??'')?e.message:'ONBOARDING_UNAVAILABLE';if(mutation){s.plan=null;s.uncertain=true;}if(action==='load')s.loaded=false;return false;}
  finally{s.busy=null;notify();}
 }
 return {act,snapshot:()=>({...s}),cancel:()=>{if(!s.busy){s.plan=null;notify();}},dispose:()=>{disposed=true;},resume:()=>{disposed=false;notify();}};
}
