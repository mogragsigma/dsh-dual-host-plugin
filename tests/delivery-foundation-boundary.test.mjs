import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
const bundle=new URL('../bundle/',import.meta.url),read=p=>readFileSync(new URL(p,bundle),'utf8');
test('new journal is constructed only inside the opt-in runtime',()=>{
 for(const f of readdirSync(bundle).filter(n=>n.endsWith('.js')&&!['delivery-journal.js','delivery-runtime.js'].includes(n))){
  assert.ok(!read(f).includes("from './delivery-journal.js'"),f);assert.ok(!read(f).includes('new DeliveryJournal('),f);
 }
 const c=JSON.parse(read('compatibility.json'));assert.equal(c.deliveryExecutionFoundation.publicExecution,false);assert.equal(c.deliveryRuntimeCandidate.defaultExecutionEnabled,false);assert.equal(c.deliveryExecutionFoundation.pushAdapter,false);assert.equal(c.candidateValidation.realCommitPushValidated,false);
});
test('own global rule and Skill both distinguish computed object from persisted commit and old preview approval',()=>{
 for(const p of ['global-rules/AGENTS.md','skills/task-repository/SKILL.md']){const s=read(p);for(const term of ['computed_commit_oid','commit-preview-v1','待核对'])assert.ok(s.includes(term),p+': '+term);}
 const src=read('delivery-object-plan.js');assert.ok(!/from ['"]node:(fs|child_process|http|https|net)/.test(src));
});
test('commit source has no public constructor or default activation route',()=>{
 for(const f of readdirSync(bundle).filter(n=>n.endsWith('.js')&&!['delivery-commit.js','delivery-runtime.js'].includes(n)))assert.ok(!read(f).includes('new DeliveryCommit('),f);
 assert(read('delivery-commit.js').includes('enabled=false'));assert(!read('native-tools.js').includes('delivery_commit_execute'));
});

test('new approval bridge remains private and is not a public decision or write route',()=>{
 for(const f of readdirSync(bundle).filter(n=>n.endsWith('.js')&&!['delivery-approval.js','delivery-runtime.js'].includes(n)))assert(!read(f).includes('new DeliveryApproval('),f);
 assert(read('delivery-approval.js').includes('enabled=false'));
 for(const p of ['index.js','native-tools.js','tools.js'])for(const name of ['delivery_stage_execution','delivery_commit_execute','delivery_authorize'])assert(!read(p).includes(name));
});
test('recovery is explicit private reconciliation, never startup lock deletion or a model repair tool',()=>{
 for(const f of readdirSync(bundle).filter(n=>n.endsWith('.js')&&!['delivery-recovery.js','delivery-runtime.js'].includes(n)))assert(!read(f).includes('new DeliveryRecovery('),f);
 const s=read('delivery-recovery.js');assert(s.includes('enabled=false'));assert(!s.includes('process.kill'));assert(!s.includes('execFile'));assert(!s.includes('writeFile'));
 for(const f of ['index.js','native-tools.js','tools.js'])for(const method of ['delivery_recover','delivery_force_unlock','delivery_repair'])assert(!read(f).includes(method));
});

test('Gateway opt-in and execution gates are separate; recovery stays operator-only',()=>{
 const s=read('index.js'),r=read('delivery-runtime.js');assert(s.includes("c.delivery?.enabled===true"));assert(r.includes('this.executionEnabled=c.execute===true'));assert(r.includes('this.journal.recover()'));assert(!r.includes('process.kill'));
 for(const f of ['index.js','native-tools.js'])assert(!read(f).includes("'delivery_recovery'"));
});

test('push is separately opted-in; pure plan and journal never authorize transmission themselves',()=>{
 const c=JSON.parse(read('compatibility.json')).deliveryPushCandidate;
 assert.equal(c.publicRuntimeWired,true);assert.equal(c.transportImplemented,true);assert.equal(c.trustedApprovalBridgeImplemented,true);
 assert(read('delivery-journal.js').includes('pushEnabled=false'));
 assert(!/from ['"]node:(fs|child_process|http|https|net)/.test(read('delivery-push-plan.js')));
 assert(read('delivery-runtime.js').includes('this.pushExecutionEnabled=this.pushEnabled&&c.push.execute===true'));
 for(const f of ['index.js','native-tools.js','tools.js'])assert(!read(f).includes('delivery_push_execute'));
 for(const f of ['global-rules/AGENTS.md','skills/task-repository/SKILL.md','skills/task-sidebar/SKILL.md'])assert(read(f).includes('推送'));
});

test('actual SSH adapter remains private and supervisor asset is packaged',()=>{
 for(const f of readdirSync(bundle).filter(n=>n.endsWith('.js')&&!['delivery-push.js','delivery-runtime.js'].includes(n)))assert(!read(f).includes('new DeliveryPush('),f);
 assert(read('delivery-push.js').includes('enabled=false'));assert(read('delivery-ssh.js').includes('enabled=false'));
 assert(JSON.parse(read('package.json')).files.includes('delivery-process.py'));
 const c=JSON.parse(read('compatibility.json')).deliveryPushTransportCandidate;assert.equal(c.actualGiteePushValidated,false);assert.equal(c.approvalBridgeImplemented,true);
});

test('durable push reconciliation is private and never auto-started or exposed to model tools',()=>{
 for(const f of ['index.js','native-tools.js','tools.js'])for(const name of ['pushRecovery','processReceipts','reconcile_push','close_process_receipt'])assert(!read(f).includes(name));
 const runtime=read('delivery-runtime.js');assert(runtime.includes('receipts:this.processReceipts()'));assert(runtime.includes('pushRecovery(task)'));
 assert(read('delivery-push-recovery.js').includes('enabled=false'));assert(!read('delivery-process-receipts.js').includes('process.kill'));
 assert(read('delivery-process.py').includes('os.fsync'));assert(read('delivery-process.py').includes('os.link(temporary, final'));
});
