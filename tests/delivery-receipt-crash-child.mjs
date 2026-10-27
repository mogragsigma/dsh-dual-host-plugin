// Isolated test driver. Only synthetic journal/test files and harmless Python
// descendants; never invokes Git, SSH, model calls or repository mutations.
import {Coordinator} from '../bundle/store.js';
import {DeliveryJournal} from '../bundle/delivery-journal.js';
import {DeliveryProcessReceipts} from '../bundle/delivery-process-receipts.js';
import {runSupervised} from '../bundle/delivery-process.js';
const [mode,dir,op,ready]=process.argv.slice(2),store=new Coordinator(dir),j=new DeliveryJournal({store,enabled:true,pushEnabled:true,exclusive:()=>true});
try{
 const b=JSON.parse(j.db.prepare('SELECT binding FROM delivery_process_receipts WHERE operation_id=?').get(op).binding);
 if(mode==='run'){
  const code='import os,time\np=os.fork()\nif p==0:\n os.setsid();os.close(1);os.close(2);time.sleep(20)\nelse:\n open('+JSON.stringify(ready)+',"w").write("ready");print("synthetic-output-not-persisted",flush=True);time.sleep(20)';
  await runSupervised(['/usr/bin/python3','-I','-c',code],{cwd:dir,env:{PATH:'/usr/bin:/bin'},timeout:10,receipt:b,onSpawn:({pid})=>j.spawned(op,pid)});
 }else if(mode==='recover'){
  j.recover();const receipts=new DeliveryProcessReceipts({journal:j,directory:b.directory.path,enabled:true}),proof=receipts.inspect(op);
  const result=receipts.reconcile(op,proof.fingerprint),o=j.operation(op),row=j.row(o.action_id);
  process.stdout.write(JSON.stringify({proof,result,operation_state:o.state,action_state:row.state,busy:store.task(row.task_id).busy}));
 }else throw Error('TEST_MODE_INVALID');
}finally{store.close();}
