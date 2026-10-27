// Authenticated own-route adapter to the public IM management Fetch carrier.
// No private controllers, launch tokens, synthetic authority or copied credentials.
import {randomUUID,createHash} from 'node:crypto';
const fail=()=>{throw Error('ONBOARDING_IM_MAINTENANCE_TRANSPORT_REVIEW');};
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
export function projectMaintenanceBots(value){
 if(value?.schemaVersion!==2||!Array.isArray(value.bots)||value.bots.length>512)fail();
 const seen=new Set();return value.bots.map(row=>{
  if(!id(row?.botId)||seen.has(row.botId)||typeof row.configured!=='boolean'||typeof row.connected!=='boolean'||!['connected','disconnected','connecting','provisioning','error'].includes(row.state)||(row.state==='connected')!==row.connected)fail();seen.add(row.botId);
  // Hash only known public configuration, excluding volatile health/error timestamps.
  const keys=['botId','configured','model','agentPreset','contextEnhancement','busyMessageMode','accessPolicy','groupResponseMode','mentionTopicReply','stepPush','stepPushMode','stepCardPanels','voice','slashPanel','groupMessagePermissionGranted','workspace','bot'];
  const config=Object.fromEntries(keys.map(k=>[k,row[k]??null]));
  return {botId:row.botId,channel:'feishu',name:typeof row.bot?.name==='string'?row.bot.name.slice(0,160):'飞书机器人',configured:row.configured,connected:row.connected,state:row.state,configHash:createHash('sha256').update(JSON.stringify(config)).digest('hex')};
 });
}
export function nativeImMaintenanceTransport(connection,request){
 if(typeof connection?.createSharedFetchHandler!=='function'||!connection.browserPeer||!(request instanceof Request))return null;
 const handler=connection.createSharedFetchHandler('/api'),url=new URL('/api/dsh-im/feishu',request.url);
 return Object.freeze({async call(action,botId){
  if(!['status','disconnect','reconnect'].includes(action)||action!=='status'&&!id(botId))fail();
  const method=action==='status'?'connection.status':'bot.'+action,payload=action==='status'?{}:{botId},rpcId=randomUUID();
  // Preserve the original authority. In particular do not turn a remote Origin
  // into localhost to bypass an upstream loopback-only policy.
  const headers=new Headers({'content-type':'application/json'});
  for(const name of ['host','origin'])if(request.headers.has(name))headers.set(name,request.headers.get(name));
  const reply=await handler.fetch(new Request(url,{method:'POST',headers,body:JSON.stringify({type:'client-request',rpcId,method:'dsh-im/feishu',payload:{method,payload}})}),connection.browserPeer);
  if(!reply.ok)fail();const raw=await reply.text();if(raw.length>1048576)fail();let b;try{b=JSON.parse(raw);}catch{fail();}
  if(b?.type!=='server-response'||b.rpcId!==rpcId||b.result?.ok!==true)fail();return projectMaintenanceBots(b.result.value);
 }});
}
