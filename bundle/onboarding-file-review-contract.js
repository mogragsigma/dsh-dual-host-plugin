// Bounded wire contract for a single cloud queue decision, never file content.
import {digest} from './onboarding-ssh.js';
import {fileName} from './peer-file-fs.js';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.slice().sort().join();
export const reviewUuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export const reviewHash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const int=(v,max=Number.MAX_SAFE_INTEGER-2)=>Number.isSafeInteger(v)&&v>=0&&v<=max;
const fail=()=>{throw Error('ONBOARDING_FILES_RESPONSE_REVIEW');};
export function reviewItem(v){if(!exact(v,['queue','id','origin'])||!['outgoing','incoming','broker'].includes(v.queue)||typeof v.id!=='string'||!/^file-[a-f0-9]{64}$/.test(v.id)||!(v.queue==='broker'?['local','cloud'].includes(v.origin):v.origin===''))fail();return v;}
export function reviewInput(v){if(!exact(v,['item','decision'])||!['resume','retain'].includes(v.decision))fail();reviewItem(v.item);return v;}
function details(v){
 reviewItem(v.item);if(v.name!==null){try{fileName(v.name);}catch{fail();}}
 for(const k of ['from','to'])if(v[k]!==null&&!['local','cloud'].includes(v[k]))fail();
 if(v.from!==null&&(v.from===v.to||v.from!==(v.item.queue==='outgoing'?'cloud':v.item.queue==='incoming'?'local':v.item.origin)))fail();
 if(v.size!==null&&!int(v.size,2097152)||v.sha256!==null&&!reviewHash(v.sha256)||v.taskId!==null&&(typeof v.taskId!=='string'||!/^task-[a-f0-9-]{36}$/.test(v.taskId)))fail();
 if(v.attempts!==null&&!int(v.attempts)||v.nextAt!==null&&!int(v.nextAt))fail();
}
function noAuthority(v){if(v.executionAuthorized!==false||v.repositoryWriteAuthorized!==false)fail();}
export function cloudQueueList(v,s){
 if(!exact(v,['contract','role','runtimeId','items','writes','automaticRetry','automaticDeletion','executionAuthorized','repositoryWriteAuthorized','revision','enabled'])||v.contract!==1||v.role!=='cloud'||v.runtimeId!==s.runtimeId||v.revision!==s.revision||v.enabled!==s.enabled||!Array.isArray(v.items)||v.items.length>192||v.writes!==0||v.automaticRetry!==false||v.automaticDeletion!==false)fail();noAuthority(v);
 for(const row of v.items){if(!exact(row,['item','name','from','to','size','sha256','taskId','state','reason','recoveryCheck','retained','attempts','nextAt'])||row.state!=='needs_review'||typeof row.retained!=='boolean'||!/^PEER_FILE_[A-Z_]+$/.test(row.reason)||!(row.recoveryCheck==='requires_byte_validation'||/^ONBOARDING_FILES_[A-Z_]+$/.test(row.recoveryCheck)))fail();details(row);}
 if(new Set(v.items.map(x=>JSON.stringify(x.item))).size!==v.items.length)fail();for(const q of ['outgoing','incoming','broker'])if(v.items.filter(x=>x.item.queue===q).length>64)fail();return v;
}
export function cloudQueuePlan(v,s=null){
 const keys=['id','runtimeId','role','expectedRevision','scopeHash','review','expiresAt','fingerprint','contract','kind','writes','modelRequests'];
 if(!exact(v,keys)||v.contract!==2||v.kind!=='queue_review'||!reviewUuid(v.id)||!reviewUuid(v.runtimeId)||v.role!=='cloud'||!int(v.expectedRevision)||v.expectedRevision<1||!reviewHash(v.scopeHash)||!int(v.expiresAt)||!reviewHash(v.fingerprint)||v.writes!==0||v.modelRequests!==0)fail();
 const r=v.review;if(!exact(r,['item','decision','name','from','to','size','sha256','taskId','restoreState','snapshot','attempts','nextAt','snapshotOnly','requiresSeparateEnable','preservesFiles','executionAuthorized','repositoryWriteAuthorized']))fail();reviewInput({item:r.item,decision:r.decision});details(r);noAuthority(r);
 if(r.requiresSeparateEnable!==true||r.preservesFiles!==true||r.snapshotOnly!==(r.item.queue==='outgoing')||!exact(r.snapshot,['ownerHash','rowHash','holdHash','filesHash'])||!['ownerHash','rowHash','holdHash'].every(k=>reviewHash(r.snapshot[k]))||!(r.decision==='resume'?reviewHash(r.snapshot.filesHash):r.snapshot.filesHash===null))fail();
 if(r.decision==='retain'?r.restoreState!=='needs_review':!({outgoing:['queued','broker_saved'],incoming:['receiving','publishing'],broker:['receiving','available']}[r.item.queue].includes(r.restoreState)&&r.name!==null&&r.sha256!==null&&r.size!==null&&(r.attempts===null||r.attempts<16)))fail();
 const body=Object.fromEntries(keys.slice(0,7).map(k=>[k,v[k]]));if(digest(body)!==v.fingerprint)fail();if(s&&(s.runtimeId!==v.runtimeId||s.scopeHash!==v.scopeHash||s.revision!==v.expectedRevision||s.enabled||s.active))fail();return v;
}
export function cloudQueueReceipt(v,p){
 const fields=['contract','operation','fingerprint','runtimeId','role','item','decision','stateAtDecision','attempts','nextAt','requiresSeparateEnable','preservesFiles','executionAuthorized','repositoryWriteAuthorized'];
 if(!exact(v,[...fields,...(v?.notReapplied!==undefined?['notReapplied']:[])])||v.notReapplied!==undefined&&v.notReapplied!==true||v.contract!==1||v.operation!==p.id||v.fingerprint!==p.fingerprint||v.runtimeId!==p.runtimeId||v.role!=='cloud'||digest(v.item)!==digest(p.review.item)||v.decision!==p.review.decision||v.stateAtDecision!==p.review.restoreState||v.attempts!==p.review.attempts||v.nextAt!==p.review.nextAt||v.requiresSeparateEnable!==true||v.preservesFiles!==true)fail();noAuthority(v);return v;
}
export function cloudQueueOutcome(v,p){
 if(!exact(v,['contract','runtimeId','role','operation','fingerprint','receipt','closed','automaticRetry'])||v.contract!==2||v.runtimeId!==p.runtimeId||v.role!=='cloud'||v.operation!==p.id||v.fingerprint!==p.fingerprint||typeof v.closed!=='boolean'||v.automaticRetry!==false||v.receipt!==null&&v.closed)fail();if(v.receipt!==null)cloudQueueReceipt(v.receipt,p);return v;
}
