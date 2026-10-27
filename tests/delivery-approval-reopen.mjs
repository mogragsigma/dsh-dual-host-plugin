// Isolated test process only; no Git, API/model calls, approvals or task dispatch.
import {Coordinator} from '../bundle/store.js';
import {TaskCatalog} from '../bundle/task-catalog.js';
import {ApprovalLedger} from '../bundle/approval-ledger.js';
import {DeliveryPreview} from '../bundle/delivery-preview.js';
import {DeliveryJournal} from '../bundle/delivery-journal.js';
import {DeliveryPushApproval} from '../bundle/delivery-push-approval.js';
import {DeliveryApproval} from '../bundle/delivery-approval.js';
const [dir,approval,now]=process.argv.slice(2),store=new Coordinator(dir);
try{
 const ledger=new ApprovalLedger(store,new TaskCatalog(store),()=>Number(now),{matches:()=>true}); // synthetic repository binding
 const preview=new DeliveryPreview({store,now:ledger.now}),journal=new DeliveryJournal({store,pushEnabled:true}),bridge=new DeliveryApproval({ledger,preview,journal,enabled:true});const router=new DeliveryPushApproval({commit:bridge,journal,enabled:true});ledger.delivery=router;
 const p=ledger.view(approval).proposal.delivery,selected=p.kind==='push-execution-v1'?router:bridge,s=selected.stored(ledger.row(approval).task_id,p.plan_id,p.fingerprint);
 const authority=router.authorize({approval_id:approval,intent:s.intent});
 process.stdout.write(JSON.stringify({authority,actions:store.db.prepare('SELECT count(*) n FROM delivery_actions').get().n,operations:store.db.prepare('SELECT count(*) n FROM delivery_operations').get().n}));
}finally{store.close();}
