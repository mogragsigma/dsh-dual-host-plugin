import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Gateway} from '../bundle/index.js';
import {makeEnvelope} from '../bundle/task-envelope.js';
import {feishuNotificationTarget} from '../bundle/notification-feishu.js';
export const hash=b=>createHash('sha256').update(b).digest('hex');
export const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1kAAAAASUVORK5CYII=','base64');
export async function fixture(t,{host='cloud'}={}){
 const root=mkdtempSync(tmpdir()+'/notify-media-');writeFileSync(root+'/tokens.json',JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});
 let now=Date.now(),seq=0,hook=()=>{};const calls=[],c={provider:'feishu',appId:'cli_test1234',botOpenId:'ou_bot1234',approverOpenId:'ou_user1234',chatId:'oc_chat1234',appSecretEnv:'TEST_MEDIA_SECRET',alias:'media'};
 const target=feishuNotificationTarget(c,{host,alias:c.alias,label:'媒体验收私聊'});
 const ok=x=>Response.json({code:0,...x});
 const io={env:{TEST_MEDIA_SECRET:'fixture'},fetcher:async(url,args)=>{
  calls.push({url,args});await hook(url,args);
  if(url.endsWith('/internal'))return ok({tenant_access_token:'fixture-token',expire:7200});
  if(url.endsWith('/info'))return ok({bot:{open_id:c.botOpenId}});
  if(url.includes('/chats/'))return ok({data:{chat_mode:'p2p'}});
  if(url.endsWith('/images'))return ok({data:{image_key:'img_fixture'}});
  if(url.endsWith('/files'))return ok({data:{file_key:'file_fixture'}});
  if(url.includes('/resources/')){const upload=calls.find(x=>x.url.endsWith('/files'));return new Response(await upload.args.body.get('file').arrayBuffer());}
  if(/\/messages\/om_/.test(url)){
   const sent=calls.find(x=>x.url.includes('/messages?')&&'om_fixture'+(calls.indexOf(x)+1)===url.split('/').at(-1)),body=sent&&JSON.parse(sent.args.body);
   return ok({data:{items:[{message_id:url.split('/').at(-1),chat_id:c.chatId,msg_type:body?.msg_type,body:{content:body?.msg_type==='file'?JSON.stringify({...JSON.parse(body.content),file_name:calls.find(x=>x.url.endsWith('/files')).args.body.get('file_name')}):body?.content},message_position:123,deleted:false,updated:false}]}});
  }
  if(url.includes('/messages?'))return ok({data:{message_id:'om_fixture'+calls.length,chat_id:c.chatId}});
  throw Error('unexpected-url');
 }};
 const ctx={on(){},effect(){},agents:{list:()=>[],get(){}},agentPresets:{composedPreset:a=>a.preset},get(){return null;}};
 const config={role:'cloud',entryMode:'native',namespace:'media-test',stateDir:root+'/cloud',tokenFile:root+'/tokens.json',port:0,notificationTargets:[target],notificationFeishu:host==='cloud'?[c]:[],scheduler:{lockPort:0,intervalMs:60000},recovery:{sendTimeoutMs:50,maxAttempts:3,baseMs:10,maxMs:100}};
 const g=new Gateway(ctx,config,{now:()=>now,notificationFeishu:io,scheduler:{allowEphemeralLock:true,now:()=>now}});
 t.after(async()=>{await g.close();rmSync(root,{recursive:true,force:true});});
 const source=(text,role='cloud')=>[{role,session_id:'operator-fixture',message_id:'m'+(++seq),text,sha256:hash(text)}];
 const policy={provider:'fixture-only',model:'zero-model',reasoningEffort:'high'};
 const create=async()=>{
  const agent={id:'entry',session:{deriveMessages:()=>[{id:'create'+(++seq),role:'user',source:{kind:'user'},content:[{type:'text',text:'运营方媒体夹具，不是模型结果'}]}]}};
  return g.call('accept',{...makeEnvelope(agent,'cloud',{title:'媒体验收',notification_contract:1,goal:'零模型注册与交付',target:'cloud',intent:'plan',model_policy:policy}),source:'native-cloud'});
 };
 const report=(task,format='markdown',bytes=Buffer.from('隔离成果正文\n'))=>{
  const job=g.scheduler.jobs.enqueue({task_id:task.id,trigger_id:'artifact'+(++seq),goal:g.catalog.head(task.id).goal,policy,max_runs:1}),claim=g.scheduler.jobs.claim(new Set(['plan']),new Set(['plan']));
  const worker={binding:()=>({job:claim,report:null})},name=format==='png'?'界面.png':'报告.md';
  const a=g.artifacts.registerReport(worker,{}, {name,format,content:format==='png'?bytes.toString('base64'):bytes.toString(),description:'运营方零模型成果夹具'},'report'+(++seq));
  g.scheduler.jobs.finish(claim,{outcome:'done',summary:'已登记夹具'});return a;
 };
 const bind=async task=>{const quote='请把此任务通知发到媒体验收私聊';return g.call('notification_bind',{task_id:task.id,expected_revision:1,expected_binding_revision:g.notifications.status(task.id).binding?.revision??0,action:'set',target_key:host+':media',policy:{events:['result']},authorization_quote:quote,sources:source(quote),event_id:'bind'+(++seq)});};
 const disable=task=>g.call('notification_bind',{task_id:task.id,expected_revision:1,expected_binding_revision:g.notifications.status(task.id).binding.revision,action:'disable',authorization_quote:'停止',sources:source('停止'),event_id:'stop'+(++seq)});
 const args=(task,a,mode='file')=>{const quote='将 '+a.name+' 以'+mode+'发送到媒体验收私聊';return {task_id:task.id,artifact_id:a.id,mode,expected_revision:1,expected_binding_revision:g.notifications.status(task.id).binding?.revision??0,authorization_quote:quote,sources:source(quote),event_id:'send'+(++seq)};};
 const send=a=>g.call('notification_artifact_send',a);
 const queued=async(format='markdown',bytes)=>{const task=await create(),a=report(task,format,bytes);await bind(task);const request=args(task,a,format==='png'?'image':'file'),r=await send(request);return {task,a,request,r,e:g.notifications.media.pull(host).items[0]};};
 const row=id=>g.db.prepare('SELECT * FROM task_notifications WHERE id=?').get(id);
 const posts=()=>calls.filter(x=>x.url.includes('/im/v1/')&&x.args.method==='POST');
 return {g,root,c,target,io,ctx,config,calls,source,create,report,bind,disable,args,send,queued,row,posts,hook:f=>hook=f,advance:ms=>now+=ms};
}
