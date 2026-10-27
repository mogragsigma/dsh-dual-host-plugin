// UI carries no approval across reopening; the server owns durable authority.
export const uninstallLabels={intent:'卸载意图已登记，需核对',rules_removed:'规则已撤下，插件退役待核对',capturing:'插件退役中，需核对',committed:'自有能力已卸载，数据与备份保留',rolled_back:'已恢复原状态',refused:'本次操作执行前已拒绝',uninstall_outcome_unknown:'请求结果未知'};
const latest=(s)=>s.record?.requests?.filter(r=>r.targetId===s.id&&r.receipt?.state!=='refused').at(-1);
export function uninstallUiActions(s,{stopped=false}={},now=Date.now()){
 const ready=s.loaded&&!s.busy&&s.record?.supported,r=latest(s),unknown=s.record?.requests?.some(r=>r.state==='requested');
 const recoverable=ready&&stopped&&!s.otherPending&&!s.uncertain&&!unknown&&r?.receipt?.recoveryRequired===true;
 return {load:!s.busy,preview:ready&&stopped&&!s.otherPending&&!s.uncertain&&!s.record.blocked,status:ready&&!!s.id,recover_preview:recoverable,
  confirm:ready&&stopped&&!s.otherPending&&!s.uncertain&&s.plan?.value.expiresAt>now&&(s.plan.action==='apply'?!s.record.blocked:recoverable)};
}
export function createUninstallFlow(request,emit,{operationId,onMutation=()=>{},now=Date.now}={}){
 let disposed=false,s={loaded:false,busy:null,error:null,record:null,otherPending:false,id:'',plan:null,observation:null,uncertain:false,uncertainKey:null};
 const notify=()=>{if(!disposed)emit({...s});},call=(action,args={})=>request('cloud_version',{action:'uninstall_'+action,operationId,...args});
 async function read(){
  const u=await call('record'),v=await request('cloud_version',{action:'record',operationId}),a=await request('cloud_version',{action:'rules_record',operationId});
  if([u,v,a].some(x=>x.operationId!==operationId))throw Error('ONBOARDING_CLOUD_HANDOFF_TARGET_CHANGED');
  const plans=u.plans?.filter(p=>p.kind==='apply')??[],waiting=u.requests?.find(r=>r.state==='requested'||r.receipt?.recoveryRequired),id=plans.some(p=>p.id===s.id)?s.id:plans.find(p=>p.id===waiting?.targetId)?.id??plans.at(-1)?.id??'';
  s={...s,loaded:true,record:u,otherPending:!!(v.pending||a.pending),id};
  if(s.uncertainKey&&u.requests?.find(r=>r.key===s.uncertainKey)?.state==='observed'){s.uncertain=false;s.uncertainKey=null;}
 }
 async function act(action,{confirmed=false,stopped=false}={}){
  if(disposed||s.busy)return false;const options=uninstallUiActions(s,{stopped},now());
  if(!options[action]||action==='confirm'&&!confirmed){s.error='ONBOARDING_UNINSTALL_UI_REFRESH_REQUIRED';notify();return false;}
  const plan=s.plan,effect=action==='confirm'?plan.action:action,mutation=action==='confirm';s={...s,busy:effect,error:null,...(mutation?{}:{plan:null})};notify();
  try{
   if(action==='load'){await read();s.observation=null;}
   else{
    if(mutation){s.uncertain=true;s.uncertainKey=effect+':'+plan.value.id;onMutation();}
    const value=await call(effect,mutation?{id:plan.value.id,fingerprint:plan.value.fingerprint,confirm:true}:['status','recover_preview'].includes(action)?{id:s.id}:{});
    s.observation={action:effect,value,observedAt:now()};s.plan=null;
    if(['preview','recover_preview'].includes(action)&&value.id&&value.fingerprint){s.plan={action:action==='preview'?'apply':'recover',value};if(action==='preview')s.id=value.id;}
    await read();
   }return true;
  }catch(e){s.error=/^ONBOARDING_[A-Z_]+$/.test(e.message??'')?e.message:'ONBOARDING_UNAVAILABLE';if(mutation){s.plan=null;s.uncertain=true;}if(action==='load')s.loaded=false;return false;}
  finally{s.busy=null;notify();}
 }
 return {act,snapshot:()=>({...s}),select:id=>{if(s.busy||!s.record?.plans?.some(p=>p.kind==='apply'&&p.id===id))return false;s={...s,id,plan:null,observation:null};notify();return true;},cancel:()=>{if(!s.busy){s.plan=null;notify();}},dispose:()=>{disposed=true;},resume:()=>{disposed=false;notify();}};
}
