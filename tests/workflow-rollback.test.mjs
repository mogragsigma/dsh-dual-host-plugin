import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {TaskJobs} from '../bundle/task-jobs.js';
import {TaskJobs as OldJobs} from './fixtures/task-jobs-v016-alpha4.js';
for(const version of ['0.17.0','0.17.1'])test('actual v0.16 alpha4 implementation fails closed on '+version+' queued and running jobs, no budget reset',()=>{
 const root=mkdtempSync(tmpdir()+'/rollback-fence-'),caps=new Set(['plan']);let jobs=new TaskJobs(root);
 try{
  const a=jobs.enqueue({task_id:'a',trigger_id:'a',goal:'read-only fixture',policy:{provider:'p',model:'task-model'},version}),b=jobs.enqueue({task_id:'b',trigger_id:'b',goal:'read-only fixture',policy:{provider:'p',model:'task-model'},version});const run=jobs.claim(caps,caps);assert.ok(run);jobs.close();
  jobs=new OldJobs(root);jobs.recover(caps);assert.equal(jobs.claim(caps,caps),null);assert.equal(jobs.get(a.id).status,'needs_review');assert.equal(jobs.get(b.id).status,'needs_review');assert.equal(jobs.get(run.id).attempts,1);jobs.close();
  jobs=new TaskJobs(root);jobs.recover(caps);assert.equal(jobs.claim(caps,caps),null);assert.equal(jobs.get(run.id).attempts,1);
 }finally{jobs.close();rmSync(root,{recursive:true,force:true});}
});
