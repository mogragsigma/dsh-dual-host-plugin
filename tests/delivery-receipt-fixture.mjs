// Synthetic push/approval evidence; only private test-state files are touched.
import {setup} from './delivery-push-approval-fixture.mjs';
import {realpathSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
import {DeliveryProcessReceipts} from '../bundle/delivery-process-receipts.js';
export async function fixture(t,{real=false}={}){
 const f=await setup(t),p=await f.prompt();await f.decide(p.prompt);
 const q=f.j.enqueue({...f.input,approval_id:p.r.id,event_id:'receipt-push'}),a=f.j.acquire(q.id);f.j.markDispatched(a.id,a.epoch);
 const op=f.j.startOperation(a.id,a.epoch,'push'),directory=join(realpathSync(f.dir),'process-receipts');
 const control={live:false},io=real?{}:{bootId:()=> '11111111-1111-1111-1111-111111111111',supervisorLive:()=>control.live};
 const receipts=new DeliveryProcessReceipts({journal:f.j,directory,enabled:true},io),binding=receipts.prepare(op);
 const report=()=>({schema:1,kind:'sealed-process-receipt-v1',operation_id:op,binding_hash:binding.binding_hash,boot_id:binding.boot_id,pid:54321,start_ticks:'1',
  report:{schema:1,nonce:binding.nonce,drained:true,started:true,code:0,signal:null,cause:null,reaped:2}});
 const file=join(directory,binding.nonce+'.json');
 const write=(r=report())=>{writeFileSync(file,JSON.stringify(r),{mode:0o600});};
 const ready=()=>{f.j.spawned(op,54321);write();f.j.recover();};
 return {...f,a,op,directory,receipts,binding,control,io,file,report,write,ready};
}
