import {spawn} from 'node:child_process';
// Own only this child. Never pkill, alter known_hosts, or infer task idleness.
export class SshConnector {
 constructor(c,trace,io={}){
  if(!/^127\.0\.0\.1:\d+:127\.0\.0\.1:\d+$/.test(c.forward)||!/^root@[a-zA-Z0-9.-]+$/.test(c.target)||typeof c.identityFile!=='string')throw Error('INVALID_SSH_CONFIG');
  this.c=c;this.trace=trace;this.spawn=io.spawn??spawn;this.base=io.baseMs??2000;this.cap=io.maxMs??60000;this.failures=0;this.closed=false;this.lastExit=null;this.nextAttempt=null;
 }
 start(){
  if(this.closed||this.child)return;
  this.nextAttempt=null;const c=this.c,started=Date.now();let child;
  try{child=this.spawn('/usr/bin/ssh',['-N','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=8','-o','ServerAliveInterval=30','-o','ServerAliveCountMax=2','-i',c.identityFile,'-L',c.forward,c.target],{stdio:'ignore'});}catch{this.retry();return;}
  this.child=child;
  child.on('error',()=>this.trace('connector-error'));
  child.once('close',code=>{if(this.child===child)this.child=null;this.lastExit={at:Date.now(),code};this.trace('connector-exit',{code});if(Date.now()-started>=60000)this.failures=0;this.retry();});
 }
 retry(){if(this.closed||this.timer)return;const delay=Math.min(this.cap,this.base*2**Math.min(this.failures++,10));this.nextAttempt=Date.now()+delay;this.timer=setTimeout(()=>{this.timer=null;this.start();},delay);this.timer.unref?.();}
 snapshot(){return {state:this.closed?'closed':this.child?'process_running':this.timer?'backoff':'not_started',failures:this.failures,last_exit:this.lastExit,next_attempt_at:this.nextAttempt,proves_application_health:false};}
 close(){
  if(this.closing)return this.closing;
  this.closed=true;clearTimeout(this.timer);const child=this.child;
  this.closing=!child?Promise.resolve():new Promise(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),2000);child.once('close',()=>{clearTimeout(timer);resolve();});child.kill();});
  return this.closing;
 }
}
