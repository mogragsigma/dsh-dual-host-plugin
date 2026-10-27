// Safe receiver state for the owned runtime. Contract 4 separately attests explicit read-only worker consent.
export function isManagedTaskRuntime(s){
 const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
 return !!s&&[1,2,3,4].includes(s.contract)&&s.available===true&&s.owned===true&&s.scope==='current_host_only'&&s.role==='cloud'&&s.configured===true&&s.desiredEnabled===true&&s.state==='active'&&uuid(s.id)&&uuid(s.instanceId)&&uuid(s.appliedOperation)&&/^[a-f0-9]{64}$/.test(s.appliedPlanHash)&&Number.isSafeInteger(s.revision)&&s.revision>0&&s.listen==='127.0.0.1'&&Number.isInteger(s.port)&&s.port>0&&s.port<65536&&s.repositoryRuntime===true&&validWorker(s)&&(s.contract>=3?validPairing(s.pairing,s)&&s.peerEnabled===s.pairing.mounted:s.peerEnabled===false)&&s.writeAuthorized===false&&s.publishEnabled===false&&s.error===null;
}
export function isManagedGatewayReceipt(r){return r?.gatewayBound===true&&r.runtimeScopeVerified===true&&isManagedTaskRuntime(r.taskRuntime);}
// Attest the actual mounted runtime, including only the independently granted
// contract-3 mailbox. A gateway object or a claimed receipt alone is insufficient.
export function isManagedGatewayRuntime(g,s){
 return !!g&&isManagedTaskRuntime(s)&&g.instanceId===s.instanceId&&g.c?.role==='cloud'&&g.c.namespace==='managed-'+s.id&&(s.workerEnabled?g.scheduler?.started===true&&!g.scheduler.closed&&g.c.scheduler?.preset==='dsh-onboarding-readonly-worker'&&g.scheduler.executors.size===1&&g.scheduler.executors.has('plan'):!g.scheduler)&&!g.development&&!g.deliveryRuntime&&!!g.peer===s.peerEnabled&&(!s.peerEnabled||g.c.peerEnabled===true&&g.peer.role==='cloud'&&g.peer.namespace===s.pairing.namespace);
}

const exact=(v,ks)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===ks.slice().sort().join();
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const revision=v=>Number.isSafeInteger(v)&&v>=0&&v<Number.MAX_SAFE_INTEGER-1;
const fail=()=>{throw Error('ONBOARDING_TASK_RUNTIME_RESPONSE_REVIEW');};
function target(v){if(!exact(v,['role','name','source','platform'])||v.role!=='cloud'||v.name!=='云端大肥鱼'||v.source!=='setup_configuration'||v.platform!=='linux')fail();}
export function cloudTaskRuntimePlan(v){
 if(!exact(v,['id','enabled','revision','target','expiresAt','fingerprint','contract','scope','workerEnabled','peerEnabled','writeAuthorized','publishEnabled'])||![2,3,4].includes(v.contract)||!uuid(v.id)||typeof v.enabled!=='boolean'||!revision(v.revision)||!Number.isSafeInteger(v.expiresAt)||!hex(v.fingerprint)||v.scope!=='current_host_only'||(v.contract===4?typeof v.workerEnabled!=='boolean'||v.workerEnabled&&!v.enabled:v.workerEnabled!==false)||v.peerEnabled!==false||v.writeAuthorized!==false||v.publishEnabled!==false)fail();target(v.target);return v;
}
export function cloudTaskRuntimeStatus(v){
 if(!exact(v,['contract','available','scope','owned','role','target','id','revision','appliedOperation','appliedPlanHash','desiredEnabled','configured','state','instanceId','listen','port','repositoryRuntime','workerEnabled','peerEnabled','writeAuthorized','publishEnabled','error',...(v?.contract>=3?['pairing']:[]),...(v?.contract===4?['workerDesiredEnabled']:[])])||![2,3,4].includes(v.contract)||v.available!==true||v.owned!==true||v.role!=='cloud'||v.scope!=='current_host_only'||!revision(v.revision)||typeof v.desiredEnabled!=='boolean'||typeof v.configured!=='boolean'||!validWorker(v)||(v.contract>=3?(!validPairing(v.pairing,v)||v.peerEnabled!==v.pairing.mounted):v.peerEnabled!==false)||v.writeAuthorized!==false||v.publishEnabled!==false||v.repositoryRuntime!==v.configured||v.error!==null&&!/^ONBOARDING_TASK_RUNTIME_[A-Z_]+$/.test(v.error))fail();target(v.target);
 if(v.revision===0){if(v.id!==null||v.appliedOperation!==null||v.appliedPlanHash!==null||v.desiredEnabled)fail();}else if(!uuid(v.id)||!uuid(v.appliedOperation)||!hex(v.appliedPlanHash))fail();
 if(v.configured){if(!isManagedTaskRuntime(v))fail();}else if(v.instanceId!==null||v.listen!==null||v.port!==null||v.state!==(v.error?'needs_review':v.desiredEnabled?'activation_pending':v.revision?'disabled':'not_configured'))fail();return v;
}

// Runtime contract 3 attests the owned single-controller transport separately.
function validPairing(p,s){
 if(!exact(p,['contract','revision','id','localId','runtimeId','enabled','mounted','namespace','appliedOperation','appliedPlanHash','workerEnabled','writeAuthorized','publishEnabled'])||p.contract!==1||!revision(p.revision)||p.runtimeId!==s.id||p.namespace!==(s.id?'managed-'+s.id:null)||typeof p.enabled!=='boolean'||typeof p.mounted!=='boolean'||p.workerEnabled!==false||p.writeAuthorized!==false||p.publishEnabled!==false||p.mounted&&(!p.enabled||!s.configured)||p.enabled&&!s.desiredEnabled)return false;
 return p.revision===0?p.id===null&&p.localId===null&&p.appliedOperation===null&&p.appliedPlanHash===null&&!p.enabled&&!p.mounted:uuid(p.id)&&uuid(p.localId)&&uuid(p.runtimeId)&&uuid(p.appliedOperation)&&hex(p.appliedPlanHash);
}

// Authorization and live scheduling are separate facts. Legacy receipts can never grant execution.
function validWorker(s){
 if(s.contract!==4)return s.workerEnabled===false;
 return typeof s.workerDesiredEnabled==='boolean'&&typeof s.workerEnabled==='boolean'&&(!s.workerDesiredEnabled||s.desiredEnabled===true)&&s.workerEnabled===(s.configured===true&&s.workerDesiredEnabled);
}
