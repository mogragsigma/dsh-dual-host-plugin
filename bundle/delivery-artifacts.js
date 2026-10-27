// A durable push journal is the registry. Read-only derived entries survive a
// crash without a second INSERT/HTTP transaction and never renew task binding.
import {canonical,digest} from './approval-ledger.js';
import {deliveryAction} from './delivery-state.js';
import {repositoryURL} from './repository-gitee.js';
const same=(a,b)=>canonical(a)===canonical(b);
const has=(db,t)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const proofHash=r=>digest({task_id:r.task_id,spec_revision:r.spec_revision,task_hash:r.task_hash,proposal:JSON.parse(r.proposal),repository_revision:r.repository_revision,expires:r.expires});
function authority(db,row,intent,scope){
 const a=db.prepare('SELECT * FROM approval_requests WHERE id=? AND task_id=?').get(row.approval_id,row.task_id);
 if(!a||proofHash(a)!==a.proposal_hash)return null;
 const p=JSON.parse(a.proposal),d=p.delivery;
 if(!same(p.scopes,[scope])||d?.kind!==scope+'-execution-v1'||d.intent_fingerprint!==intent.fingerprint||d.plan_fingerprint!==intent.plan.fingerprint)return null;
 // Historical authority, not a new grant. Later expiry/revocation cannot erase
 // an already observed effect; the exact approving decision must still exist.
 const decisions=db.prepare("SELECT id,proof_hash FROM approval_decisions WHERE request_id=? AND action='approve' ORDER BY created DESC LIMIT 100").all(a.id);
 if(!decisions.some(x=>digest({approval_id:a.id,proposal_hash:a.proposal_hash,intent_fingerprint:intent.fingerprint,decision_id:x.id,proof_hash:x.proof_hash})===row.authority_hash))return null;
 return {a,p};
}
export function deliveryArtifact(g,task,id){
 if(!/^artifact-delivery-[a-f0-9-]{36}$/.test(id??''))return null;
 const db=g.store?.db,action=id.slice('artifact-'.length);
 if(!db||!['delivery_actions','approval_requests','approval_decisions'].every(t=>has(db,t)))return null;
 try{
  const view=deliveryAction(g,task,action);if(view?.kind!=='push'||view.state!=='completed'||view.remote_acceptance!=='ref_observed')return null;
  const row=db.prepare('SELECT * FROM delivery_actions WHERE id=? AND task_id=?').get(action,task),i=JSON.parse(row.intent),p=i.plan;
  const source=db.prepare('SELECT * FROM delivery_actions WHERE id=? AND task_id=?').get(p.source_action_id,task),commit=deliveryAction(g,task,p.source_action_id);
  if(!source||commit?.state!=='completed'||commit.commit_oid!==p.commit_oid)return null;
  const ci=JSON.parse(source.intent),cp=ci.plan,cr=JSON.parse(source.result);
  if(ci.fingerprint!==p.source_intent_fingerprint||digest(cr)!==p.source_result_fingerprint||cp.tree_oid!==p.tree_oid||cp.parent!==p.parent_oid||
   cp.branch!==p.branch||ci.resource!==i.resource||!same(ci.workspace_identity,i.workspace_identity)||!Array.isArray(cp.changes)||!cp.changes.length||cp.changes.length>128)return null;
  const pushAuth=authority(db,row,i,'push'),commitAuth=authority(db,source,ci,'commit');
  if(!pushAuth||!commitAuth||pushAuth.a.spec_revision!==commitAuth.a.spec_revision||!same(pushAuth.p.repository,commitAuth.p.repository))return null;
  const binding=pushAuth.p.repository;
  if(binding?.provider!=='gitee'||binding.repository_id!==p.repository_id||binding.url!==repositoryURL(p.url).url||binding.base_sha!==p.parent_oid||
   pushAuth.a.repository_revision!==binding.binding_revision||commitAuth.p.delivery.files_digest!==digest(cp.changes))return null;
  const changes={create:0,modify:0,delete:0};for(const f of cp.changes){if(!Object.hasOwn(changes,f.action))return null;changes[f.action]++;}
  const proof=digest({push_intent:i.fingerprint,push_result:JSON.parse(row.result),commit_intent:ci.fingerprint,commit_result:cr,
   push_authority:row.authority_hash,commit_authority:source.authority_hash,repository:binding,spec_revision:pushAuth.a.spec_revision});
  return {id,task_id:task,kind:'gitee_delivery',name:'交付成果 · '+p.commit_oid.slice(0,12),
   description:`本任务已推送 ${cp.changes.length} 项文件变更（新增 ${changes.create}、修改 ${changes.modify}、删除 ${changes.delete}）到 ${p.branch}。入口为固定提交的完整变更页；不代表发布、部署或整项长期任务完成。`,
   spec_revision:pushAuth.a.spec_revision,created_at:view.remote_observed_at,repository:{...binding,base_sha:p.commit_oid,branch:p.branch},
   repository_origin:binding,delivery:{action_id:action,commit_action_id:source.id,commit_oid:p.commit_oid,tree_oid:p.tree_oid,parent_oid:p.parent_oid,changes,proof_hash:proof},size:null,sha256:proof};
 }catch{return null;}
}
export function deliveryArtifactList(g,task){
 const db=g.store?.db;if(!db||!has(db,'delivery_actions'))return {items:[],total:0};
 const where="task_id=? AND state='completed' AND json_extract(intent,'$.kind')='push-execution-intent-v1'";
 try{const rows=db.prepare('SELECT id FROM delivery_actions WHERE '+where+' ORDER BY seq DESC LIMIT 100').all(task);
  return {items:rows.map(r=>deliveryArtifact(g,task,'artifact-'+r.id)).filter(Boolean),total:db.prepare('SELECT count(*) n FROM delivery_actions WHERE '+where).get(task).n};
 }catch{return {items:[],total:0,error:'ARTIFACT_DELIVERY_EVIDENCE_UNAVAILABLE'};}
}
