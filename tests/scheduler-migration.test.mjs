import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync,renameSync} from 'node:fs';import {tmpdir} from 'node:os';import {createServer} from 'node:net';import {DatabaseSync} from 'node:sqlite';
import {TaskJobs as LegacyJobs} from './fixtures/v020-alpha6/task-jobs.js';
import {TaskScheduler} from '../bundle/task-scheduler.js';
import {schedulerMigrationPlan,adoptSchedulerOwner} from '../bundle/scheduler-migration.js';
async function fixture(t){
 const root=mkdtempSync(tmpdir()+'/s40-migration-'),s=createServer(x=>x.destroy());await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;
 const old=new LegacyJobs(root),j=old.enqueue({task_id:'fixture',trigger_id:'legacy',kind:'development',goal:'synthetic legacy development',version:'0.19.2',max_runs:3});old.db.prepare("UPDATE jobs SET status='queued',approved_by='synthetic' WHERE id=?").run(j.id);old.claim(new Set(['development']),new Set());old.close();
 t.after(()=>{if(s.listening)s.close();rmSync(root,{recursive:true,force:true});});
 return {root,port,s,j,options:{priorLockPort:port,sourceVersion:'0.20.0-alpha.6',sourceConfigHash:'c'.repeat(64)},stop:()=>new Promise(r=>s.close(r))};
}
test('legacy database requires explicit adoption even when an unrelated port is free',async t=>{
 const f=await fixture(t),n=new TaskScheduler({on(){}},{stateDir:f.root,lockPort:0},{allowEphemeralLock:true});t.after(()=>n.close());await assert.rejects(n.start(),/OWNER_MIGRATION_REQUIRED/);assert.equal(n.jobs.get(f.j.id).status,'running');assert.equal(n.jobs.get(f.j.id).attempts,1);
});
test('known legacy lock must actually close; migration backs up without recovering jobs or resetting budgets',async t=>{
 const f=await fixture(t),plan=schedulerMigrationPlan(f.root,f.options),backup=f.root+'/before.sqlite';
 await assert.rejects(adoptSchedulerOwner(plan,{confirmLegacyStopped:true,backupPath:backup}),/EADDRINUSE/);await f.stop();
 await assert.rejects(adoptSchedulerOwner(plan,{backupPath:backup}),/CONFIRMATION_REQUIRED/);
 const v=await adoptSchedulerOwner(plan,{confirmLegacyStopped:true,backupPath:backup});assert.equal(v.recoveryStarted,false);assert.equal(statSync(backup).mode&0o777,0o600);
 const db=new DatabaseSync(backup,{readOnly:true});assert.equal(db.prepare('SELECT status FROM jobs').get().status,'running');assert.equal(db.prepare('SELECT attempts FROM jobs').get().attempts,1);db.close();
 assert.equal((await adoptSchedulerOwner(plan,{confirmLegacyStopped:true,backupPath:backup})).replayed,true);
 const n=new TaskScheduler({on(){}},{stateDir:f.root,lockPort:f.port,intervalMs:60000});t.after(()=>n.close());assert.equal(n.jobs.get(f.j.id).status,'running');await n.start();assert.equal(n.jobs.get(f.j.id).status,'needs_review');assert.equal(n.jobs.get(f.j.id).attempts,1);assert.equal(n.active.size,0);
});
test('stale migration plans, replaced databases and changed port proofs cannot be adopted',async t=>{
 for(const change of ['row','file','port']){
  const f=await fixture(t),plan=schedulerMigrationPlan(f.root,f.options);await f.stop();
  if(change==='row'){const db=new DatabaseSync(f.root+'/jobs.sqlite');db.exec("UPDATE jobs SET goal='changed'");db.close();}
  if(change==='file'){renameSync(f.root+'/jobs.sqlite',f.root+'/old.sqlite');const d=new LegacyJobs(f.root);d.close();}
  if(change==='port')plan.priorLockPort++;
  await assert.rejects(adoptSchedulerOwner(plan,{confirmLegacyStopped:true,backupPath:f.root+'/backup.sqlite'}),/STALE_PLAN|DATABASE_CHANGED|CONFIRMATION_REQUIRED/);
 }
});
test('an existing empty legacy database also cannot bypass migration; missing source config is not guessed',async t=>{
 const root=mkdtempSync(tmpdir()+'/s40-empty-'),j=new LegacyJobs(root);j.close();const s=new TaskScheduler({on(){}},{stateDir:root,lockPort:0},{allowEphemeralLock:true});t.after(async()=>{await s.close();rmSync(root,{recursive:true,force:true});});await assert.rejects(s.start(),/MIGRATION_REQUIRED/);assert.throws(()=>schedulerMigrationPlan(root,{priorLockPort:12345}),/CONFIG_REQUIRED/);
});

import {fork} from 'node:child_process';
test('separate live legacy process prevents owner adoption, then actual exit permits same-port migration', {timeout:15000},async t=>{
 const root=mkdtempSync(tmpdir()+'/s40-legacy-child-'),socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const child=fork(new URL('./fixtures/legacy-owner-child.mjs',import.meta.url),[root,String(port)],{stdio:['ignore','ignore','ignore','ipc']}),closed=new Promise(r=>child.once('close',r));let n;
 t.after(async()=>{if(child.connected)child.send('close');await closed;await n?.close();rmSync(root,{recursive:true,force:true});});
 const started=await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',c=>{if(c)reject(Error('legacy fixture exited'));});});
 const plan=schedulerMigrationPlan(root,{priorLockPort:port,sourceVersion:'0.20.0-alpha.6',sourceConfigHash:'d'.repeat(64)});
 await assert.rejects(adoptSchedulerOwner(plan,{confirmLegacyStopped:true,backupPath:root+'/before.sqlite'}),/EADDRINUSE/);
 child.send('close');await closed;await adoptSchedulerOwner(plan,{confirmLegacyStopped:true,backupPath:root+'/before.sqlite'});
 n=new TaskScheduler({on(){}},{stateDir:root,lockPort:port,intervalMs:60000});await n.start();assert.equal(n.jobs.get(started.id).status,'needs_review');assert.equal(n.jobs.get(started.id).attempts,1);assert.equal(n.active.size,0);
});
