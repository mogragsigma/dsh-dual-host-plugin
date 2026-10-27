// Official HTTPS API only. No IM plugin imports, storage, WebSocket or private Host API.
const BASE='https://open.feishu.cn/open-apis';
const id=(v,p)=>typeof v==='string'&&new RegExp('^'+p+'[A-Za-z0-9_-]{4,128}$').test(v);
export function chatBinding(c){
 if(!c||c.provider!=='feishu'||!id(c.appId,'cli_')||!id(c.botOpenId,'ou_')||!id(c.chatId,'oc_')||!id(c.approverOpenId,'ou_')||!(/^[A-Z][A-Z0-9_]{2,80}$/).test(c.appSecretEnv??''))throw Error('INVALID_CHAT_APPROVAL_BINDING');
 return {provider:'feishu',appId:c.appId,botOpenId:c.botOpenId,chatId:c.chatId,approverOpenId:c.approverOpenId};
}
export class FeishuApprovalSource {
 constructor(c,{fetcher=fetch,env=process.env,now=Date.now,credentials}={}){this.binding=chatBinding(c);this.secretRef=c.appSecretEnv;this.credentials=credentials;this.secret=credentials?null:env[c.appSecretEnv];if(!credentials&&(typeof this.secret!=='string'||!this.secret))throw Error('CHAT_APPROVAL_CREDENTIAL_UNAVAILABLE');this.fetcher=fetcher;this.now=now;this.token=null;}
 async http(path,options={}){
  let r;try{r=await this.fetcher(BASE+path,{...options,redirect:'error',signal:AbortSignal.timeout(10000)});}catch{throw Error('CHAT_PROVIDER_UNAVAILABLE');}
  if(!r.ok)throw Error('CHAT_PROVIDER_HTTP_'+r.status);
  let raw='',bytes=0;const decoder=new TextDecoder();for await(const part of r.body){bytes+=part.byteLength;raw+=decoder.decode(part,{stream:true});if(bytes>1048576)throw Error('CHAT_PROVIDER_RESPONSE_TOO_LARGE');}
  raw+=decoder.decode();let d;try{d=JSON.parse(raw);}catch{throw Error('CHAT_PROVIDER_INVALID_RESPONSE');}
  if(d.code!==0)throw Error('CHAT_PROVIDER_CODE_'+String(Number(d.code)));
  return d;
 }
 async auth(){
  // Official reference resolution is read-only and local to this Host. Resolve
  // each operation; revocation/rotation must invalidate a cached tenant token.
  if(this.credentials){let value;try{value=(await this.credentials.resolve(this.secretRef))?.value;}catch{this.token=null;this.secret=null;throw Error('CHAT_APPROVAL_CREDENTIAL_UNAVAILABLE');}
   if(typeof value!=='string'||!value){this.token=null;this.secret=null;throw Error('CHAT_APPROVAL_CREDENTIAL_UNAVAILABLE');}
   if(value!==this.secret){this.token=null;this.secret=value;}
  }
  if(this.token?.until>this.now())return this.token.value;
  const d=await this.http('/auth/v3/tenant_access_token/internal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({app_id:this.binding.appId,app_secret:this.secret})});
  if(typeof d.tenant_access_token!=='string'||!Number.isFinite(d.expire)||d.expire<=60)throw Error('CHAT_PROVIDER_INVALID_TOKEN');
  this.token={value:d.tenant_access_token,until:this.now()+(Math.min(d.expire,7200)-60)*1000};return this.token.value;
 }
 async api(path,options={}){try{return await this.http(path,{...options,headers:{Authorization:'Bearer '+await this.auth(),'content-type':'application/json'}});}catch(e){this.token=null;throw e;}}
 async verifyBot(){const d=await this.api('/bot/v3/info');if(d.bot?.open_id!==this.binding.botOpenId)throw Error('CHAT_BOT_CHANGED');const chat=await this.api('/im/v1/chats/'+encodeURIComponent(this.binding.chatId));if(chat.data?.chat_mode!=='p2p')throw Error('CHAT_PRIVATE_ROUTE_REQUIRED');}
 async get(messageId){if(!id(messageId,'om_'))throw Error('INVALID_PROVIDER_MESSAGE_ID');const d=await this.api('/im/v1/messages/'+encodeURIComponent(messageId));if(d.data?.items?.length!==1||d.data.items[0].message_id!==messageId)throw Error('CHAT_MESSAGE_NOT_FOUND');return d.data.items[0];}
 async send(text,uuid){
  const d=await this.api('/im/v1/messages?receive_id_type=chat_id',{method:'POST',body:JSON.stringify({receive_id:this.binding.chatId,msg_type:'text',content:JSON.stringify({text}),uuid})});
  if(!id(d.data?.message_id,'om_')||d.data.chat_id!==this.binding.chatId)throw Error('CHAT_SEND_RESULT_UNKNOWN');return d.data.message_id;
 }
 async reply(messageId,text,uuid){
  if(!id(messageId,'om_'))throw Error('INVALID_PROVIDER_MESSAGE_ID');
  const d=await this.api('/im/v1/messages/'+encodeURIComponent(messageId)+'/reply',{method:'POST',body:JSON.stringify({msg_type:'text',content:JSON.stringify({text}),reply_in_thread:false,uuid})});
  if(!id(d.data?.message_id,'om_')||d.data.chat_id!==this.binding.chatId)throw Error('CHAT_SEND_RESULT_UNKNOWN');return d.data.message_id;
 }
 async list(since){
  const items=[];let page;
  for(let i=0;i<4;i++){
   const q=new URLSearchParams({container_id_type:'chat',container_id:this.binding.chatId,start_time:String(Math.floor(since/1000)),sort_type:'ByCreateTimeAsc',page_size:'50',...(page?{page_token:page}:{})});
   const d=(await this.api('/im/v1/messages?'+q)).data;if(!Array.isArray(d?.items)||typeof d.has_more!=='boolean')throw Error('CHAT_HISTORY_INVALID');
   items.push(...d.items);if(!d.has_more)return items;if(typeof d.page_token!=='string'||!d.page_token||d.page_token===page)throw Error('CHAT_HISTORY_INVALID');page=d.page_token;
  }
  // Never silently skip confirmations or advance a cursor over an incomplete window.
  throw Error('CHAT_HISTORY_WINDOW_TOO_BUSY');
 }
}
