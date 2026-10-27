import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {Gateway} from '../bundle/index.js';
test('cloud process SIGKILL after broker save preserves message across a fresh process',async t=>{
 const root=mkdtempSync(tmpdir()+'/dsh-peer-process-');writeFileSync(root+'/tokens.json',JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});
 let child,local;
 t.after(async()=>{await local?.close();if(child&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}rmSync(root,{recursive:true,force:true});});
 const open=async()=>{child=fork(new URL('./peer-process-child.mjs',import.meta.url),[root],{stdio:['ignore','ignore','ignore','ipc']});const message=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error('child exited before ready');})]);return message[0].url;};
 const ctx={on(){},effect(){},agents:{list:()=>[]},agentPresets:{composedPreset:()=>undefined}};
 local=new Gateway(ctx,{role:'local',namespace:'process-test',port:0,stateDir:root+'/local',tokenFile:root+'/tokens.json',coordinatorUrl:await open()});
 const task=await local.submit({task_key:'process',goal:'No execution',source:'native-local',ingress_id:'process-1'});
 local.peer.enqueue({id:'survive-kill',task_id:task.task_id,kind:'context',text:'durable context'});await local.tick();
 assert.equal(local.db.prepare("SELECT status FROM peer_outbox WHERE id='survive-kill'").get().status,'broker_saved');
 const exited=once(child,'exit');child.kill('SIGKILL');await exited;local.c.coordinatorUrl=await open();
 const rpc=async(method,args)=>{const r=await fetch(local.c.coordinatorUrl+'/rpc',{method:'POST',headers:{Authorization:'Bearer '+'c'.repeat(32),'Content-Type':'application/json'},body:JSON.stringify({method,args})});return r.json();};
 // The cloud token can inspect its own pending destination only. A startup tick may already save it.
 const status=await local.call('status',{task_id:task.task_id});assert.equal(status.id,task.task_id);
 const peerStatus=await local.call('peer_status',{ids:['survive-kill']});assert(['broker_saved','peer_saved'].includes(peerStatus.messages[0].status));
 const health=await fetch(local.c.coordinatorUrl+'/health',{method:'POST',headers:{Authorization:'Bearer '+'c'.repeat(32)}}).then(r=>r.json());
 if(peerStatus.messages[0].status==='peer_saved')assert(health.peer.inbox>=1);else assert((await rpc('peer_pull',{})).messages.some(m=>m.id==='survive-kill'));
});
