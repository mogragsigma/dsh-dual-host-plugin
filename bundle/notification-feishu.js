// Explicit opt-in adapter owned by this project. No IM private imports or consumer.
import {FeishuApprovalSource,chatBinding} from './approval-feishu.js';
import {mediaHash} from './artifact-media.js';
import {digest} from './notification-contract.js';
const failure=code=>Object.assign(Error('NOTIFICATION_DIRECT_PREFLIGHT_REJECTED'),{code});
export function feishuNotificationTarget(c,{alias,label,host}){
 const b=chatBinding(c);
 return {host,alias,label,transport:'feishu-openapi',botId:b.appId,targetId:b.chatId,conversationId:b.chatId,receipt_mode:'message',expectedFingerprint:digest({provider:b.provider,appId:b.appId,botOpenId:b.botOpenId}),expectedTargetDigest:digest({chatId:b.chatId,approverOpenId:b.approverOpenId,mode:'p2p'})};
}
export class FeishuNotificationSender {
 constructor(c,io={}){this.c=c;this.io=io;this.binding=chatBinding(c);this.contractVersion=1;this.receiptVersion=1;}
 async prepare(botId,targetId,options){
  const pin=feishuNotificationTarget(this.c,{host:'cloud',alias:'pin',label:'pin'});
  if(botId!==pin.botId||options.expectedFingerprint!==pin.expectedFingerprint)throw failure('account-changed');
  if(targetId!==pin.targetId||options.expectedTargetDigest!==pin.expectedTargetDigest)throw failure('target-changed');
  if(options.receipt!==true||options.format!=='plain')throw failure('bad-request');
  let source;
  try{
   const fetcher=this.io.fetcher??fetch,signal=options.signal;
   source=new FeishuApprovalSource(this.c,{...this.io,fetcher:(url,args)=>{signal?.throwIfAborted();return fetcher(url,{...args,signal:signal?AbortSignal.any([signal,args.signal]):args.signal});}});
   await source.verifyBot();signal?.throwIfAborted();
  }catch(e){if(options.signal?.aborted)throw e;throw failure(e.message==='CHAT_BOT_CHANGED'||e.message==='CHAT_PRIVATE_ROUTE_REQUIRED'?'account-changed':'account-unverified');}
  return source;
 }
 async sendChecked(botId,targetId,text,options){
  const source=await this.prepare(botId,targetId,options);
  const id=await source.send(text,options.idempotencyKey);
  return {sent:true,receipt:{version:1,messageId:id,conversationId:this.binding.chatId}};
 }
 async upload(source,media){
  const form=new FormData(),image=media.mode==='image';
  if(image)form.set('image_type','message');else{form.set('file_type','stream');form.set('file_name',media.name);}
  form.set(image?'image':'file',new Blob([media.bytes],{type:media.mime}),media.name);
  const response=await source.http(image?'/im/v1/images':'/im/v1/files',{method:'POST',headers:{Authorization:'Bearer '+await source.auth()},body:form});
  const key=response.data?.[image?'image_key':'file_key'];if(typeof key!=='string'||!new RegExp('^'+(image?'img_':'file_')+'[A-Za-z0-9_-]{4,300}$').test(key))throw Error('NOTIFICATION_UPLOAD_RESULT_UNKNOWN');return key;
 }
 async verifyFile(source,message,key,artifact){
  if(!/^om_[A-Za-z0-9_-]{4,128}$/.test(message)||!/^file_[A-Za-z0-9_-]{4,300}$/.test(key??''))throw Error('NOTIFICATION_MEDIA_MESSAGE_UNAVAILABLE');
  // Feishu can replace upload keys with per-message resource keys. Verify bytes, not guessed key equivalence.
  const r=await source.fetcher('https://open.feishu.cn/open-apis/im/v1/messages/'+encodeURIComponent(message)+'/resources/'+encodeURIComponent(key)+'?type=file',{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+await source.auth()},signal:AbortSignal.timeout(10000)});
  if(!r.ok||!r.body)throw Error('NOTIFICATION_MEDIA_MESSAGE_UNAVAILABLE');
  const chunks=[];let size=0;for await(const x of r.body){size+=x.byteLength;if(size>1048576||size>artifact.size)throw Error('NOTIFICATION_ARTIFACT_CHANGED');chunks.push(x);}
  if(size!==artifact.size||mediaHash(Buffer.concat(chunks))!==artifact.sha256)throw Error('NOTIFICATION_ARTIFACT_CHANGED');
 }
 async sendMedia(source,media,key,intro,uuid){
  const kind=media.mode==='image'?'post':'file';
  const content=media.mode==='image'?{zh_cn:{title:media.name,content:[[{tag:'text',text:intro}],[{tag:'img',image_key:key}]]}}:{file_key:key};
  const response=await source.api('/im/v1/messages?receive_id_type=chat_id',{method:'POST',body:JSON.stringify({receive_id:this.binding.chatId,msg_type:kind,content:JSON.stringify(content),uuid})});
  if(!/^om_[A-Za-z0-9_-]{4,128}$/.test(response.data?.message_id??'')||response.data.chat_id!==this.binding.chatId)throw Error('NOTIFICATION_SEND_RESULT_UNKNOWN');return response.data.message_id;
 }
}
