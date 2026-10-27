import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
export function observationRows(){
 const o=randomUUID(),a=randomUUID();return {
  coordinated_hold_status:{contract:1,scope:'coordinated_components_only',state:'open',components:{onboarding:{instanceId:o},agents:{instanceId:a},gateway:{state:'not_configured'}}},
  onboarding_hold_status:{contract:1,scope:'own_onboarding_only',instanceId:o,state:'open',counts:{rpc:0,startup:0,model_attempt:0,workbench_http:0,workbench_websocket:0}},
  agent_hold_status:{contract:1,scope:'native_agents_only',instanceId:a,state:'open',inboxState:'empty',counts:{agents:2,running:0,unsupported:0,held:0,pendingNextTurn:0,pendingNextStep:0,inboxUnknown:0}},
  im_maintenance_status:{contract:1,inventoryState:'observed',instanceId:randomUUID(),pending:false,operationInFlight:false}
 };
}
export async function observationServer(t,root,j){
 const rows=observationRows(),calls=[],settings={auth:true,wrongId:false};
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/connect'){if(url.searchParams.get('token')!=='isolated-test-only'){res.writeHead(401);res.end();return;}res.writeHead(settings.auth?302:401,{'set-cookie':'test-cookie=isolated','location':'/'});res.end();return;}
  if(req.url!=='/api/task-onboarding/control'||req.headers.cookie!=='test-cookie=isolated'){res.writeHead(404);res.end();return;}
  let text='';for await(const c of req)text+=c;const q=JSON.parse(text),method=q.payload.method;calls.push(method);
  res.setHeader('content-type','application/json');res.end(JSON.stringify({type:'server-response',rpcId:settings.wrongId?'wrong':q.rpcId,result:{ok:true,value:rows[method]}}));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const origin='http://127.0.0.1:'+server.address().port,nonce=randomUUID(),control=path.join(root,'.control/runtime');await fs.mkdir(control,{recursive:true,mode:0o700});
 const access=path.join(control,'native-access.json');await fs.writeFile(access,JSON.stringify({url:origin+'/?token=isolated-test-only'}),{mode:0o600});
 Object.assign(j,{state:'host_ready',nativeNonce:nonce,nativeReceipt:{ok:true,pid:j.host.pid,nonce,origin,dshHome:path.join(root,'runtime/native-home/dsh'),agentsHome:path.join(root,'runtime/native-home/agents')}});
 return {rows,calls,settings,origin,access};
}
export async function regular(file){try{const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw Error('UNSAFE_FILE');const data=await fs.readFile(file);return {data,sha256:createHash('sha256').update(data).digest('hex'),identity:{mode:s.mode&0o777,uid:s.uid}};}catch(e){if(e.code==='ENOENT')return null;throw e;}}
