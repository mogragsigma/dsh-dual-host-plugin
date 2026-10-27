// Synthetic baseline ONLY: tests must not treat this as a repository observation.
import {digest} from '../bundle/approval-ledger.js';
export function baseline(intent){
 const s={kind:'git-state-v1',intent_fingerprint:intent.fingerprint,workspace_identity:intent.workspace_identity,
  branch:intent.plan.branch,head_oid:intent.plan.parent,ref_oid:intent.plan.parent,index_tree_oid:'2'.repeat(intent.plan.parent.length),
  parent_tree_oid:'2'.repeat(intent.plan.parent.length),manifest_sha256:intent.plan.manifest_sha256,
  metadata:{layout_sha256:'6'.repeat(64),config_sha256:'3'.repeat(64),head_sha256:'4'.repeat(64),index_sha256:'5'.repeat(64)},objects_present:[]};return {...s,fingerprint:digest(s)};
}
