import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Gateway} from '../bundle/index.js';
import {makeEnvelope} from '../bundle/task-envelope.js';
import {hash} from '../bundle/store.js';
test('Historical R3 contract stays readable but cannot revive retired local execution',async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'r3-rpc-'))),ctx={on(){},effect(){},agents:{list:()=>[]},llm:{resolveCallConfig:async p=>p}},policy={provider:'fixture',model:'fixture'};
 const config={namespace:'r3-wire',entryMode:'native',continuity:{enabled:true},managedExecution:{enabled:true},peerEnabled:false},secrets={localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)};
 const port=Number(process.env.R3_RPC_PORT??31564),cloud=new Gateway(ctx,{...config,role:'cloud',port,stateDir:join(root,'cloud')},{secrets});
 await cloud.start();const local=new Gateway(ctx,{...config,role:'local',stateDir:join(root,'local'),coordinatorUrl:'http://127.0.0.1:'+port},{secrets});
 t.after(async()=>{await local.close();await cloud.close();rmSync(root,{recursive:true,force:true});});
 const message={id:'wire-message',role:'user',source:{kind:'user'},content:[{type:'text',text:'创建受管本地资料任务，不推送'}]},e=makeEnvelope({id:'local-or-IM-session',session:{deriveMessages:()=>[message]}},'local',{target:'cloud',intent:'register',title:'wire',goal:'wire',continuity:1});
 const receipt=await local.submit({goal:e.goal,task_key:e.task_key,source:'native-local',ingress_id:e.ingress_id}),task=receipt.task_id;
 const cwd=join(root,'local-copy');mkdirSync(cwd);const p=await local.call('execution_prepare',{task_id:task,expected_revision:1,role:'local',cwd,scope:'本任务副本',model_policy:policy,event_id:'r3-wire-plan'});
 const decision={request_id:p.id,expected_revision:1,proposal_hash:p.proposal_hash,expected_decision_id:null,action:'approve',source:{role:'local',session_id:'another-session',message_id:'approve',text:'同意',sha256:hash('同意')}};
 assert.equal((await local.continuityOutbox.submit('task_decide',decision)).state,'approved');await local.call('execution_enqueue',{task_id:task,approval_id:p.id});
 assert.equal((await cloud.call('execution_claim',{instance_id:'cloud-worker'})).item,null);
 assert.equal((await local.call('execution_claim',{instance_id:'local-worker'})).item,null);
 assert.equal((await local.call('execution_status',{task_id:task})).role,'local');
 assert.equal(cloud.execution.slots.snapshot().local_limit,0);
 assert.equal(cloud.store.db.prepare('SELECT count(*) n FROM approval_credentials').get().n,0);

});
