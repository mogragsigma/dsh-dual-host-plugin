// Browser intent only. All persisted authority remains in the server ledger.
export const versionLabels={requested:'请求已登记，待核对',observed:'已收到回执',ready:'候选已接收',receiving:'接收中',committed:'文件事务已完成',rolled_back:'已恢复原文件',needs_review:'需核对',refused:'执行前已拒绝',version_outcome_unknown:'切换结果未知',artifacts_outcome_unknown:'规则配套结果未知'};
const mutations=['receive','apply','rollback','recover','rules_apply','rules_recover'];
const previewToAction={candidate_preview:'receive',preview:'apply',rollback_preview:'rollback',recover_preview:'recover',rules_preview:'rules_apply',rules_recover_preview:'rules_recover'};
const receipt=(rows,id)=>rows?.filter(x=>x.targetId===id&&x.receipt?.state!=='refused').at(-1);
export function versionUiActions(s,{stopped=false}={},now=Date.now()){
 const idle=s.loaded&&!s.busy,v=s.versions,a=s.artifacts,pending=v?.pending||a?.pending,vr=receipt(v?.requests,s.versionId),ar=receipt(a?.requests,s.artifactId);
 const unknown=[...(v?.requests??[]),...(a?.requests??[])].some(r=>r.state==='requested');
 const common=idle&&v?.supported,plan=s.plan;
 return {load:!s.busy,candidate_preview:common&&!pending&&!s.uncertain,candidate_status:common&&!!s.candidateId,
  preview:common&&stopped&&!pending&&!s.uncertain&&v?.requests?.some(r=>r.action==='receive'&&r.targetId===s.candidateId&&r.receipt?.state==='ready'),
  status:common&&!!s.versionId,rollback_preview:common&&stopped&&!pending&&!s.uncertain&&vr?.receipt?.state==='committed',
  recover_preview:common&&stopped&&!s.uncertain&&!unknown&&!a?.pending&&vr?.receipt?.recoveryRequired===true,
  rules_preview:idle&&stopped&&a?.supported&&!pending&&!s.uncertain,rules_status:idle&&a?.supported&&!!s.artifactId,
  activation_status:idle&&s.activation?.supported&&!!s.versionId,
  activation_verify:idle&&s.activation?.supported&&!!s.versionId&&!pending&&!s.uncertain&&['committed','rolled_back'].includes(vr?.receipt?.state),
  rules_recover_preview:idle&&stopped&&a?.supported&&!s.uncertain&&!unknown&&!v?.pending&&ar?.receipt?.recoveryRequired===true,
  confirm:idle&&stopped&&!!plan&&plan.value.expiresAt>now&&!s.uncertain&&(!pending||['recover','rules_recover'].includes(plan.action)&&!unknown)};
}
export function createVersionFlow(request,emit,{operationId,onMutation=()=>{},now=Date.now}={}){
 let disposed=false,s={loaded:false,busy:null,error:null,uncertain:false,versions:null,artifacts:null,activation:null,plan:null,candidateId:'',versionId:'',artifactId:'',observation:null,uncertainRequest:null};
 const notify=()=>{if(!disposed)emit({...s});};
 const call=(action,args={})=>request('cloud_version',{action,operationId,...args});
 function choose(old,list,requests){if(list.some(x=>x.id===old))return old;const pending=requests?.find(x=>x.state==='requested'||x.receipt?.recoveryRequired);return list.find(x=>x.id===pending?.targetId)?.id??list.at(-1)?.id??'';}
 async function read(){
  const v=await call('record'),a=await call('rules_record'),activation=await call('activation_record');if(v.operationId!==operationId||a.operationId!==operationId||activation.operationId!==operationId)throw Error('ONBOARDING_CLOUD_HANDOFF_TARGET_CHANGED');
  s={...s,loaded:true,versions:v,artifacts:a,activation,candidateId:choose(s.candidateId,v.candidates??[],v.requests?.filter(x=>x.action==='receive')),versionId:choose(s.versionId,v.plans?.filter(x=>x.kind==='apply')??[],v.requests?.filter(x=>x.action!=='receive')),artifactId:choose(s.artifactId,a.plans?.filter(x=>x.kind==='apply')??[],a.requests)};
  const unresolved=s.uncertainRequest,seen=unresolved&&(unresolved.rules?a:v).requests?.find(r=>r.key===unresolved.key);
  if(unresolved&&seen?.state==='observed'){s.uncertain=false;s.uncertainRequest=null;}
 }
 async function act(action,{confirmed=false,stopped=false}={}){
  if(disposed||s.busy)return false;
  const options=versionUiActions(s,{stopped},now());
  if(action==='confirm'?!confirmed||!options.confirm:!options[action]){s={...s,error:'ONBOARDING_VERSION_UI_REFRESH_REQUIRED'};notify();return false;}
  const plan=s.plan,effect=action==='confirm'?plan.action:action,mutation=mutations.includes(effect);
  s={...s,busy:effect,error:null,...(effect.startsWith('activation_')?{observation:null}:{}),...(action==='confirm'?{}:{plan:null})};notify();
  try{
   if(action==='load'){await read();s.observation=null;}
   else{
    const args=action==='confirm'?{id:plan.value.id,fingerprint:plan.value.fingerprint,confirm:true}:effect==='preview'?{candidateId:s.candidateId}:effect==='candidate_status'?{id:s.candidateId}:['status','rollback_preview','recover_preview','activation_status','activation_verify'].includes(effect)?{id:s.versionId}:['rules_status','rules_recover_preview'].includes(effect)?{id:s.artifactId}:{};
    if(mutation){s.uncertain=true;s.uncertainRequest={rules:effect.startsWith('rules_'),key:effect.replace(/^rules_/,'')+':'+plan.value.id};onMutation();}
    const value=await call(effect,args);s.observation={action:effect,value,observedAt:now()};
    if(previewToAction[effect]&&value.id&&value.fingerprint){s.plan={action:previewToAction[effect],value};const field={candidate_preview:'candidateId',preview:'versionId',rules_preview:'artifactId'}[effect];if(field)s[field]=value.id;}
    else s.plan=null;

    await read();
   }return true;
  }catch(e){s.error=/^ONBOARDING_[A-Z_]+$/.test(e.message??'')?e.message:'ONBOARDING_UNAVAILABLE';if(mutation){s.plan=null;s.uncertain=true;}if(action==='load')s.loaded=false;return false;}
  finally{s.busy=null;notify();}
 }
 return {act,snapshot:()=>({...s}),select:(kind,id)=>{const list=kind==='candidateId'?s.versions?.candidates:kind==='versionId'?s.versions?.plans?.filter(x=>x.kind==='apply'):s.artifacts?.plans?.filter(x=>x.kind==='apply');if(s.busy||!['candidateId','versionId','artifactId'].includes(kind)||!list?.some(x=>x.id===id))return false;s={...s,[kind]:id,plan:null,observation:null};notify();return true;},cancel:()=>{if(!s.busy){s.plan=null;notify();}},dispose:()=>{disposed=true;},resume:()=>{disposed=false;notify();}};
}
