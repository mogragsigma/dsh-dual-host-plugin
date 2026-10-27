import {baseline} from './delivery-fixture.mjs';
// Synthetic callbacks; no Git, subprocess, model, network or real approval.
import {Coordinator} from '../bundle/store.js';
import {DeliveryJournal} from '../bundle/delivery-journal.js';
const [root,id,epoch]=process.argv.slice(2),store=new Coordinator(root);
const journal=new DeliveryJournal({store,enabled:true,exclusive:()=>true,
 authorize:({approval_id,intent})=>({kind:'delivery-execution-v1',scope:'commit',execution:true,approval_id,task_id:intent.task_id,
  task_revision:intent.task_revision,intent_fingerprint:intent.fingerprint,authority_hash:'c'.repeat(64)}),
 preflight:intent=>({intent_fingerprint:intent.fingerprint,drained:true,manifest_sha256:intent.plan.manifest_sha256,
  workspace_identity:intent.workspace_identity,branch:intent.plan.branch,parent:intent.plan.parent,baseline:baseline(intent)})});
journal.markDispatched(id,Number(epoch));process.exit(29);
