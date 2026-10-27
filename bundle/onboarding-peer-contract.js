const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===k.slice().sort().join();
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const rev=v=>Number.isSafeInteger(v)&&v>=0&&v<Number.MAX_SAFE_INTEGER-1;
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=()=>{throw Error('ONBOARDING_LOCAL_PAIR_RESPONSE_REVIEW');};
export function peerBindingPlan(p){
 if(!exact(p,['id','pairId','localId','runtimeId','runtimeRevision','enabled','revision','expiresAt','fingerprint','contract','namespace','scope','workerEnabled','writeAuthorized','publishEnabled'])||![p.id,p.pairId,p.localId,p.runtimeId].every(uuid)||!rev(p.runtimeRevision)||!p.runtimeRevision||!rev(p.revision)||typeof p.enabled!=='boolean'||!Number.isSafeInteger(p.expiresAt)||!hex(p.fingerprint)||p.contract!==1||p.namespace!=='managed-'+p.runtimeId||p.scope!=='single_verified_controller_transport'||p.workerEnabled!==false||p.writeAuthorized!==false||p.publishEnabled!==false)fail();return p;
}
export function peerBindingStatus(p){
 if(!exact(p,['contract','revision','id','localId','runtimeId','enabled','mounted','namespace','appliedOperation','appliedPlanHash','workerEnabled','writeAuthorized','publishEnabled'])||p.contract!==1||!rev(p.revision)||p.runtimeId!==null&&!uuid(p.runtimeId)||p.namespace!==(p.runtimeId?'managed-'+p.runtimeId:null)||typeof p.enabled!=='boolean'||typeof p.mounted!=='boolean'||p.mounted&&!p.enabled||p.workerEnabled!==false||p.writeAuthorized!==false||p.publishEnabled!==false)fail();
 if(p.revision===0){if(p.id!==null||p.localId!==null||p.appliedOperation!==null||p.appliedPlanHash!==null||p.enabled||p.mounted)fail();}else if(![p.id,p.localId,p.runtimeId,p.appliedOperation].every(uuid)||!hex(p.appliedPlanHash))fail();return p;
}
