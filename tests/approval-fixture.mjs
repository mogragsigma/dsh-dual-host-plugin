import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Coordinator} from '../bundle/store.js';
import {TaskCatalog} from '../bundle/task-catalog.js';
import {ApprovalLedger} from '../bundle/approval-ledger.js';
import {ChatApproval,chatAction} from '../bundle/approval-chat.js';
import {FeishuApprovalSource,chatBinding} from '../bundle/approval-feishu.js';
import {makeEnvelope} from '../bundle/task-envelope.js';
const config={provider:'feishu',appId:'cli_test12345',botOpenId:'ou_bot12345',approverOpenId:'ou_owner12345',chatId:'oc_chat12345',appSecretEnv:'TEST_APP_SECRET'};
const proposal={summary:'隔离确认，非业务授权',changes:'不执行',validation:'只做记账',risks:'无仓库绑定',rollback:'撤销',model_policy:{provider:'chosen',model:'glm-5.3',reasoningEffort:'low'},scopes:['develop'],repository:null};
function fixture(t,{semantic=false,classify}={}){
 let now=1792300000000,seq=0;const dir=mkdtempSync(tmpdir()+'/chat-proof-'),store=new Coordinator(dir),catalog=new TaskCatalog(store),ledger=new ApprovalLedger(store,catalog,()=>now);
 const envelope=makeEnvelope({id:'native',session:{deriveMessages:()=>[{id:'m1',role:'user',source:{kind:'user'},content:[{type:'text',text:'隔离审批夹具，不授权真实任务'}]}]}},'local',{goal:'不执行',title:'聊天审批夹具',target:'cloud',intent:'register'});
 const task=store.accept('local',{goal:envelope.goal,task_key:envelope.task_key,source:'native-local',ingress_id:envelope.ingress_id});catalog.head(task.id);
 const req=(event='request')=>ledger.request('local',{task_id:task.id,expected_revision:1,event_id:event,proposal});
 const messages=new Map();let sendCount=0,verifyCount=0,getCount=0,failSend=false,failRead=false;
 const message=(id,text,fields={})=>({message_id:id,chat_id:config.chatId,chat_type:'p2p',msg_type:'text',deleted:false,updated:false,create_time:String(now),update_time:String(now),body:{content:JSON.stringify({text})},sender:{sender_type:'user',id_type:'open_id',id:config.approverOpenId},...fields});
 const source={verifyBot:async()=>{verifyCount++;if(failRead)throw Error('CHAT_PROVIDER_UNAVAILABLE');},send:async(text)=>{sendCount++;if(failSend)throw Error('unknown');const id='om_prompt'+(++seq);messages.set(id,message(id,text,{sender:{sender_type:'app',id_type:'app_id',id:config.appId}}));return id;},list:async()=>[...messages.values()],get:async id=>{getCount++;return structuredClone(messages.get(id));}};
 source.reply=async(target,text,uuid)=>{const id=await source.send(text,uuid);messages.get(id).parent_id=target;return id;};
 const chat=new ChatApproval(ledger,{...config,semantic:{enabled:semantic}},{source,classify});t.after(async()=>{await chat.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const start=async()=>{const r=req();chat.queue(r.id);await chat.tick();return {r,prompt:[...messages.values()][0]};};
 const reply=(prompt,text='确定',fields={})=>{now+=10000;const id='om_reply'+(++seq),m=message(id,text,{parent_id:prompt.message_id,...fields});messages.set(id,m);return m;};
 return {dir,store,catalog,ledger,task,req,chat,source,messages,start,reply,time:ms=>now+=ms,counts:()=>({sendCount,verifyCount,getCount}),failSend:v=>failSend=v,failRead:v=>failRead=v};
}

export {fixture,config,proposal};
