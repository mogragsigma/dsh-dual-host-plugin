import {managedTaskBranch} from './task-branch.js';
// Internal push contract. No filesystem, process, credential or network access.
// A verified local commit is evidence, never authority to update a remote ref.
import {canonical,digest} from './approval-ledger.js';
import {repositoryURL} from './repository-gitee.js';
const fail=c=>{throw Error('DELIVERY_PUSH_'+c);};
const same=(a,b)=>canonical(a)===canonical(b);
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const oid=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const branch=managedTaskBranch;
const action=x=>typeof x==='string'&&/^delivery-[a-f0-9-]{36}$/.test(x);
const hashed=v=>{if(!v||typeof v!=='object'||Array.isArray(v))return false;const {fingerprint,...b}=v;return sha(fingerprint)&&digest(b)===fingerprint;};
const fields=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const keys='schema,kind,source_action_id,source_intent_fingerprint,source_result_fingerprint,repository_id,url,format,branch,ref,commit_oid,parent_oid,tree_oid,manifest_sha256,tested_content,expected_remote_oid,max_pushes,rewrite,delete,tags,publish,deploy,grants_execution,fingerprint';
export function validatePushPlan(p){
 if(!fields(p,keys)||!hashed(p)||p.schema!==1||p.kind!=='push-commit-v1'||!action(p.source_action_id)||
  !sha(p.source_intent_fingerprint)||!sha(p.source_result_fingerprint)||!Number.isSafeInteger(p.repository_id)||p.repository_id<1||
  repositoryURL(p.url).url!==p.url||p.format!=='sha1'||!branch(p.branch)||p.ref!=='refs/heads/'+p.branch||
  ![p.commit_oid,p.parent_oid,p.tree_oid].every(oid)||!sha(p.manifest_sha256)||
  !(p.expected_remote_oid===null||oid(p.expected_remote_oid))||p.expected_remote_oid===p.commit_oid||
  !fields(p.tested_content,'kind,sha256')||!['file_sha256','workspace_manifest_sha256'].includes(p.tested_content.kind)||!sha(p.tested_content.sha256)||
  p.max_pushes!==1||[p.rewrite,p.delete,p.tags,p.publish,p.deploy,p.grants_execution].some(x=>x!==false))fail('PLAN_INVALID');
 return p;
}
export function compilePush({source_action_id,commit_intent:i,commit_result:r,repository_id,expected_remote_oid}){
 const p=i?.plan;
 if(!action(source_action_id)||!hashed(i)||i.kind!=='commit-execution-intent-v1'||!hashed(p)||p.kind!=='commit-objects-v1'||
  p.format!=='sha1'||p.persisted!==false||p.grants_execution!==false||r?.kind!=='commit-readback-v1'||r.drained!==true||
  r.intent_fingerprint!==i.fingerprint||r.commit_oid!==p.computed_commit_oid||r.tree_oid!==p.tree_oid||r.branch!==p.branch||
  r.manifest_sha256!==p.manifest_sha256||!same(r.tested_content,p.tested_content))fail('COMMIT_EVIDENCE_REQUIRED');
 const body={schema:1,kind:'push-commit-v1',source_action_id,source_intent_fingerprint:i.fingerprint,source_result_fingerprint:digest(r),
  repository_id,url:i.resource,format:p.format,branch:p.branch,ref:'refs/heads/'+p.branch,commit_oid:p.computed_commit_oid,
  parent_oid:p.parent,tree_oid:p.tree_oid,manifest_sha256:p.manifest_sha256,tested_content:structuredClone(p.tested_content),
  expected_remote_oid,max_pushes:1,rewrite:false,delete:false,tags:false,publish:false,deploy:false,grants_execution:false};
 return validatePushPlan({...body,fingerprint:digest(body)});
}
export function pushIntent(store,{task_id,resource,workspace_identity,plan}){
 validatePushPlan(plan);
 const r=store.db.prepare('SELECT * FROM delivery_actions WHERE id=?').get(plan.source_action_id);
 const i=r&&JSON.parse(r.intent),result=r?.result&&JSON.parse(r.result);
 const e=r&&store.db.prepare("SELECT data FROM delivery_events WHERE action_id=? AND type='readback_completed' ORDER BY seq DESC LIMIT 1").get(r.id);
 const proof=e&&JSON.parse(e.data);
 if(!r||r.state!=='completed'||r.dispatched!==1||!Number.isSafeInteger(r.epoch)||r.task_id!==task_id||r.resource!==resource||
  !hashed(i)||i.task_id!==task_id||i.resource!==resource||digest({event_id:r.event_id,approval_id:r.approval_id,intent:i})!==r.fingerprint||
  proof?.epoch!==r.epoch||!same(proof.result,result)||store.db.prepare("SELECT 1 FROM delivery_operations WHERE action_id=? AND state<>'closed'").get(r.id)||
  !same(compilePush({source_action_id:r.id,commit_intent:i,commit_result:result,repository_id:plan.repository_id,expected_remote_oid:plan.expected_remote_oid}),plan)||
  !same(workspace_identity,i.workspace_identity)||resource!==plan.url||store.task(task_id).revision!==i.task_revision)fail('SOURCE_CHANGED');
 const body={schema:1,kind:'push-execution-intent-v1',task_id,task_revision:i.task_revision,resource,
  workspace_identity:structuredClone(workspace_identity),plan:structuredClone(plan)};
 return validatePushIntent({...body,fingerprint:digest(body)});
}
export function validatePushIntent(i){
 if(!fields(i,'schema,kind,task_id,task_revision,resource,workspace_identity,plan,fingerprint')||!hashed(i)||i.schema!==1||i.kind!=='push-execution-intent-v1'||
  !Number.isSafeInteger(i.task_revision)||i.task_revision<0)fail('INTENT_INVALID');
 validatePushPlan(i.plan);const w=i.workspace_identity;
 if(i.resource!==i.plan.url||!fields(w,'root,url,branch,base_sha,directory,git_directory')||w.url!==i.resource||w.branch!==i.plan.branch||w.base_sha!==i.plan.parent_oid||
  typeof w.root!=='string'||!w.root.startsWith('/')||w.root.length>2048||/[\x00-\x1f\x7f]/.test(w.root))fail('IDENTITY_INVALID');
 for(const v of [w.directory,w.git_directory])if(!fields(v,'device,inode')||!/^\d{1,30}$/.test(v.device)||!/^\d{1,30}$/.test(v.inode))fail('IDENTITY_INVALID');
 return i;
}
export function validatePushReadiness(i,r,now){
 validatePushIntent(i);const p=i.plan,b=r?.baseline;
 if(r?.kind!=='push-preflight-v1'||r.intent_fingerprint!==i.fingerprint||r.drained!==true||r.local_commit_verified!==true||
  r.fast_forward_verified!==(p.expected_remote_oid!==null)||!Number.isSafeInteger(r.observed_at)||r.observed_at>now||now-r.observed_at>5000||
  !fields(b,'kind,intent_fingerprint,workspace_identity,repository_id,url,ref,remote_oid,commit_oid,tree_oid,manifest_sha256,local_snapshot_sha256,fingerprint')||
  !hashed(b)||b.kind!=='push-state-v1'||b.intent_fingerprint!==i.fingerprint||!same(b.workspace_identity,i.workspace_identity)||
  b.repository_id!==p.repository_id||b.url!==p.url||b.ref!==p.ref||b.remote_oid!==p.expected_remote_oid||
  b.commit_oid!==p.commit_oid||b.tree_oid!==p.tree_oid||b.manifest_sha256!==p.manifest_sha256||!sha(b.local_snapshot_sha256))fail('PREFLIGHT_REQUIRED');
 return structuredClone(b);
}
export function pushReadback(i,proof,now){
 validatePushIntent(i);const p=i.plan;
 if(proof?.kind!=='push-readback-v1'||proof.intent_fingerprint!==i.fingerprint||proof.drained!==true||
  !Number.isSafeInteger(proof.observed_at)||proof.observed_at>now||now-proof.observed_at>5000||
  proof.repository_id!==p.repository_id||proof.url!==p.url||proof.ref!==p.ref||proof.ref_oid!==p.commit_oid||
  !same(proof.workspace_identity,i.workspace_identity))fail('READBACK_MISMATCH');
 return {kind:'push-readback-v1',intent_fingerprint:i.fingerprint,repository_id:p.repository_id,url:p.url,ref:p.ref,
  commit_oid:p.commit_oid,expected_remote_oid:p.expected_remote_oid,drained:true,observed_at:proof.observed_at,
  remote_acceptance:'ref_observed',runtime_adoption:'not_observed',publish:false,deploy:false};
}
// Command construction is not execution. The eventual transport must independently
// check ancestry before invoking the CAS lease: --force-with-lease alone permits rewrites.
export function pushCommand(p){
 validatePushPlan(p);const r=repositoryURL(p.url);
 return ['push','--porcelain','--no-verify','--no-follow-tags','--signed=false','--recurse-submodules=no',
  '--force-with-lease='+p.ref+':'+(p.expected_remote_oid??''),'--','git@gitee.com:'+r.owner+'/'+r.repo+'.git',p.commit_oid+':'+p.ref];
}
export function remoteReadCommand(p){
 validatePushPlan(p);const r=repositoryURL(p.url);
 return ['ls-remote','--refs','--exit-code','--','git@gitee.com:'+r.owner+'/'+r.repo+'.git',p.ref];
}
export function parseRemoteRef(p,{code,stdout}){
 validatePushPlan(p);
 if(typeof stdout!=='string'||stdout.length>1024)fail('REMOTE_UNKNOWN');
 if(code===2&&stdout==='')return null;
 const m=/^([a-f0-9]{40})\t(refs\/heads\/[^\r\n]+)\n$/.exec(stdout);
 if(code!==0||!m||m[2]!==p.ref)fail('REMOTE_UNKNOWN');return m[1];
}
