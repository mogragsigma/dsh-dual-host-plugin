import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Gateway} from '../bundle/index.js';
import {CAPABILITIES,DirectLink,negotiate,requireCapability,errorInfo} from '../bundle/link-contract.js';
import {receiptClassification} from '../bundle/diagnostics.js';
import {PeerMailbox} from '../bundle/peer-mailbox.js';
import {migrateRecovery} from '../bundle/recovery.js';
const hello=(role,extra={})=>({schema:1,protocol:{min:1,max:1},plugin_version:'0.11.0',role,namespace:'s28-test',instance_id:randomUUID(),capabilities:{...CAPABILITIES},...extra});

test('protocol selection is independent of plugin semver; capability versions are exact',()=>{
 const a=hello('local'),b=hello('cloud',{plugin_version:'99.2.3'});
 assert.equal(negotiate(a,b).version,1);assert.equal(negotiate(a,b).capabilities.peer,1);
 b.capabilities.peer=2;assert(!negotiate(a,b).capabilities.peer);
 assert.throws(()=>requireCapability('peer_send',a,b),/CAPABILITY_VERSION_INCOMPATIBLE/);
 delete b.capabilities.peer;assert.throws(()=>requireCapability('peer_send',a,b),/CAPABILITY_UNAVAILABLE/);
});
for(const [name,patch,code] of [
 ['major',{protocol:{min:2,max:2}},'PROTOCOL_VERSION_INCOMPATIBLE'],
 ['namespace',{namespace:'elsewhere'},'PROTOCOL_NAMESPACE_MISMATCH'],
 ['role',{role:'local'},'PROTOCOL_ROLE_MISMATCH'],
 ['schema',{schema:2},'PROTOCOL_DESCRIPTOR_INVALID'],
 ['capability type',{capabilities:{peer:'1'}},'PROTOCOL_DESCRIPTOR_INVALID'],
 ['range',{protocol:{min:2,max:1}},'PROTOCOL_DESCRIPTOR_INVALID'],
 ['instance',{instance_id:'fabricated'},'PROTOCOL_DESCRIPTOR_INVALID'],
])test('negotiation refuses '+name,()=>assert.throws(()=>negotiate(hello('local'),hello('cloud',patch)),new RegExp(code)));

function linkFixture(){
 let mono=0,wall=100000,offline=false,legacy=false,peer=hello('cloud'),businessCalls=0,badResponse=false;
 const own=hello('local');const link=new DirectLink(()=>own,async(method,args,contract)=>{
  if(offline)throw Error('COORDINATOR_UNAVAILABLE');
  if(method==='negotiate'){if(legacy)throw Error('METHOD_DENIED');return {hello:peer};}
  businessCalls++;assert.equal(contract.peer_instance,peer.instance_id);
  if(badResponse)return {result:{},observation:{instance_id:'wrong'}};
  return {result:{development_enabled:false},observation:{authority:'cloud',instance_id:peer.instance_id,generated_at:wall+600000}};
 },{now:()=>wall,monotonic:()=>mono});
 return {link,peer,advance(ms){mono+=ms;wall+=ms;},clock(ms){wall+=ms;},offline(){offline=true;},online(){offline=false;},legacy(){legacy=true;},bad(){badResponse=true;},restart(){peer=hello('cloud');return peer.instance_id;},get calls(){return businessCalls;}};
}
test('freshness uses local monotonic age even if wall clock goes backward or remote is ahead',async()=>{
 const f=linkFixture();assert.equal(f.link.snapshot().state,'unknown');
 const r=await f.link.call('diagnostics',{});assert.equal(r.observation.freshness,'live_response');assert.equal(r.observation.usable_for_authorization,false);
 f.clock(-999999);f.advance(31000);assert.equal(f.link.snapshot().state,'stale');assert.equal(f.link.cached().observation.freshness,'stale');assert.equal(f.link.cached().observation.age_ms,31000);
});
test('failed refresh exposes stale diagnostic snapshot, never cached business success',async()=>{
 const f=linkFixture();await f.link.call('diagnostics',{});f.offline();
 await assert.rejects(f.link.call('status',{}),/COORDINATOR_UNAVAILABLE/);
 assert.equal(f.link.snapshot().state,'unavailable');assert.equal(f.link.cached().observation.freshness,'stale');assert.equal(f.calls,1);
});
test('restart negotiates a new instance before operations; client restart has unknown freshness',async()=>{
 const f=linkFixture();await f.link.call('diagnostics',{});const previous=f.link.snapshot().peer.instance_id;
 const next=f.restart();await f.link.call('status',{});assert.notEqual(next,previous);assert.equal(f.link.snapshot().peer.instance_id,next);assert.equal(linkFixture().link.snapshot().state,'unknown');
});
test('old peers do not receive business requests after handshake refusal',async()=>{
 const f=linkFixture();f.legacy();await assert.rejects(f.link.call('accept',{}),/PROTOCOL_PEER_LEGACY/);assert.equal(f.calls,0);assert.equal(f.link.snapshot().state,'incompatible');
});
test('forged or missing response observation is refused rather than treated as success',async()=>{
 const f=linkFixture();f.bad();await assert.rejects(f.link.call('status',{}),/PROTOCOL_DESCRIPTOR_INVALID/);
});
test('missing or mismatched capabilities block before transport dispatch',async()=>{
 const f=linkFixture();delete f.peer.capabilities.scheduler;
 await assert.rejects(f.link.call('schedule',{}),/CAPABILITY_UNAVAILABLE/);assert.equal(f.calls,0);
 f.peer.capabilities.scheduler=2;await assert.rejects(f.link.call('schedule',{}),/CAPABILITY_VERSION_INCOMPATIBLE/);assert.equal(f.calls,0);
});
test('business rejection is not reported as network disconnection',async()=>{
 const l=hello('local'),r=hello('cloud');const link=new DirectLink(()=>l,async(m)=>{if(m==='negotiate')return {hello:r};throw Error('TASK_NOT_FOUND');});
 await assert.rejects(link.call('status',{}),/TASK_NOT_FOUND/);assert.equal(link.snapshot().state,'operation_rejected');
});

