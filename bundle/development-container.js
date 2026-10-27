import {mkdirSync,realpathSync,lstatSync,rmSync,readFileSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {join,resolve} from 'node:path';
import {execFileDrained} from './drained-process.js';
import {workspacePlan} from './development-plan.js';
import {digest} from './approval-ledger.js';

// An installed, operator-approved local daemon is a prerequisite, never auto-installed.
// The source checkout, .git, model credentials and daemon socket are NOT mounted.
export class DevelopmentContainer {
 constructor({directory,docker='/usr/bin/docker'}){
  if(process.platform!=='linux')throw Error('DEVELOPMENT_CONTAINER_UNAVAILABLE');
  if(typeof directory!=='string'||!directory.startsWith('/')||/[:,\n\r]/.test(directory)||docker!=='/usr/bin/docker')throw Error('DEVELOPMENT_CONTAINER_CONFIG');
  this.directory=resolve(directory);mkdirSync(this.directory,{recursive:true,mode:0o700});
  if(realpathSync(this.directory)!==this.directory||!lstatSync(this.directory).isDirectory())throw Error('DEVELOPMENT_CONTAINER_CONFIG');
  const allowed=/^Cpus_allowed_list:\s*(\d+)/m.exec(readFileSync('/proc/self/status','utf8'));
  if(!allowed)throw Error('DEVELOPMENT_CONTAINER_CPU_UNAVAILABLE');this.cpu=allowed[1];
  this.docker=docker;this.config=join(this.directory,'docker-config');mkdirSync(this.config,{recursive:true,mode:0o700});
 }
 async cli(args,options={}){
  return execFileDrained(this.docker,['--host','unix:///var/run/docker.sock',...args],{
   env:{PATH:'/usr/bin:/bin',HOME:this.directory,DOCKER_CONFIG:this.config},timeout:15000,maxBuffer:1048576,killSignal:'SIGKILL',...options},undefined,{execute:(file,args,opts,callback)=>execFile(file,args,opts,(error,out,err)=>callback(error?Object.assign(error,{stdout:out,stderr:err}):null,out))});
 }
 name(operation){if(!/^operation-[a-f0-9-]{36}$/.test(operation))throw Error('DEVELOPMENT_OPERATION_ID_INVALID');return 'dsh-build-'+operation.slice(10);}
 async inspect(name,operation,commandHash){
  const rows=JSON.parse(await this.cli(['inspect','--type','container',name]));const c=rows?.[0];
  if(rows?.length!==1||!c?.Id||c.Config?.Labels?.['dsh.operation']!==operation||c.Config?.Labels?.['dsh.command']!==commandHash)throw Error('DEVELOPMENT_CONTAINER_IDENTITY_CHANGED');
  return c;
 }
 // Operator review targets an already recorded immutable ID, never discovers by
 // PID/name or treats a failed inspect as proof of absence/drain.
 async observeForReview({operation,container_id,command}){
  if(!/^[a-f0-9]{64}$/.test(container_id??''))throw Error('DEVELOPMENT_CONTAINER_IDENTITY_CHANGED');
  const c=await this.inspect(container_id,operation,digest(command)),s=c.State;
  if(c.Id!==container_id||c.Name!=='/'+this.name(operation)||c.Image!==command.image||
     c.HostConfig?.RestartPolicy?.Name!=='no'||c.HostConfig?.AutoRemove!==false||c.RestartCount!==0)
   throw Error('DEVELOPMENT_CONTAINER_IDENTITY_CHANGED');
  if(!s||s.Dead!==false||s.Paused!==false||s.Restarting!==false||
     !Number.isFinite(Date.parse(s.StartedAt))||s.StartedAt.startsWith('0001-')||
     !(s.Status==='running'&&s.Running===true&&Number.isInteger(s.Pid)&&s.Pid>0||
       s.Status==='exited'&&s.Running===false&&s.Pid===0&&Number.isInteger(s.ExitCode)&&Number.isFinite(Date.parse(s.FinishedAt))&&!s.FinishedAt.startsWith('0001-')))
   throw Error('DEVELOPMENT_CONTAINER_DRAIN_UNKNOWN');
  return {container_id:c.Id,operation,command_hash:digest(command),image:c.Image,status:s.Status,
   started_at:s.StartedAt,finished_at:s.Status==='exited'?s.FinishedAt:null,exit_code:s.Status==='exited'?s.ExitCode:null};
 }
 async stopForReview(target,{stop_running=false,started_at}={}){
  let observed=await this.observeForReview(target);
  if(observed.started_at!==started_at)throw Error('DEVELOPMENT_CONTAINER_IDENTITY_CHANGED');
  if(observed.status==='running'){
   if(!stop_running)throw Error('DEVELOPMENT_CONTAINER_STOP_CONFIRMATION_REQUIRED');
   await this.cli(['kill','--signal','KILL',target.container_id]);
   await this.cli(['wait',target.container_id]);
   observed=await this.observeForReview(target);
  }
  if(observed.status!=='exited'||observed.started_at!==started_at)throw Error('DEVELOPMENT_CONTAINER_DRAIN_UNKNOWN');
  return observed;
 }
 async cleanupReviewed(target,started_at){
  const observed=await this.observeForReview(target);
  if(observed.status!=='exited'||observed.started_at!==started_at)throw Error('DEVELOPMENT_CONTAINER_DRAIN_UNKNOWN');
  // No --force: a concurrently restarted container must not be silently removed.
  await this.cli(['rm',target.container_id]);
  rmSync(join(this.directory,this.name(target.operation)),{recursive:true,force:true});
 }
 async run(workspace,expectedHash,commandId,{operation,signal,onCreated=()=>{},onClosed=()=>{}}){
  const spec=workspacePlan(workspace.spec),command=spec.commands.find(c=>c.id===commandId);
  if(!command)throw Object.assign(Error('DEVELOPMENT_COMMAND_DENIED'),{drained:true});
  if(signal?.aborted)throw Object.assign(Error('DEVELOPMENT_COMMAND_CANCELLED'),{drained:true});
  const name=this.name(operation),commandHash=digest(command),dir=join(this.directory,name),snapshot=join(dir,'source');
  let created=false,closed=false,container=null;
  try{
   const image=JSON.parse(await this.cli(['image','inspect',command.image]))?.[0];
   if(image?.Id!==command.image||Object.keys(image.Config?.Volumes??{}).length)throw Error('DEVELOPMENT_IMAGE_UNAVAILABLE');
   mkdirSync(dir,{recursive:false,mode:0o755});workspace.snapshot(expectedHash,snapshot);
   const args=['create','--name',name,'--pull','never','--restart','no','--network','none','--read-only',
    '--cap-drop','ALL','--security-opt','no-new-privileges:true','--user','65534:65534','--init','--no-healthcheck',
    '--pids-limit','64','--memory','256m','--memory-swap','256m','--cpuset-cpus',this.cpu,'--shm-size','8m',
    '--ulimit','nofile=128:128','--ulimit','core=0:0','--log-driver','local','--log-opt','max-size=1m','--log-opt','max-file=1','--log-opt','compress=false',
    '--mount',`type=bind,src=${snapshot},dst=/work,readonly`,
    '--tmpfs','/out:rw,nosuid,nodev,size=64m,mode=1777','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777',
    '--env','HOME=/tmp','--env','TMPDIR=/tmp','--env','PYTHONDONTWRITEBYTECODE=1','--env','PYTHONPYCACHEPREFIX=/out/pycache',
    '--workdir',command.cwd==='.'?'/work':'/work/'+command.cwd,
    '--label','dsh.operation='+operation,'--label','dsh.command='+commandHash,
    '--entrypoint',command.argv[0],command.image,...command.argv.slice(1)];
   // Set before create: a failed client response may still have created the container.
   created=true;await this.cli(args);container=await this.inspect(name,operation,commandHash);onCreated({id:container.Id,name});
   let output='',stderr='',error=null,startAttempted=false;
   if(!signal?.aborted){startAttempted=true;try{output=await this.cli(['start','--attach',container.Id],{timeout:command.timeout_ms,maxBuffer:65536,signal});}
    catch(e){error=e;output=typeof e.stdout==='string'?e.stdout.slice(0,65536):'';stderr=typeof e.stderr==='string'?e.stderr.slice(0,65536):'';}}
   else error=Error('DEVELOPMENT_COMMAND_CANCELLED');
   // Closing the docker client is NOT proof the workload or its descendants stopped.
   let state=await this.inspect(name,operation,commandHash);
   if(state.State?.Running){await this.cli(['kill','--signal','KILL',state.Id]);await this.cli(['wait',state.Id]);state=await this.inspect(name,operation,commandHash);}
   if((startAttempted&&state.State?.Status==='created')||state.State?.Running!==false||state.State?.Pid!==0||!['exited','created'].includes(state.State?.Status))throw Error('DEVELOPMENT_CONTAINER_DRAIN_UNKNOWN');
   closed=true;onClosed({code:state.State.ExitCode??null,signal:signal?.aborted?'ABORT':error?'LIMIT':null,container_id:state.Id});
   const passed=!error&&!signal?.aborted&&state.State.Status==='exited'&&state.State.ExitCode===0&&!state.State.OOMKilled;
   workspace.check(expectedHash);
   return {command_id:command.id,command_hash:commandHash,image:command.image,file_hash:expectedHash,passed,exit_code:state.State.ExitCode,
    code:signal?.aborted?'DEVELOPMENT_COMMAND_CANCELLED':state.State.OOMKilled?'DEVELOPMENT_COMMAND_MEMORY_LIMIT':state.State.Error?'DEVELOPMENT_COMMAND_START_FAILED':error?.killed||error?.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'?'DEVELOPMENT_COMMAND_LIMIT':passed?'DEVELOPMENT_COMMAND_PASSED':'DEVELOPMENT_COMMAND_FAILED',
    output,stderr,container_id:state.Id,started:!!state.State.StartedAt&&!state.State.StartedAt.startsWith('0001-'),drained:true};
  }catch(e){
   // Unknown daemon/start state stays fenced, and the exact named container is kept
   // for explicit review. Never infer "not created" from an inspect/network failure.
   throw Object.assign(Error(/^DEVELOPMENT_[A-Z_]+$/.test(e.message)?e.message:'DEVELOPMENT_CONTAINER_UNAVAILABLE'),{drained:!created||closed});
  }finally{
   if(closed&&container){try{await this.inspect(name,operation,commandHash);await this.cli(['rm',container.Id]);rmSync(dir,{recursive:true,force:true});}catch{/* Retain evidence; the verified stop is not invalidated by cleanup failure. */}}
   else if(!created){try{rmSync(dir,{recursive:true,force:true});}catch{}}
  }
 }
}
