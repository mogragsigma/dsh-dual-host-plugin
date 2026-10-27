// Reproduce the pre-owner TCP locking protocol with the frozen legacy job store.
// This is a child-process fixture, not a production Host or real development worker.
import {createServer} from 'node:net';
import {TaskJobs} from './v020-alpha6/task-jobs.js';
const [root,port]=process.argv.slice(2),jobs=new TaskJobs(root),lock=createServer(s=>s.destroy());
await new Promise((resolve,reject)=>{lock.once('error',reject);lock.listen(Number(port),'127.0.0.1',resolve);});
const j=jobs.enqueue({task_id:'fixture',trigger_id:'legacy-child',kind:'development',goal:'legacy child fixture',version:'0.19.2'});jobs.db.prepare("UPDATE jobs SET status='queued',approved_by='fixture' WHERE id=?").run(j.id);jobs.claim(new Set(['development']),new Set());
process.send?.({id:j.id});
process.on('message',m=>{if(m==='close'){jobs.close();lock.close(()=>process.disconnect());}});
