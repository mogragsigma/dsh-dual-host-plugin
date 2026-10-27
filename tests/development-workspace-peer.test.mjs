import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setup,plan,fakeCommands} from './workspace-fixture.mjs';
import {proposal} from './approval-fixture.mjs';
import {DevelopmentBridge} from '../bundle/development-bridge.js';
import {DevelopmentPeer} from '../bundle/development-peer.js';
import {CAPABILITIES,requireCapability} from '../bundle/link-contract.js';
const binding=c=>({id:c.id,epoch:c.epoch,ticket:c.ticket,endpoint_id:c.endpoint_id});
async function fixture(t,{commands=fakeCommands,enabled=true,executors=['cloud','local'],approved=true}={}){
 const spec=plan();spec.executors=executors;const f=await setup(t,{selectedSpec:spec,commands,approved});
 f.bridge=new DevelopmentBridge({g:{repositories:f.repos},gate:f.gate,workspaceEnabled:enabled});
 f.call=(op,a,node='local')=>f.bridge.call('workspace_bridge_'+op,a,node);
 f.args=event_id=>({event_id,task_id:f.task.id,approval_id:f.req.id,policy:proposal.model_policy});
 const g=f.client={c:{role:'local'},db:f.gate.db,now:f.ledger.now,call:(m,a)=>f.bridge.call(m,a,'local')};
 f.open=async()=>{const p=new DevelopmentPeer(g,{lockPort:0},{allowEphemeralLock:true});await p.start();t.after(()=>p.close());return p;};
 f.peer=await f.open();f.start=async(name='peer')=>{f.peer.submit({...f.args(name),contract:'workspace-v1'});await f.peer.tick();return f.peer.acquire(name);};return f;
}
test('workspace peer requires new method family, explicit activation and approved executor',async t=>{
 const f=await fixture(t);await assert.rejects(f.bridge.call('development_bridge_enqueue',f.args('old'),'local'),/CONTRACT_METHOD_MISMATCH/);
 const disabled=await fixture(t,{enabled:false});await assert.rejects(disabled.call('enqueue',disabled.args('off')),/WORKSPACE_DISABLED/);
 const excluded=await fixture(t,{executors:['cloud']});await assert.rejects(excluded.call('enqueue',excluded.args('local')),/EXECUTOR_REQUIRED/);
 const unapproved=await fixture(t,{approved:false});await assert.rejects(unapproved.call('enqueue',unapproved.args('not-approved')),/APPROVAL_REQUIRED/);
});
test('new peer protocol refuses old capability without degrading to legacy writes',()=>{
 const base={schema:1,protocol:{min:1,max:1},namespace:'fixture',instance_id:randomUUID(),plugin_version:'0.22.0-alpha.3',capabilities:{...CAPABILITIES}};
 const own={...base,role:'local'},other={...base,role:'cloud',capabilities:{...CAPABILITIES}};delete other.capabilities.development_workspace_bridge;
 assert.throws(()=>requireCapability('workspace_bridge_enqueue',own,other),/CAPABILITY_UNAVAILABLE/);assert.doesNotThrow(()=>requireCapability('catalog',own,other));
});
test('persistent workspace queue stays pending offline; reconnect has exactly one cloud request',async t=>{
 const f=await fixture(t),p=f.peer,call=f.client.call;f.client.call=async()=>{throw Error('COORDINATOR_UNAVAILABLE');};
 p.submit({...f.args('offline'),contract:'workspace-v1'});await p.tick();assert.equal(p.view('offline').state,'pending');assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_requests').get().n,0);
 await p.close();f.client.call=call;const resumed=await f.open();await resumed.tick();await resumed.tick();assert.equal(resumed.view('offline').state,'cloud_queued');assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_requests').get().n,1);
});
test('cloud busy queues local, then multi-file writes and exact commands share FIFO and budgets',async t=>{
 const f=await fixture(t),q=await f.call('enqueue',f.args('cloud'),'cloud'),c=await f.call('claim_acquire',{id:q.id,endpoint_id:randomUUID(),recovery_key:randomUUID()},'cloud'),b=binding(c);
 assert.equal((await f.start()).acquired,false);assert.equal(f.peer.view('peer').state,'cloud_queued');
 let r=await f.call('read',b,'cloud');assert(!JSON.stringify(r).includes('README.md'));await assert.rejects(f.call('read',{...b,path:'README.md'},'cloud'),/READ_DENIED/);
 await f.call('write',{...b,path:'docs/report.md',content:'first',expected_hash:r.hash,call_id:'cloud-write'},'cloud');
 for(const command_id of ['build','test'])await f.call('command',{...b,command_id,expected_hash:f.gate.view(q.id).expected_hash,call_id:'cloud-'+command_id},'cloud');
 await f.call('finish',b,'cloud');const a=await f.peer.acquire('peer');assert(a.acquired&&a.epoch>c.epoch);
 r=await f.peer.read('peer','docs/report.md');assert.equal(r.content,'first');
 r=await f.peer.operation('peer','write',{path:'docs/report.md',content:'second',expected_hash:r.hash,call_id:'local-write'});
 await f.peer.operation('peer','write',{path:'src/remove.txt',content:null,expected_hash:r.sha256,call_id:'delete'});
 for(const command_id of ['build','test'])await f.peer.operation('peer','command',{command_id,call_id:'local-'+command_id});
 assert.equal((await f.peer.finish('peer')).state,'completed');assert.equal(f.store.task(f.task.id).busy,0);
 assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_writes').get().n,3);assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_commands').get().n,4);
 await assert.rejects(f.call('write',{...b,path:'docs/report.md',content:'stale',expected_hash:r.sha256,call_id:'stale'},'cloud'),/STALE_FENCE/);
});
test('workspace peer rejects old tests, caller argv, outside paths and role/epoch spoofing',async t=>{
 const f=await fixture(t);await f.start();const p=f.peer,c=p.claim('peer');
 await assert.rejects(p.operation('peer','test',{call_id:'old'}),/BRIDGE_INVALID/);
 await assert.rejects(p.operation('peer','command',{call_id:'extra',command_id:'build',argv:['bad']}),/BRIDGE_INVALID/);
 await assert.rejects(f.bridge.call('development_bridge_read',c,'local'),/CONTRACT_METHOD_MISMATCH/);
 await assert.rejects(f.call('command',{...c,call_id:'bad',command_id:'unknown',expected_hash:f.gate.view(c.id).expected_hash}),/COMMAND_DENIED/);
 await assert.rejects(f.call('read',c,'cloud'),/STALE_FENCE/);
 await assert.rejects(f.call('read',{...c,epoch:c.epoch+1}),/STALE_FENCE/);
});
test('lost completed command acknowledgement reconciles exact receipt after peer/cloud restart without rerun',async t=>{
 const f=await fixture(t);await f.start();const p=f.peer;let r=await p.read('peer');await p.operation('peer','write',{path:'docs/report.md',content:'ready',expected_hash:r.hash,call_id:'write'});
 const original=f.client.call;let executions=0;f.client.call=async(m,a)=>{const result=await original(m,a);if(m==='workspace_bridge_command'){executions++;throw Error('COORDINATOR_UNAVAILABLE');}return result;};
 await assert.rejects(p.operation('peer','command',{command_id:'build',call_id:'lost'}),/COORDINATOR_UNAVAILABLE/);assert.equal(executions,1);
 f.gate.recover();await p.close();f.client.call=original;const resumed=await f.open();const proof=await resumed.reconcile('peer');assert.equal(proof.unresolved_calls,0);assert.equal(proof.cloud_state,'needs_review');
 assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_commands').get().n,1);
 const restored=await resumed.resumeReviewed('peer',{event_id:'review',proof_hash:proof.proof_hash,note:'Synthetic unit operator checks exact closed receipt; do not repeat command.'});assert(restored.grants_execution);assert.equal(restored.budget_reset,false);
 await resumed.operation('peer','command',{command_id:'test',call_id:'finish-test'});assert.equal((await resumed.finish('peer')).state,'completed');assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_commands').get().n,2);
});
test('wrong path fingerprint cannot adopt an acknowledgement for a different file',async t=>{
 const f=await fixture(t);await f.start();const p=f.peer,r=await p.read('peer'),original=f.client.call;
 f.client.call=async(m,a)=>{const result=await original(m,a);if(m==='workspace_bridge_write')throw Error('COORDINATOR_UNAVAILABLE');return result;};
 await assert.rejects(p.operation('peer','write',{path:'docs/report.md',content:'ready',expected_hash:r.hash,call_id:'lost'}));f.client.call=original;
 f.gate.db.prepare("UPDATE development_peer_calls SET wire_fingerprint=? WHERE local_id='peer'").run('0'.repeat(64));
 const proof=await p.reconcile('peer');assert.equal(proof.unresolved_calls,1);await assert.rejects(p.resumeReviewed('peer',{event_id:'review',proof_hash:proof.proof_hash,note:'cannot trust mismatching receipt'}),/REVIEW_NOT_AVAILABLE/);
});
test('unknown container is neither a completed command receipt nor permission to resume',async t=>{
 const f=await fixture(t,{commands:{async run(_w,_h,_id,o){o.onCreated({id:'unknown',name:'fixture'});throw Object.assign(Error('DEVELOPMENT_CONTAINER_DRAIN_UNKNOWN'),{drained:false});}}});
 await f.start();await assert.rejects(f.peer.operation('peer','command',{command_id:'build',call_id:'unknown'}),/DRAIN_UNKNOWN/);
 const proof=await f.peer.reconcile('peer');assert.equal(proof.unresolved_calls,1);const r=f.gate.row(f.peer.view('peer').request_id);assert(f.gate.unresolved(r.id));assert.equal(f.store.task(f.task.id).busy,1);
 await assert.rejects(f.peer.resumeReviewed('peer',{event_id:'not-proof',proof_hash:proof.proof_hash,note:'cannot infer container exit'}),/REVIEW_NOT_AVAILABLE/);
});
test('lost write acknowledgement uses whole manifest and original call path; no second write',async t=>{
 const f=await fixture(t);await f.start();const p=f.peer,r=await p.read('peer'),original=f.client.call;
 f.client.call=async(m,a)=>{const result=await original(m,a);if(m==='workspace_bridge_write')throw Error('COORDINATOR_UNAVAILABLE');return result;};
 await assert.rejects(p.operation('peer','write',{path:'docs/report.md',content:'once',expected_hash:r.hash,call_id:'once'}));f.client.call=original;f.gate.recover();
 const proof=await p.reconcile('peer');assert.equal(proof.unresolved_calls,0);assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_writes').get().n,1);
});

