import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {createServer} from 'node:net';
import {TaskScheduler} from '../bundle/task-scheduler.js';
const config=stateDir=>({stateDir,lockPort:0,intervalMs:60000});
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test('same task database cannot change lock port to recover another live scheduler',async t=>{
 const root=mkdtempSync(tmpdir()+'/s40-owner-'),a=new TaskScheduler({on(){}},config(root),{allowEphemeralLock:true});let b;
 t.after(async()=>{await b?.close();await a.close();rmSync(root,{recursive:true,force:true});});await a.start();
 const j=a.jobs.enqueue({task_id:'fixture',trigger_id:'fixture',kind:'test.checkpoint',goal:'fixture'}),run=a.jobs.claim(new Set(['test.checkpoint']),new Set(['test.checkpoint']));
 b=new TaskScheduler({on(){}},{...config(root),lockPort:await freePort()});await assert.rejects(b.start(),/SCHEDULER_OWNER_CHANGED/);
 assert.equal(a.jobs.get(j.id).status,'running');assert.equal(a.jobs.get(j.id).claim,run.claim);
});
test('persistent port remains required after clean shutdown; same owner can recover original state',async t=>{
 const root=mkdtempSync(tmpdir()+'/s40-owner-');let a,b,c;
 t.after(async()=>{await c?.close();await b?.close();await a?.close();rmSync(root,{recursive:true,force:true});});
 a=new TaskScheduler({on(){}},config(root),{allowEphemeralLock:true});await a.start();const port=a.lock.address().port;
 const j=a.jobs.enqueue({task_id:'fixture',trigger_id:'fixture',kind:'test.checkpoint',goal:'fixture'});a.jobs.claim(new Set(['test.checkpoint']),new Set(['test.checkpoint']));await a.close();
 b=new TaskScheduler({on(){}},{...config(root),lockPort:await freePort()});await assert.rejects(b.start(),/SCHEDULER_OWNER_CHANGED/);assert.equal(b.jobs.get(j.id).status,'running');await b.close();
 c=new TaskScheduler({on(){}},{...config(root),lockPort:port});await c.start();assert.equal(c.jobs.get(j.id).status,'queued');assert.equal(c.jobs.get(j.id).attempts,1);
});
test('independent task databases do not share a global lock',async t=>{
 const root=mkdtempSync(tmpdir()+'/s40-owner-');const a=new TaskScheduler({on(){}},config(root+'/a'),{allowEphemeralLock:true}),b=new TaskScheduler({on(){}},config(root+'/b'),{allowEphemeralLock:true});t.after(async()=>{await b.close();await a.close();rmSync(root,{recursive:true,force:true});});await a.start();await b.start();assert(a.started&&b.started);
});
test('concurrent first starts with different ephemeral ports persist only one owner',async t=>{
 const root=mkdtempSync(tmpdir()+'/s40-owner-');const a=new TaskScheduler({on(){}},config(root),{allowEphemeralLock:true}),b=new TaskScheduler({on(){}},config(root),{allowEphemeralLock:true});t.after(async()=>{await b.close();await a.close();rmSync(root,{recursive:true,force:true});});
 const results=await Promise.allSettled([a.start(),b.start()]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&/SCHEDULER_OWNER_(CHANGED|MIGRATION_REQUIRED)/.test(r.reason.message)).length,1);assert.equal(Number(a.started)+Number(b.started),1);
});
test('close during startup cannot run recovery or retain an opened lock',async t=>{
 const root=mkdtempSync(tmpdir()+'/s40-owner-');const s=new TaskScheduler({on(){}},config(root),{allowEphemeralLock:true});t.after(()=>rmSync(root,{recursive:true,force:true}));let recovered=false;s.jobs.recover=()=>{recovered=true;};
 const starting=s.start(),checked=assert.rejects(starting,/SCHEDULER_CLOSED/);await s.close();await checked;assert.equal(recovered,false);assert.equal(s.lock.listening,false);
});
test('failed post-lock initialization releases the socket but never starts a timer',async t=>{
 const root=mkdtempSync(tmpdir()+'/s40-owner-');const s=new TaskScheduler({on(){}},{...config(root),afterRecover(){throw Error('fixture initialization failed');}},{allowEphemeralLock:true});t.after(async()=>{await s.close();rmSync(root,{recursive:true,force:true});});await assert.rejects(s.start(),/fixture initialization/);assert.equal(s.lock.listening,false);assert.equal(s.started,false);assert.equal(s.timer,undefined);
});

test('fresh fixed-port startup failure retains its original owner coordinate for a safe same-port retry',async t=>{
 const root=mkdtempSync(tmpdir()+'/s40-first-bind-'),socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;let a,b;
 t.after(async()=>{if(socket.listening)await new Promise(r=>socket.close(r));await b?.close();await a?.close();rmSync(root,{recursive:true,force:true});});
 a=new TaskScheduler({on(){}},{stateDir:root,lockPort:port,intervalMs:60000});await assert.rejects(a.start(),/EADDRINUSE/);await a.close();await new Promise(r=>socket.close(r));
 b=new TaskScheduler({on(){}},{stateDir:root,lockPort:port,intervalMs:60000});await b.start();assert.equal(b.started,true);assert.equal(b.jobs.db.prepare('SELECT port FROM scheduler_owner').get().port,port);
});
