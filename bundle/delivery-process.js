// Private Linux supervisor client. Direct-child close alone does not close the
// durable operation: require the nonce-bound ECHILD + pipe-drain report as well.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
const fail=c=>Object.assign(Error('DELIVERY_PROCESS_'+c),{drained:false});
const causes=new Set([null,'ABORTED','SPAWN_FAILED','ORPHANED_DESCENDANT','TIMEOUT','OUTPUT_LIMIT']);
export function validateProcessReport(raw,nonce,exitCode,signal){
 let r;try{r=JSON.parse(raw);}catch{throw fail('REPORT_INVALID');}
 if(!r||Object.keys(r).sort().join(',')!=='cause,code,drained,nonce,reaped,schema,signal,started,stdout'||exitCode!==0||signal!==null||r.schema!==1||r.nonce!==nonce||r.drained!==true||typeof r.started!=='boolean'||
  !Number.isSafeInteger(r.reaped)||r.reaped<(r.started?1:0)||!causes.has(r.cause)||
  !(r.code===null||Number.isSafeInteger(r.code)&&r.code>=0&&r.code<=255)||
  !(r.signal===null||typeof r.signal==='string'&&/^SIG[A-Z0-9]{1,24}$/.test(r.signal))||
  (r.code===null&&r.signal===null&&r.started)||r.code!==null&&r.signal!==null||
  typeof r.stdout!=='string'||r.stdout.length>1398104||Buffer.from(r.stdout,'base64').toString('base64')!==r.stdout)throw fail('DRAIN_UNKNOWN');
 if(!r.started&&(r.code!==null||r.signal!==null||r.reaped!==0||r.stdout!==''||!['ABORTED','SPAWN_FAILED'].includes(r.cause)))throw fail('REPORT_INVALID');
 return {...r,stdout:Buffer.from(r.stdout,'base64')};
}
export function runSupervised(argv,{cwd,env,timeout=20,limit=1048576,signal,onSpawn,onDrained,receipt}={},io={}){
 if((io.platform??process.platform)!=='linux')return Promise.reject(fail('PLATFORM_UNSUPPORTED'));
 if(signal?.aborted)return Promise.reject(Object.assign(fail('ABORTED'),{drained:true}));
 const nonce=receipt?.nonce??randomBytes(32).toString('hex'),request=JSON.stringify({argv,cwd,env,timeout,limit,nonce,parent_pid:process.pid,...(receipt?{receipt}: {})});
 if(request.length>131072)return Promise.reject(fail('INPUT_LIMIT'));
 return new Promise((resolve,reject)=>{
  let child,output='',invalid=false;
  const abort=()=>{try{child.kill('SIGTERM');}catch{invalid=true;}};
  try{
   child=(io.spawn??spawn)('/usr/bin/python3',['-I','-B',fileURLToPath(new URL('./delivery-process.py',import.meta.url))],{
    cwd,env:{PATH:'/usr/bin:/bin',LC_ALL:'C'},stdio:['pipe','pipe','pipe']});
   child.stdout.on('data',b=>{if(output.length+b.length>1500000){invalid=true;abort();}else output+=b.toString('utf8');});
   child.stderr.on('data',()=>{}); // Never log inherited diagnostics/credentials.
   child.on('error',()=>{invalid=true;});child.stdin.on('error',()=>{invalid=true;});
   child.once('close',(code,closedSignal)=>{
    signal?.removeEventListener('abort',abort);
    try{if(invalid)throw fail('DRAIN_UNKNOWN');const r=validateProcessReport(output,nonce,code,closedSignal);
     onDrained?.({code:r.code,signal:r.signal,started:r.started,cause:r.cause,reaped:r.reaped});resolve(r);
    }catch{reject(fail('DRAIN_UNKNOWN'));}
   });
   if(Number.isSafeInteger(child.pid))onSpawn?.({pid:child.pid});
   signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
   child.stdin.end(request);
  }catch{
   if(child){invalid=true;abort();}else reject(fail('START_FAILED'));
  }
 });
}
