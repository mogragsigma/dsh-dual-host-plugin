import {TaskJobs} from '../bundle/task-jobs.js';
import {TaskWorkflows} from '../bundle/task-workflows.js';
const jobs=new TaskJobs(process.argv[2],()=>Number(process.argv[3]));let cut=process.argv[4];
const workflows=new TaskWorkflows(jobs,{afterPrepared(){if(cut==='prepare'){cut=null;throw Error('fixture_cut');}},afterEnqueued(){if(cut==='enqueue'){cut=null;throw Error('fixture_cut');}}});
process.on('message',m=>{try{if(m.op==='create')workflows.create(m.args);workflows.tick();process.send({ok:true,workflows:workflows.list('t1'),jobs:jobs.db.prepare('SELECT id,status,attempts,version FROM jobs').all()});}catch(e){process.send({ok:false,error:e.message});}});
process.send({ready:true});
