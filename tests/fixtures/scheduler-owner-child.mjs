// Synthetic disposable scheduler fixture. No agent, model, source, Git or IM capability.
import {TaskScheduler} from '../../bundle/task-scheduler.js';
const [root,port,mode]=process.argv.slice(2);const s=new TaskScheduler({on(){}},{stateDir:root,lockPort:Number(port),intervalMs:60000});
const status=()=>({type:'ready',port:s.lock.address().port,jobs:s.jobs.list('fixture').map(j=>({...j,version:s.jobs.get(j.id).version})),active:s.active.size});
let stopping=false;async function stop(){if(stopping)return;stopping=true;await s.close();process.disconnect?.();}
process.on('message',m=>{if(m==='close')void stop();});process.on('SIGTERM',()=>void stop());
try{
 await s.start();
 if(mode==='seed'){
  const j=s.jobs.enqueue({task_id:'fixture',trigger_id:'fixture',kind:'development',goal:'synthetic no-side-effect fixture',version:'0.21.0',max_runs:1});
  s.jobs.db.prepare("UPDATE jobs SET status='queued',approved_by='SYNTHETIC_FIXTURE' WHERE id=?").run(j.id);s.jobs.claim(new Set(['development']),new Set());
 }
 process.send?.(status());
}catch(e){process.send?.({type:'error',code:e.message});await stop();}
