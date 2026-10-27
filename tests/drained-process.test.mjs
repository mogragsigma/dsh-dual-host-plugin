import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {execFile} from 'node:child_process';
import {execFileDrained} from '../bundle/drained-process.js';
function fixture(){let callback,options;const child=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=()=>{};child.kill=s=>{child.kills.push(s);return true;};child.kills=[];return {child,callback:(e,o)=>callback(e,o),options:()=>options,execute:(_f,_a,o,cb)=>{options=o;callback=cb;return child;}};}
const turn=()=>new Promise(r=>setImmediate(r));
test('callback error does not release a still-open child; abort explicitly kills and waits for close',async()=>{
 const f=fixture(),c=new AbortController();let settled=false;const p=execFileDrained('fixture',[],{signal:c.signal,killSignal:'SIGKILL'},'source',{execute:f.execute});const checked=assert.rejects(p,e=>e.code==='ABORT_ERR'&&e.drained===true).then(()=>{settled=true;});
 c.abort();f.callback(Object.assign(Error('early error'),{code:'ABORT_ERR'}));await turn();assert.equal(settled,false);assert.deepEqual(f.child.kills,['SIGKILL']);assert.equal(f.options().signal,undefined);
 f.child.emit('close',null,'SIGKILL');await checked;assert(settled);
});
test('success also waits for close and does not mistake exit for closed stdio',async()=>{
 const f=fixture();let settled=false;const p=execFileDrained('fixture',[],{},'source',{execute:f.execute}).then(x=>{settled=true;return x;});
 f.callback(null,'ok');f.child.emit('exit',0,null);await turn();assert.equal(settled,false);f.child.emit('close',0,null);assert.equal(await p,'ok');
});
test('closed process error is propagated with drain evidence; pre-aborted request never spawns',async()=>{
 const f=fixture(),p=execFileDrained('fixture',[],{},'',{execute:f.execute});const checked=assert.rejects(p,e=>e.code==='ENOENT'&&e.drained===true);f.callback(Object.assign(Error('not found'),{code:'ENOENT'}));f.child.emit('close',-2,null);await checked;
 const c=new AbortController();c.abort();await assert.rejects(execFileDrained('fixture',[],{signal:c.signal},'',{execute(){throw Error('must not spawn');}}),e=>e.code==='ABORT_ERR'&&e.drained);
});
test('real aborted child has exited and closed before caller observes rejection',async()=>{
 const c=new AbortController(),events=[];let child;
 const p=execFileDrained(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:c.signal,killSignal:'SIGKILL'},'',{execute:(...args)=>{child=execFile(...args);child.once('spawn',()=>c.abort());child.once('exit',()=>events.push('exit'));child.once('close',()=>events.push('close'));return child;}});
 await assert.rejects(p,e=>e.code==='ABORT_ERR'&&e.drained);events.push('settled');assert.deepEqual(events,['exit','close','settled']);assert.equal(child.signalCode,'SIGKILL');
});
test('real timeout and missing executable do not report success',async()=>{
 await assert.rejects(execFileDrained(process.execPath,['-e','setInterval(()=>{},1000)'],{timeout:50,killSignal:'SIGKILL'},''),e=>e.drained&&e.killed);
 await assert.rejects(execFileDrained('/__s40_missing_program__',[],{},''),e=>e.drained&&e.code==='ENOENT');
});
