// A single owned SSH forward. No reconnect, shell interpolation or global ssh config.
import net from 'node:net';
import {spawn} from 'node:child_process';
const readyLine='DSH_ONBOARDING_FORWARD_READY\n';
const error=code=>Error('ONBOARDING_SSH_'+code);
// These are observations of SSH's diagnostic text, not proof of a network cause.
// Keep neither the text nor endpoint/key details in the returned handle.
export function forwardStderrCategory(text){
 for(const [category,pattern] of [
  ['HOSTKEY_REJECTED',/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .* host key is known/],
  ['AUTH_REJECTED',/Permission denied \(publickey|Load key .*:|UNPROTECTED PRIVATE KEY FILE/],
  ['KEEPALIVE_TIMEOUT',/Timeout, server .* not responding/],
  ['CONNECT_TIMEOUT',/connect to host .*: Operation timed out|Connection timed out/],
  ['FORWARD_BIND_FAILED',/bind .*: Address already in use|Could not request local forwarding|cannot listen to port/],
  ['CONNECTION_REFUSED',/connect to host .*: Connection refused/],
  ['NETWORK_RESET',/Connection reset by peer|Broken pipe/],
  ['REMOTE_CLOSED',/Connection to .* closed by remote host|Connection closed by .* port/],
 ])if(pattern.test(text))return category;
 return text?'UNCLASSIFIED':null;
}
export async function reserveForwardPort(){
 const server=net.createServer();await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
 const port=server.address().port;await new Promise(r=>server.close(r));return port;
}
export function startForwardProcess(file,args,{env,port,cleanup,spawnProcess=spawn,timeout=20000,now=Date.now}){
 // ExitOnForwardFailure + the remote readiness line prove this SSH child bound
 // the port after releasing the reservation. A port race fails, never reuses it.
 let child,finished=false,settled=false,stopRequested=false,killTimer,timer,text='',bytes=0,reason=null;
 let cleanupFailure=false,readyAt=null,closedAt=null,exitCode=null,exitSignal=null,stderr='',stderrCategory=null;
 // Fixed reason codes only; never persist stderr, argv, key paths or endpoints.
 const diagnostic=()=>({state:finished?'closed':readyAt!==null?'ready':'starting',readyAt,closedAt,exitCode,signal:exitSignal,reason:reason??(finished?'PROCESS_EXIT':null),stderrCategory,cleanupRequired:cleanupFailure});
 let resolveDone;const done=new Promise(r=>resolveDone=r);
 const listeners=new Set();
 const close=async()=>{if(finished&&cleanupFailure){try{await cleanup();cleanupFailure=false;}catch{throw error('CLEANUP_REVIEW');}}if(!finished&&!stopRequested){stopRequested=true;reason??='CLOSE_REQUESTED';child?.stdin.end();child?.kill('SIGTERM');killTimer=setTimeout(()=>child?.kill('SIGKILL'),1000);killTimer.unref();}await done;if(cleanupFailure)throw error('CLEANUP_REVIEW');};
 const live=()=>!finished&&!stopRequested&&child?.exitCode===null;
 const onClose=fn=>{listeners.add(fn);if(finished)queueMicrotask(fn);return()=>listeners.delete(fn);};
 const result=new Promise((resolve,reject)=>{
  const stop=code=>{reason??=code;void close().catch(()=>{});};
  const finish=async()=>{if(finished)return;finished=true;stderr='';closedAt=now();clearTimeout(timer);clearTimeout(killTimer);try{await cleanup();}catch{cleanupFailure=true;}resolveDone();for(const fn of listeners){try{fn();}catch{}}listeners.clear();if(!settled){settled=true;reject(error(cleanupFailure?'CLEANUP_REVIEW':reason??'FORWARD_FAILED'));}};
  try{child=spawnProcess(file,args,{env,stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});}catch{reason='FORWARD_FAILED';void finish();return;}
  child.once('error',()=>{reason??='FORWARD_FAILED';});child.once('close',(code,signal)=>{exitCode=Number.isInteger(code)&&code>=0&&code<=255?code:null;exitSignal=['SIGTERM','SIGKILL','SIGHUP','SIGINT','SIGPIPE'].includes(signal)?signal:null;void finish();});
  child.stdin.on('error',()=>{});
  timer=setTimeout(()=>stop('TIMEOUT'),timeout);timer.unref();
  child.stderr.on('data',b=>{bytes+=b.length;if(bytes>16384)return stop('RESPONSE_LIMIT');stderr+=b.toString('utf8');stderrCategory=forwardStderrCategory(stderr);});
  child.stdout.on('data',b=>{bytes+=b.length;if(bytes>16384)return stop('RESPONSE_LIMIT');text+=b.toString('utf8');if(!readyLine.startsWith(text)&&text!==readyLine)return stop('FORWARD_RESPONSE');if(text===readyLine&&!settled){clearTimeout(timer);settled=true;readyAt=now();resolve({port,alive:live,close,onClose,diagnostic});}});
 });
 return result;
}
