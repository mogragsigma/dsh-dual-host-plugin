import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ImDelivery} from '../bundle/im-delivery.js';
import {migrateRecovery,outboxInsert} from '../bundle/recovery.js';
import {installNativeContext} from '../bundle/native-context.js';
const pins={botId:'verified_bot',targetId:'group',expectedFingerprint:'a'.repeat(64),expectedTargetDigest:'b'.repeat(64),conversationId:'oc_group'};
function fixture(t){
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE submissions(id TEXT PRIMARY KEY); CREATE TABLE receipts(id TEXT PRIMARY KEY,text TEXT,status TEXT); CREATE TABLE notices(id TEXT PRIMARY KEY,text TEXT,status TEXT,created INTEGER)');migrateRecovery(db);
 let now=10000,service,calls=[];
 const g={db,now:()=>now,closed:false,ctx:{get:()=>service},retry:{sendTimeoutMs:15,maxAttempts:3},backoff:()=>50};
 const sender=new ImDelivery(g,pins);t.after(()=>db.close());
 const success=async(...args)=>{calls.push(args);return {sent:true,receipt:{version:1,messageId:'om_result',conversationId:'oc_group'}};};
 service={contractVersion:1,receiptVersion:1,sendChecked:success};
 return {db,g,sender,calls,setService:s=>service=s,setSend:s=>service.sendChecked=s,success,advance:()=>now+=10000,row:id=>db.prepare('SELECT * FROM receipts WHERE id=?').get(id)};
}
test('checked receipt pins destination and records real platform receipt exactly once',async t=>{
 const f=fixture(t);f.sender.enqueue('one','result');f.sender.enqueue('one','result');await f.sender.sendPending();await f.sender.sendPending();
 assert.equal(f.calls.length,1);assert.equal(f.row('one').status,'sent');assert.equal(f.row('one').message_id,'om_result');
 const [bot,target,text,options]=f.calls[0];assert.equal(bot,pins.botId);assert.equal(target,pins.targetId);assert.equal(text,'result');assert.equal(options.expectedFingerprint,pins.expectedFingerprint);assert.equal(options.expectedTargetDigest,pins.expectedTargetDigest);assert.equal(options.receipt,true);
});
test('missing optional service leaves durable queue, no third-party import or model required',async t=>{
 const f=fixture(t);f.sender.enqueue('one','result');f.setService(undefined);await f.sender.sendPending();
 assert.equal(f.row('one').status,'queued');assert.equal(f.row('one').attempts,0);assert.equal(f.sender.snapshot().lastError,'IM_CONTRACT_UNAVAILABLE');
});
test('lost send result and late success never trigger blind retry',async t=>{
 const f=fixture(t);f.sender.enqueue('one','result');let resolve;f.setSend(()=>new Promise(r=>resolve=r));
 await f.sender.sendPending();assert.equal(f.row('one').status,'needs_review');
 resolve({sent:true,receipt:{version:1,messageId:'om_late',conversationId:'oc_group'}});await new Promise(r=>setImmediate(r));f.advance();await f.sender.sendPending();assert.equal(f.row('one').message_id,null);
});
test('known presend account-unverified retries with bound then stops for review',async t=>{
 const f=fixture(t);f.sender.enqueue('one','result');f.setSend(async()=>{throw Object.assign(Error('private provider detail'),{code:'account-unverified'});});
 for(let i=0;i<3;i++){await f.sender.sendPending();f.advance();}
 assert.equal(f.row('one').status,'needs_review');assert.equal(f.row('one').attempts,3);assert.equal(f.row('one').last_error,'account-unverified');
});
test('changed account or route is refused, not silently rebound',async t=>{
 const f=fixture(t);f.sender.enqueue('one','result');f.setSend(async()=>{throw Object.assign(Error(),{code:'account-changed'});});await f.sender.sendPending();assert.equal(f.row('one').status,'needs_review');
 f.sender.enqueue('two','result');const replacement=new ImDelivery(f.g,{...pins,targetId:'new'});await replacement.sendPending();assert.equal(f.row('two').last_error,'IM_ROUTE_REVIEW_REQUIRED');
});
test('old queued rows and uncertain crash lease are quarantined; done history preserved',async t=>{
 const f=fixture(t);outboxInsert(f.db,'receipts','old','old',0);f.sender.enqueue('old','old');f.sender.enqueue('crash','result');
 f.db.prepare("UPDATE receipts SET status='sending',lease_until=1 WHERE id='crash'").run();
 outboxInsert(f.db,'receipts','done','old',0);f.db.prepare("UPDATE receipts SET status='sent',message_id='om_old' WHERE id='done'").run();
 await f.sender.sendPending();assert.equal(f.row('old').last_error,'IM_ROUTE_REVIEW_REQUIRED');assert.equal(f.row('crash').last_error,'SEND_RESULT_UNKNOWN');assert.equal(f.row('done').message_id,'om_old');assert.equal(f.calls.length,0);
});
test('wrong conversation, malformed receipt, provider failure are unknown outcomes',async t=>{
 for(const outcome of [{sent:true},{sent:true,receipt:{version:1,messageId:'om_x',conversationId:'elsewhere'}},Error('secret detail')]){
  const f=fixture(t);f.sender.enqueue('one','result');f.setSend(async()=>{if(outcome instanceof Error)throw outcome;return outcome;});await f.sender.sendPending();assert.equal(f.row('one').last_error,'SEND_RESULT_UNKNOWN');assert.equal(f.row('one').status,'needs_review');
 }
});
test('native rules additive and scoped: no preset selection or global instructions rewrite',()=>{
 let context,dependencies;const allowed={id:'s',preset:'standard'};
 installNativeContext({taskGateway:{c:{role:'local'},assertNativeAgent:a=>{if(a!==allowed)throw Error();}},inject:(deps,fn)=>{dependencies=deps;fn({systemPrompt:{context:c=>context=c}});}});
 assert.deepEqual(dependencies,['systemPrompt']);assert.equal(context.name,'dsh-task-gateway-native-rules');assert(context.text({agent:allowed}).includes('DSH 原生会话中的双端协作'));assert.equal(context.text({agent:{id:'s'}}),'');assert.equal(context.text({}),'');
});