import {writeFileSync,rmSync} from 'node:fs';
import {Gateway} from '../bundle/index.js';
test('actual HTTP negotiates workspace bridge, preserves node and waits beyond ordinary eight-second RPC timeout',async t=>{
 let slow=true;const commands={async run(...args){if(slow){slow=false;await new Promise(r=>setTimeout(r,8500));}return fakeCommands.run(...args);}};
 const f=await fixture(t,{commands}),tokens=f.root+'-tokens.json';writeFileSync(tokens,JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});t.after(()=>rmSync(tokens,{force:true}));
 const ctx={on(){},effect(){},get(){return null;},agents:{list:()=>[]}},base={namespace:'s41-workspace-http',entryMode:'native',port:0,tokenFile:tokens};
 const cloud=new Gateway(ctx,{...base,role:'cloud',stateDir:f.dir+'/http-cloud'});await cloud.start();const local=new Gateway(ctx,{...base,role:'local',stateDir:f.dir+'/http-local',coordinatorUrl:'http://127.0.0.1:'+cloud.server.address().port});
 t.after(async()=>{await local.close();await cloud.close();});
 await assert.rejects(local.call('workspace_bridge_enqueue',f.args('disabled')),/CAPABILITY_UNAVAILABLE/);assert(!cloud.hello().capabilities.development_workspace_bridge);
 cloud.development={bridge:f.bridge,workspaceEnabled:true};
 const q=await local.call('workspace_bridge_enqueue',f.args('http'));assert.equal(q.node,'local');
 await assert.rejects(local.call('workspace_bridge_enqueue',{...f.args('spoof'),node:'cloud'}),/BRIDGE_INVALID/);
 const c=await local.call('workspace_bridge_claim_acquire',{id:q.id,endpoint_id:randomUUID(),recovery_key:randomUUID()}),b=binding(c);
 let r=await local.call('workspace_bridge_read',b);await local.call('workspace_bridge_write',{...b,path:'docs/report.md',content:'HTTP only fixture',expected_hash:r.hash,call_id:'write'});
 r=await local.call('workspace_bridge_read',b);for(const command_id of ['build','test'])await local.call('workspace_bridge_command',{...b,command_id,expected_hash:r.hash,call_id:command_id});
 assert.equal((await local.call('workspace_bridge_finish',b)).state,'completed');
 await assert.rejects(local.call('development_bridge_status',{id:q.id}),/CONTRACT_METHOD_MISMATCH/);
 const raw=await fetch(local.c.coordinatorUrl+'/rpc',{method:'POST',headers:{Authorization:'Bearer '+'l'.repeat(32),'Content-Type':'application/json'},body:JSON.stringify({method:'workspace_bridge_status',args:{id:q.id}})});assert.equal((await raw.json()).error,'PROTOCOL_NEGOTIATION_REQUIRED');
});