async function fixture(t){
 const dir=mkdtempSync(tmpdir()+'/s28-link-'),tokenFile=dir+'/tokens';writeFileSync(tokenFile,JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});
 const ctx={on(){},effect(){},agents:{list:()=>[]},agentPresets:{composedPreset:()=> 'standard'}};let now=100000,mono=0;
 const base={namespace:'s28-test',port:0,tokenFile,entryMode:'native'};
 const cloud=new Gateway(ctx,{...base,role:'cloud',stateDir:dir+'/cloud'},{now:()=>now,monotonic:()=>mono});await cloud.start();
 const local=new Gateway(ctx,{...base,role:'local',stateDir:dir+'/local',coordinatorUrl:'http://127.0.0.1:'+cloud.server.address().port},{now:()=>now,monotonic:()=>mono});
 t.after(async()=>{await local.close();await cloud.close();rmSync(dir,{recursive:true,force:true});});
 const rpc=async(method,args={},contract,token='l'.repeat(32))=>{const r=await fetch(local.c.coordinatorUrl+'/rpc',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({method,args,...(contract?{contract}:{})})});return {status:r.status,data:await r.json()};};
 return {local,cloud,rpc,advance(){now+=600000;mono+=600000;},input:{goal:'s28 not execution',task_key:'s28',source:'native-local',ingress_id:'s28-1'}};
}
test('authenticated peer still requires negotiation and exact server instance before mutation',async t=>{
 const f=await fixture(t);
 const missing=await f.rpc('accept',f.input);assert.equal(missing.data.error,'PROTOCOL_NEGOTIATION_REQUIRED');
 const wrong=await f.rpc('accept',f.input,{hello:f.local.hello(),peer_instance:randomUUID()});assert.equal(wrong.data.error,'PROTOCOL_INSTANCE_CHANGED');
 const role=await f.rpc('accept',f.input,{hello:f.cloud.hello(),peer_instance:f.cloud.instanceId});assert.equal(role.data.error,'PROTOCOL_ROLE_MISMATCH');
 assert.equal(f.cloud.store.snapshot().tasks.length,0);
 const accepted=await f.local.submit(f.input);assert.equal(accepted.status,'accepted');assert.equal(f.cloud.store.snapshot().tasks.length,1);
});
test('incompatible peers keep durable intake without exhausting attempts, then recover idempotently',async t=>{
 const f=await fixture(t),original=f.cloud.hello.bind(f.cloud);f.cloud.hello=()=>({...original(),protocol:{min:2,max:2}});
 const r=await f.local.submit(f.input);assert.equal(r.status,'queued_locally');
 for(let i=0;i<20;i++){f.advance();await f.local.deliver(f.input.ingress_id);}
 let row=f.local.db.prepare('SELECT * FROM submissions').get();assert.equal(row.status,'queued');assert.equal(row.attempts,0);assert.equal(row.last_error,'PROTOCOL_VERSION_INCOMPATIBLE');assert.equal(f.cloud.store.snapshot().tasks.length,0);
 f.cloud.hello=original;f.advance();await f.local.deliver(f.input.ingress_id);row=f.local.db.prepare('SELECT * FROM submissions').get();assert.equal(row.status,'accepted');assert.equal(row.attempts,1);assert.equal(f.cloud.store.snapshot().tasks.length,1);
});
test('peer queue also survives capability rejection without exhausting attempts',async t=>{
 const f=await fixture(t);const task=await f.local.submit(f.input);const original=f.cloud.hello.bind(f.cloud);
 f.cloud.hello=()=>({...original(),capabilities:{...original().capabilities,peer:2}});
 f.local.peer.enqueue({id:'held',task_id:task.task_id,kind:'context',text:'PRIVATE_CONTEXT_NOT_IN_DIAGNOSTICS'});
 for(let i=0;i<20;i++){f.advance();await f.local.tick();}
 const row=f.local.db.prepare("SELECT * FROM peer_outbox WHERE id='held'").get();assert.equal(row.attempts,0);assert.equal(row.status,'queued');assert.equal(row.last_error,'CAPABILITY_VERSION_INCOMPATIBLE');
 const d=await f.local.diagnostics(false);assert(!JSON.stringify(d).includes('PRIVATE_CONTEXT_NOT_IN_DIAGNOSTICS'));assert(d.queues.peer_outbox.errors.some(x=>x.category==='compatibility'));
 f.cloud.hello=original;f.advance();await f.local.tick();await f.cloud.tick();assert.equal(f.cloud.peer.read(task.task_id).messages.filter(x=>x.id==='held').length,1);
});
test('diagnostics are read-only, bounded, secret-free and cannot release a busy task',async t=>{
 const f=await fixture(t);const task=await f.local.submit(f.input);f.cloud.store.begin('cloud',{task_id:task.task_id,epoch:1});
 const before=f.cloud.store.status(task.task_id);const d=await f.local.diagnostics();
 assert.equal(d.cloud_cached,false);assert.equal(d.cloud.observation.freshness,'live_response');assert.equal(d.connection.state,'verified');
 assert.equal(d.development_enabled,false);assert.equal(d.automatic_repair,false);assert.equal(d.remote_idle,'unknown');
 assert.deepEqual(f.cloud.store.status(task.task_id),before);assert.equal(f.cloud.store.snapshot().intents.length,0);
 const text=JSON.stringify(d);assert(!text.includes('l'.repeat(32)));assert(!text.includes(f.local.c.tokenFile));assert(!text.includes(f.input.goal));
});
test('offline diagnostic cache is explicit; task query never returns stale cached data',async t=>{
 const f=await fixture(t),task=await f.local.submit(f.input);await f.local.diagnostics();f.local.c.coordinatorUrl='http://127.0.0.1:1';
 const d=await f.local.diagnostics();assert.equal(d.cloud_cached,true);assert.equal(d.cloud.observation.freshness,'stale');assert.equal(d.connection.state,'unavailable');
 await assert.rejects(f.local.observedCall('status',{task_id:task.task_id}),/COORDINATOR_UNAVAILABLE/);
});
test('native-read observation is additive; internal RPC business data remains unmodified',async t=>{
 const f=await fixture(t),task=await f.local.submit(f.input);
 const internal=await f.local.call('status',{task_id:task.task_id});assert.equal(internal.observation,undefined);
 const read=await f.local.observedCall('status',{task_id:task.task_id});assert.equal(read.observation.authority,'cloud');assert.equal(read.observation.usable_for_authorization,false);assert.equal(read.id,task.task_id);
});
test('diagnostics show local data even when peer has an incompatible protocol',async t=>{
 const f=await fixture(t),original=f.cloud.hello.bind(f.cloud);f.cloud.hello=()=>({...original(),protocol:{min:2,max:2}});
 const d=await f.local.diagnostics();assert.equal(d.connection.state,'incompatible');assert.equal(d.cloud,null);assert.equal(d.cloud_status_available,false);assert.equal(d.queues.submissions.pending,0);
});
test('malformed and unauthenticated handshakes cannot leak runtime state',async t=>{
 const f=await fixture(t);assert.equal((await f.rpc('negotiate',{hello:f.local.hello()},null,'wrong')).data.error,'AUTH_DENIED');
 assert.equal((await f.rpc('negotiate',{hello:{}})).data.error,'PROTOCOL_DESCRIPTOR_INVALID');
});
test('runtime response body is size bounded before processing diagnostics',async t=>{
 const f=await fixture(t);f.local.io.fetch=async()=>new Response('x'.repeat(2097153));await assert.rejects(f.local.remoteTransport('negotiate',{}),/PROTOCOL_RESPONSE_TOO_LARGE/);
});
test('new queue timestamps do not invent historical age or change historical rows',()=>{
 const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE submissions(id TEXT PRIMARY KEY,fingerprint TEXT,payload TEXT,status TEXT,task_id TEXT,attempts INTEGER DEFAULT 0);CREATE TABLE notices(id TEXT PRIMARY KEY,text TEXT,status TEXT,created INTEGER);CREATE TABLE receipts(id TEXT PRIMARY KEY,text TEXT,status TEXT);INSERT INTO submissions VALUES ('old','fp','{}','queued',NULL,2);");
 migrateRecovery(db);assert.equal(db.prepare('SELECT created_at FROM submissions').get().created_at,null);assert.equal(db.prepare('SELECT attempts FROM submissions').get().attempts,2);
 new PeerMailbox(db,{role:'local',namespace:'old'});assert(db.prepare('PRAGMA table_info(peer_outbox)').all().some(x=>x.name==='created_at'));db.close();
});
test('receipt taxonomy cannot conflate proposal sent, approval, execution or human read',()=>{
 for(const [name,state,kind] of [['task_submit',{status:'queued_locally'},'intake_local'],['task_submit',{status:'accepted'},'intake_cloud'],['task_peer_send',{status:'peer_saved'},'peer_transport'],['task_schedule',{status:'queued'},'schedule'],['task_approval_request',{state:'pending',chat_confirmation:{state:'sent'}},'proposal_delivery'],['task_approval_status',{items:[{state:'approved'}]},'approval_ledger'],['task_repository_gate',{executable:false},'repository_preflight']]){
  const r=receiptClassification(name,state);assert.equal(r.receipt_classification.kind,kind);assert.equal(r.receipt_classification.grants_execution,false);assert.equal(r.receipt_classification.proves_user_read,false);
 }
});
test('diagnostic error classification never exposes raw exceptions or credentials',()=>{
 assert.equal(errorInfo(Error('https://private.test/?token=SECRET')).code,'TRANSIENT_FAILURE');assert.equal(errorInfo('AUTH_DENIED').category,'authentication');assert.equal(errorInfo('SEND_RESULT_UNKNOWN').category,'uncertain_delivery');assert.equal(errorInfo('PROTOCOL_NAMESPACE_MISMATCH').retry,'after_compatible_peer');
});
test('known public IM refusal codes keep operator-review semantics',()=>{
 for(const code of ['account-changed','target-changed','unknown-target','unknown-bot','bad-request'])assert.equal(errorInfo(code).category,'validation_or_review');
 for(const code of ['account-unverified','capability-unavailable'])assert.equal(errorInfo(code).category,'transient');
 assert.equal(errorInfo('PROTOCOL_RESPONSE_TOO_LARGE').category,'validation_or_review');
});
test('cloud sees authenticated Mac version and last observation, not inferred idleness',async t=>{
 const f=await fixture(t);assert.equal(f.cloud.inboundSnapshot().state,'unknown');
 await f.local.diagnostics();let view=await f.cloud.diagnostics();assert.equal(view.connection.state,'verified');assert.equal(view.connection.peer.role,'local');assert.equal(view.connection.peer.instance_id,f.local.instanceId);assert.equal(view.remote_idle,'unknown');
 f.advance();view=await f.cloud.diagnostics();assert.equal(view.connection.state,'stale');assert.equal(view.connection.usable_for_authorization,false);
});
test('unauthenticated noise cannot overwrite cloud last-known peer health',async t=>{
 const f=await fixture(t);await f.local.diagnostics();const before=f.cloud.inboundSnapshot();
 await f.rpc('negotiate',{hello:hello('local')},null,'wrong');assert.deepEqual(f.cloud.inboundSnapshot(),before);
});
test('cloud records authenticated version incompatibility without claiming peer execution',async t=>{
 const f=await fixture(t);const r=await f.rpc('negotiate',{hello:{...f.local.hello(),protocol:{min:2,max:2}}});
 assert.equal(r.data.error,'PROTOCOL_VERSION_INCOMPATIBLE');assert.equal(f.cloud.inboundSnapshot().state,'incompatible');assert.equal(f.cloud.inboundSnapshot().remote_idle,'unknown');assert.equal(f.cloud.store.snapshot().tasks.length,0);
});
test('RPC method whitelist rejects prototype names and non-string keys before any mutation',async t=>{
 const f=await fixture(t);
 for(const method of ['constructor','toString','__proto__',['accept'],null]){
  await assert.rejects(f.cloud.call(method,f.input),/METHOD_DENIED/);
  assert.equal((await f.rpc(method,f.input,null,'c'.repeat(32))).data.error,'METHOD_DENIED');
  assert.equal((await f.rpc(method,f.input,{hello:f.local.hello(),peer_instance:f.cloud.instanceId})).data.error,'METHOD_DENIED');
 }
 assert.equal(f.cloud.store.snapshot().tasks.length,0);
});
test('capability lookup never treats object prototype keys as protocol methods',()=>{
 for(const method of ['constructor','toString','__proto__',['accept'],null])assert.throws(()=>requireCapability(method,hello('local'),hello('cloud')),/METHOD_DENIED/);
});
