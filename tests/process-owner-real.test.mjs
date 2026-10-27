import test from 'node:test';import assert from 'node:assert/strict';import {fork} from 'node:child_process';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {createServer} from 'node:net';
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function launch(root,p,mode){
 const child=fork(new URL('./fixtures/scheduler-owner-child.mjs',import.meta.url),[root,String(p),mode],{stdio:['ignore','ignore','pipe','ipc']});let stderr='';child.stderr.on('data',b=>{stderr+=b;});
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));const ready=new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',code=>{if(code!==0)reject(Error('fixture exited '+code+': '+stderr));});});
 return {child,ready,closed,async stop(){if(child.exitCode===null&&child.signalCode===null){if(child.connected)child.send('close');else child.kill('SIGTERM');}await closed;}};
}
test('actual second process cannot recover a live different-port owner; crash recovery does not replay development', {timeout:15000},async t=>{
 const root=mkdtempSync(tmpdir()+'/s40-real-owner-'),p=await port(),children=[];t.after(async()=>{await Promise.all(children.map(c=>c.stop()));rmSync(root,{recursive:true,force:true});});
 const a=launch(root,p,'seed');children.push(a);const first=await a.ready;assert.equal(first.type,'ready');assert.equal(first.jobs[0].status,'running');assert.equal(first.jobs[0].attempts,1);
 const b=launch(root,await port(),'recover');children.push(b);assert.equal((await b.ready).code,'SCHEDULER_OWNER_CHANGED');await b.closed;
 // A still owns the original port; merely losing an observer is not restart permission.
 const c=launch(root,p,'recover');children.push(c);assert.match((await c.ready).code,/EADDRINUSE/);await c.closed;
 a.child.kill('SIGKILL');assert.equal((await a.closed).signal,'SIGKILL');
 const d=launch(root,p,'recover');children.push(d);const recovered=await d.ready;assert.equal(recovered.type,'ready');assert.equal(recovered.jobs[0].id,first.jobs[0].id);assert.equal(recovered.jobs[0].status,'needs_review');assert.equal(recovered.jobs[0].attempts,1);assert.equal(recovered.active,0);await d.stop();
});
