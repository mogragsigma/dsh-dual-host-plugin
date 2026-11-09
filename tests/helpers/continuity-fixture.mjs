import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Gateway} from '../../bundle/index.js';
import {makeEnvelope} from '../../bundle/task-envelope.js';
import {hash} from '../../bundle/store.js';
import {registerNativeTools} from '../../bundle/native-tools.js';
let serial=0;
export function fixture(t,{enabled=true,role='cloud',root,managedExecution,observation,notificationTargets,scheduler=true,sourceIntake,sourceRouting}={}){
 const dir=root??mkdtempSync(join(tmpdir(),'r2-test-')),agents=new Map(),tools=new Map(),sideEffects={agents:0,model:0};let now=100000;
 const ctx={on(){},effect(){},agents:{get:id=>agents.get(id),list:()=>[...agents.values()],create(){sideEffects.agents++;throw Error('NO_MODEL_TEST');}},agentPresets:{composedPreset:c=>c.preset},llm:{stream(){sideEffects.model++;throw Error('NO_MODEL_TEST');}}};
 const g=new Gateway(ctx,{role,entryMode:'native',namespace:'r2-test',stateDir:dir,peerEnabled:false,continuity:{enabled},...(sourceIntake?{sourceIntake}:{}),...(observation?{observation}:{}),...(notificationTargets?{notificationTargets}:{}),...(managedExecution?{managedExecution}:{}),scheduler:role==='cloud'&&scheduler?{lockPort:0,workspace:dir}:undefined},{sourceRouting,now:()=>now,secrets:{localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)},scheduler:{allowEphemeralLock:true,now:()=>now}});
 registerNativeTools({taskGateway:g,tools:{register:d=>tools.set(d.name,d)}});
 t.after(async()=>{await g.close();if(!root)rmSync(dir,{recursive:true,force:true});});
 const agent=(name='session-'+ ++serial,body='请交办一个云端任务，只整理，不推送。',message='message-'+ ++serial)=>{const a={id:name,ctx:{preset:'standard'},session:{deriveMessages:()=>[{id:message,role:'user',source:{kind:'user'},content:[{type:'text',text:body}]}]}};agents.set(name,a);return a;};
 const create=async(title='安装说明',options={})=>{const a=agent(options.session,options.text),e=makeEnvelope(a,options.role??role,{goal:title,title,target:'cloud',intent:'plan',notification_contract:1,model_policy:{provider:'fixture',model:'fixture'},...(enabled?{continuity:1}:{})}),r=await g.call('accept',{goal:e.goal,task_key:e.task_key,ingress_id:e.ingress_id,source:'native-'+(options.role??role)},options.role??role);return r.id;};
 const source=(body='补充兼容性表',r=role,msg='follow-'+ ++serial,session='follow-session')=>({role:r,session_id:session,message_id:msg,text:body,sha256:hash(body)});
 const input=(id,s=source(),more={})=>({task_ids:[id],expected_revisions:{[id]:g.catalog.head(id).spec_revision},source:s,...more});
 const control=(id,action,s=source(action),version=g.continuity.state(id).version)=>({task_id:id,action,expected_version:version,source:s});
 return {g,agent,tools,create,source,input,control,dir,sideEffects,advance:(ms=1000000)=>now+=ms};
}
