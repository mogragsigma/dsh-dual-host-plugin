import {execFile} from 'node:child_process';
const aborted=()=>Object.assign(Error('Operation aborted'),{code:'ABORT_ERR',drained:true});
// Internal process adapter, not a model tool. A callback/error is not drain evidence.
// Only 'close' proves the direct child has exited and its stdio has closed. Callers
// must separately disallow descendants or track them before claiming a whole tree drained.
export function execFileDrained(file,args,options,input,{execute=execFile,onSpawn,onClose}={}){
 const {signal,...opts}=options;if(signal?.aborted)return Promise.reject(aborted());
 return new Promise((resolve,reject)=>{
  let child,callbackSeen=false,closed=false,error,stdout,aborting=false;
  const finish=()=>{if(!closed||!callbackSeen)return;signal?.removeEventListener('abort',abort);
   if(aborting)reject(aborted());else if(error)reject(Object.assign(error,{drained:true}));else resolve(stdout);};
  const abort=()=>{aborting=true;child.kill(opts.killSignal??'SIGKILL');};
  try{
   // Do not pass signal to execFile: its abort error callback may run before exit.
   child=execute(file,args,opts,(e,out)=>{callbackSeen=true;error??=e;stdout=out;finish();});
   child.once('close',(code,signal)=>{closed=true;try{onClose?.({code,signal});}catch(e){error??=e;}finish();});
   onSpawn?.({pid:child.pid??null});
   signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
   child.stdin?.on('error',()=>{});child.stdin?.end(input);
  }catch(e){
   if(!child){reject(e);return;}
   // A synchronous stdin failure does not prove the process is gone either.
   error=e;callbackSeen=true;child.kill(opts.killSignal??'SIGKILL');finish();
  }
 });
}
