import {officialDesktopCarrier,authenticatedOwnerOrigin} from './native-owner-origin.js';
import {decodeImage} from './artifact-media.js';
import {deliveryArtifact,deliveryArtifactList} from './delivery-artifacts.js';
import {mkdirSync,lstatSync,realpathSync,openSync,closeSync,readSync,writeFileSync,fsyncSync,fstatSync,constants} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {validSources} from './task-context.js';
import {digest} from './approval-ledger.js';
import {parseEnvelope} from './task-envelope.js';
import {errorInfo} from './link-contract.js';
const sha=x=>createHash('sha256').update(x).digest('hex');
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const validText=(v,n)=>typeof v==='string'&&v.length>0&&v.length<=n;
const description=v=>{if(v===undefined)return null;if(!validText(v,600)||!v.trim()||/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(v))throw Error('ARTIFACT_INVALID_DESCRIPTION');return v;};
const identity=s=>`${s.dev}:${s.ino}`;
const secure=s=>s.uid===process.getuid()&&!(s.mode&0o077)&&!s.isSymbolicLink();
export function artifactName(name){
 if(!validText(name,120)||name!==name.trim()||/[\\/:*?"<>|\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(name)||/^[.]|[. ]$/.test(name)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name))throw Error('ARTIFACT_INVALID_NAME');
 return name;
}
// Authority is the cloud task + persisted run/repository generation, not a model-supplied path.
export class TaskArtifacts {
 constructor(g){
  this.g=g;this.db=g.store.db;this.pending=new Set();this.closed=false;this.sessionReads=0;
  this.root=join(g.c.stateDir,'artifacts');mkdirSync(this.root,{recursive:true,mode:0o700});
  const s=lstatSync(this.root);if(!s.isDirectory()||!secure(s)||(s.mode&0o700)!==0o700)throw Error('ARTIFACT_DIRECTORY_UNSAFE');
  this.rootIdentity=identity(s);this.canonical=realpathSync(this.root);
  this.db.exec(`CREATE TABLE IF NOT EXISTS task_artifacts(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,event_id TEXT UNIQUE NOT NULL,fingerprint TEXT NOT NULL,record TEXT NOT NULL); CREATE INDEX IF NOT EXISTS artifacts_by_task ON task_artifacts(task_id);`);
 }
 assertOpen(){if(this.closed||this.g.closed)throw Error('ARTIFACT_CLOSED');}
 head(task){this.assertOpen();const r=this.db.prepare('SELECT * FROM task_catalog WHERE task_id=?').get(task);if(!r||r.legacy)throw Error('ARTIFACT_TASK_UNAVAILABLE');return r;}
 rootCheck(){const s=lstatSync(this.root);if(!s.isDirectory()||!secure(s)||(s.mode&0o700)!==0o700||identity(s)!==this.rootIdentity||realpathSync(this.root)!==this.canonical)throw Error('ARTIFACT_DIRECTORY_UNSAFE');}
 existing(event,fp){const r=this.db.prepare('SELECT * FROM task_artifacts WHERE event_id=?').get(event);if(!r)return null;if(r.fingerprint!==fp)throw Error('ARTIFACT_EVENT_CONFLICT');return JSON.parse(r.record);}
 insert(event,fp,r){
  if(this.db.prepare('SELECT COUNT(*) n FROM task_artifacts WHERE task_id=?').get(r.task_id).n>=100)throw Error('ARTIFACT_LIMIT');
  this.db.prepare('INSERT INTO task_artifacts VALUES (?,?,?,?,?)').run(r.id,r.task_id,event,fp,JSON.stringify(r));return this.dto(r);
 }
 load(task,id){this.assertOpen();if(!validText(task,128)||!validText(id,128))throw Error('ARTIFACT_NOT_FOUND');if(id.startsWith('artifact-delivery-')){const r=deliveryArtifact(this.g,task,id);if(!r)throw Error('ARTIFACT_DELIVERY_EVIDENCE_INVALID');return r;}const r=this.db.prepare('SELECT record FROM task_artifacts WHERE id=? AND task_id=?').get(id,task);if(!r)throw Error('ARTIFACT_NOT_FOUND');return JSON.parse(r.record);}
 eligibility(r){
  if(this.head(r.task_id).spec_revision!==r.spec_revision)return 'stale_revision';
  if(r.kind==='gitee_delivery'){
   const current=deliveryArtifact(this.g,r.task_id,r.id);
   if(!current||current.sha256!==r.sha256)return 'delivery_evidence_invalid';
   if(!this.g.repositories.matches(r.task_id,r.repository_origin.binding_revision,r.repository_origin))return 'repository_changed';
   return 'needs_verification';
  }
  if(r.kind==='report'){
   const run=this.g.scheduler?.jobs.db.prepare('SELECT r.*,j.task_id,j.kind FROM runs r JOIN jobs j ON j.id=r.job_id WHERE r.id=?').get(r.run_id);
   if(!run||run.task_id!==r.task_id||run.claim!==r.claim)return 'owner_mismatch';
   if(run.kind==='development'){const state=developmentArtifactState(this.db,run);if(state)return state;}
   if(run.status!=='completed')return run.status==='running'?'pending_run':'failed_run';
  }else if(!this.g.repositories.matches(r.task_id,r.repository.binding_revision,r.repository))return 'repository_changed';
  return 'needs_verification';
 }
 dto(r){const delivered=r.kind==='gitee_delivery';return {id:r.id,task_id:r.task_id,name:r.name,description:r.description??null,description_source:delivered?'delivery_ledger':r.description?(r.kind==='gitee'?'direct_user':'worker'):'not_provided',kind:r.kind,size:r.size,sha256:r.sha256,created_at:r.created_at,spec_revision:r.spec_revision,run_id:r.run_id??null,source:delivered?'verified_delivery_journal':r.kind==='report'?'worker_report_file':'user_linked_gitee_file',repository:r.kind==='gitee'||delivered?{url:r.repository.url,commit:r.repository.base_sha,path:r.path??null,branch:r.repository.branch,binding_revision:r.repository.binding_revision}:null,state:this.eligibility(r),verified_at_registration:delivered?null:r.created_at,requires_live_check:true,...(delivered?{digest_kind:'delivery_ledger_evidence',registration:'durable_journal_projection',delivery:r.delivery}:{}),...(r.source_evidence?.length?{source_evidence:r.source_evidence}: {})};}
 list(task){this.assertOpen();this.g.store.task(task);const delivery=deliveryArtifactList(this.g,task),stored=this.db.prepare('SELECT record FROM task_artifacts WHERE task_id=? ORDER BY rowid DESC LIMIT 100').all(task).map(r=>JSON.parse(r.record));
  const items=[...stored,...delivery.items].sort((a,b)=>b.created_at-a.created_at).slice(0,100).map(r=>this.dto(r)),invalid=Math.min(delivery.total,100)-delivery.items.length;
  return {state:items.length?'registered':delivery.error||invalid?'evidence_unavailable':'not_registered',items,downloadable:[],development_enabled:false,publish_enabled:false,
   ...(delivery.total||delivery.error?{delivery_unavailable:invalid,delivery_error:delivery.error??null,truncated:stored.length+delivery.total>100}: {})};}
 registerReport(worker,agent,a,callId){
  this.assertOpen();const b=worker.binding(agent),job=b.job,h=this.head(job.task_id);
  if(b.report)throw Error('ARTIFACT_REPORT_ALREADY_FINAL');
  const revision=parseEnvelope(job.goal)?.task_context?.spec_revision??1;
  if(revision!==h.spec_revision)throw Error('ARTIFACT_STALE_REVISION');
  if(!object(a)||Object.keys(a).some(k=>!['name','format','content','description','evidence_ids'].includes(k))||!['markdown','text','json','csv','png','jpeg'].includes(a.format)||typeof a.content!=='string'||!validText(callId,256))throw Error('ARTIFACT_INVALID_ARGUMENT');
  const suffix={markdown:'.md',text:'.txt',json:'.json',csv:'.csv',png:'.png',jpeg:'.jpg'}[a.format],name=artifactName(a.name);
  if(!name.endsWith(suffix))throw Error('ARTIFACT_INVALID_NAME');
  const bytes=['png','jpeg'].includes(a.format)?decodeImage(a.format,a.content):Buffer.from(a.content,'utf8');if(bytes.length>262144)throw Error('ARTIFACT_TOO_LARGE');
  if(a.format==='json')try{JSON.parse(a.content);}catch{throw Error('ARTIFACT_INVALID_CONTENT');}
  const intro=description(a.description);
  if(a.evidence_ids!==undefined&&!this.g.sources)throw Error('SOURCE_CAPABILITY_UNAVAILABLE');
  const sourceEvidence=a.evidence_ids===undefined?[]:this.g.sources.evidence(job,a.evidence_ids);
  const evidence=sourceEvidence.length?{source_evidence:sourceEvidence}:{};
  const event='worker:'+job.run_id+':'+callId,fp=digest({task:job.task_id,revision,claim:job.claim,name,description:intro,format:a.format,...evidence,...(intro?{description:intro}:{}),hash:sha(bytes)}),old=this.existing(event,fp);
  if(old)return {...this.dto(old),replayed:true};
  if(this.db.prepare('SELECT COUNT(*) n FROM task_artifacts WHERE task_id=?').get(job.task_id).n>=100||this.db.prepare('SELECT COUNT(*) n FROM task_artifacts WHERE json_extract(record,\'$.run_id\')=?').get(job.run_id).n>=8)throw Error('ARTIFACT_LIMIT');
  this.rootCheck();const id='artifact-'+sha(event).slice(0,40),path=join(this.root,id+'.bin');let fd;
  try{fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeFileSync(fd,bytes);fsyncSync(fd);}catch(e){if(e.code!=='EEXIST')throw Error('ARTIFACT_STORE_UNAVAILABLE');}finally{if(fd!==undefined)closeSync(fd);}
  // Orphans after a crash are admitted only when the immutable bytes still match.
  const r={id,task_id:job.task_id,kind:'report',spec_revision:revision,run_id:job.run_id,claim:job.claim,name,description:intro,format:a.format,...evidence,size:bytes.length,sha256:sha(bytes),created_at:this.g.now()};
  const info=this.readLocal(r);r.file_identity=info.identity;worker.binding(agent);return this.insert(event,fp,r);
 }
 readLocal(r){
  let fd;try{
   this.rootCheck();fd=openSync(join(this.root,r.id+'.bin'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const s=fstatSync(fd);
   if(!s.isFile()||!secure(s)||s.nlink!==1||!(s.mode&0o400))throw Error('ARTIFACT_FILE_PERMISSIONS');
   if(r.file_identity&&identity(s)!==r.file_identity)throw Error('ARTIFACT_FILE_REPLACED');
   if(s.size!==r.size||s.size>262144)throw Error('ARTIFACT_FILE_CHANGED');
   const buffer=Buffer.alloc(r.size+1);let offset=0,n;while(offset<buffer.length&&(n=readSync(fd,buffer,offset,buffer.length-offset,null)))offset+=n;const bytes=buffer.subarray(0,offset),after=fstatSync(fd);this.rootCheck();
   if(!secure(after)||!(after.mode&0o400)||after.nlink!==1||identity(after)!==identity(s)||after.size!==s.size||after.mtimeMs!==s.mtimeMs||sha(bytes)!==r.sha256)throw Error('ARTIFACT_FILE_CHANGED');
   return {bytes,identity:identity(s)};
  }catch(e){if(e.code==='ENOENT')throw Error('ARTIFACT_FILE_MISSING');if(['EACCES','EPERM','ELOOP'].includes(e.code))throw Error('ARTIFACT_FILE_PERMISSIONS');throw Error(/^ARTIFACT_/.test(e.message)?e.message:'ARTIFACT_STORE_UNAVAILABLE');}finally{if(fd!==undefined)closeSync(fd);}
 }
 async registerGitee(node,a){
  if(!object(a)||Object.keys(a).some(k=>!['task_id','expected_revision','expected_binding_revision','path','event_id','sources','context_message_ids','description'].includes(k)))throw Error('ARTIFACT_INVALID_ARGUMENT');
  const h=this.head(a.task_id),sources=validSources(a.sources),intro=description(a.description);
  if(intro&&!sources.some(s=>s.text.includes(intro)))throw Error('ARTIFACT_DESCRIPTION_NOT_IN_USER_CONTEXT');
  if(!['local','cloud'].includes(node)||!sources.length||sources.some(s=>s.role!==node)||!validText(a.event_id,256)||!validText(a.path,500)||!sources.some(s=>s.text.includes(a.path)))throw Error('ARTIFACT_REFERENCE_NOT_IN_USER_CONTEXT');
  if(h.spec_revision!==a.expected_revision)throw Error('ARTIFACT_STALE_REVISION');
  const repo=this.g.repositories.status(a.task_id);if(repo.state!=='bound')throw Error('ARTIFACT_REPOSITORY_NOT_BOUND');
  if(repo.binding_revision!==a.expected_binding_revision)throw Error('ARTIFACT_REPOSITORY_CHANGED');
  const name=artifactName(a.path.split('/').at(-1)),event='gitee:'+node+':'+a.event_id,fp=digest({task:a.task_id,revision:a.expected_revision,binding:a.expected_binding_revision,path:a.path,sources,...(intro?{description:intro}:{})}),old=this.existing(event,fp);
  if(old)return {...this.dto(old),replayed:true};
  const file=await this.g.repositories.provider.file(repo.repository,a.path);this.assertOpen();
  if(this.head(a.task_id).spec_revision!==a.expected_revision||!this.g.repositories.matches(a.task_id,repo.binding_revision,repo.repository))throw Error('ARTIFACT_SOURCE_CHANGED_DURING_CHECK');
  const concurrent=this.existing(event,fp);if(concurrent)return {...this.dto(concurrent),replayed:true};
  return this.insert(event,fp,{id:'artifact-'+sha(event).slice(0,40),task_id:a.task_id,kind:'gitee',name,description:intro,path:a.path,repository:repo.repository,spec_revision:a.expected_revision,size:file.bytes.length,sha256:sha(file.bytes),blob_sha:file.blob_sha,created_at:this.g.now(),sources});
 }
 async sessionExists(id){
  const q=this.g.ctx?.get?.('sessionQuery');if(!q?.listSessions||this.sessionReads>=2)throw Error('ARTIFACT_SESSION_UNAVAILABLE');
  const controller=new AbortController();let timer;this.sessionReads++;
  const read=Promise.resolve().then(()=>q.listSessions(controller.signal)).finally(()=>{this.sessionReads--;});
  try{
   const records=await Promise.race([read,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('ARTIFACT_SESSION_UNAVAILABLE'));},2000);})]);this.assertOpen();
   if(!Array.isArray(records)||!records.some(s=>s.header?.id===id&&s.persisted&&(!s.formatStatus||s.formatStatus==='current')))throw Error('ARTIFACT_SESSION_UNAVAILABLE');
  }catch(e){this.assertOpen();throw Error('ARTIFACT_SESSION_UNAVAILABLE');}finally{clearTimeout(timer);}
 }
 async access(a){
  if(!object(a)||Object.keys(a).some(k=>!['task_id','artifact_id','action'].includes(k))||!['check','session','gitee'].includes(a.action))throw Error('ARTIFACT_INVALID_ARGUMENT');
  const r=this.load(a.task_id,a.artifact_id),item=this.dto(r),respond=(state,extra={})=>({artifact:{...item,state},checked_at:this.g.now(),...extra});
  if(item.state!=='needs_verification')return respond(item.state);
  try{
   if(r.kind==='gitee_delivery'){
    if(a.action==='session')throw Error('ARTIFACT_ACTION_UNAVAILABLE');
    const commit=await this.g.repositories.provider.commit(r.repository,r.delivery);this.assertOpen();
    const state=this.eligibility(r);if(state!=='needs_verification')return respond(state);
    return respond('verified',{...(a.action==='gitee'?{url:commit.url,browser_login:'independent; no service credential forwarded'}:{})});
   }
   const file=r.kind==='report'?this.readLocal(r):await this.g.repositories.provider.file(r.repository,r.path);this.assertOpen();
   const state=this.eligibility(r);if(state!=='needs_verification')return respond(state);
   if(sha(file.bytes)!==r.sha256||file.bytes.length!==r.size||r.kind==='gitee'&&file.blob_sha!==r.blob_sha)return respond('file_changed');
   if(a.action==='gitee'&&r.kind!=='gitee'||a.action==='session'&&r.kind!=='report')throw Error('ARTIFACT_ACTION_UNAVAILABLE');
   let session_id;
   if(a.action==='session'){
    session_id=this.g.scheduler?.jobs.db.prepare("SELECT r.session_id FROM runs r JOIN jobs j ON j.id=r.job_id WHERE r.id=? AND r.claim=? AND j.task_id=? AND r.status='completed'").get(r.run_id,r.claim,r.task_id)?.session_id;
    if(!/^task-worker-[a-f0-9-]{36}$/.test(session_id??''))throw Error('ARTIFACT_SESSION_UNAVAILABLE');
    await this.sessionExists(session_id);const current=this.eligibility(r);if(current!=='needs_verification')return respond(current);this.readLocal(r);
   }
   return respond('verified',{...(session_id?{session_id}:{}),...(a.action==='gitee'?{url:file.url,browser_login:'independent; no service credential forwarded'}:{})});
  }catch(e){this.assertOpen();const code=errorInfo(e).code;return respond('unavailable',{error:code});}
 }
 download(a){
  if(!object(a)||Object.keys(a).some(k=>!['task_id','artifact_id','expected_revision','expected_sha256'].includes(k))||!Number.isInteger(a.expected_revision)||a.expected_revision<1||!/^([a-f0-9]{64})$/.test(a.expected_sha256??''))throw Error('ARTIFACT_INVALID_ARGUMENT');
  const r=this.load(a.task_id,a.artifact_id);
  if(r.kind!=='report')throw Error('ARTIFACT_PAGE_ONLY');
  if(r.id!==a.artifact_id||r.task_id!==a.task_id||!/^artifact-[a-f0-9]{40}$/.test(r.id))throw Error('ARTIFACT_NOT_FOUND');
  artifactName(r.name);
  if(this.eligibility(r)!=='needs_verification'||r.spec_revision!==a.expected_revision||r.sha256!==a.expected_sha256)throw Error('ARTIFACT_STALE_DOWNLOAD');
  const {bytes}=this.readLocal(r);this.assertOpen();
  if(this.eligibility(r)!=='needs_verification')throw Error('ARTIFACT_STALE_DOWNLOAD');
  return {artifact:{...this.dto(r),state:'verified'},checked_at:this.g.now(),encoding:'base64',content:bytes.toString('base64'),mime:'application/octet-stream',disposition:'attachment',grants_execution:false};
 }
 call(method,args,node){
  this.assertOpen();if(this.pending.size>=8)throw Error('ARTIFACT_REQUEST_LIMIT');const p=Promise.resolve().then(()=>{this.assertOpen();if(method==='artifact_download')return this.download(args);if(method==='artifact_list')return this.list(args.task_id);if(method==='artifact_register_gitee')return this.registerGitee(node,args);if(method==='artifact_access')return this.access(args);throw Error('METHOD_DENIED');});
  this.pending.add(p);p.then(()=>this.pending.delete(p),()=>this.pending.delete(p));return p;
 }
 async close(){this.closed=true;await Promise.allSettled([...this.pending]);}
}
export function installArtifactAccess(ctx,g){
 ctx.inject(['connection'],sub=>sub.connection.fetch.register({path:'/api/task-artifacts/control',methods:['POST'],requestBody:'buffered',async fetch(request){
  let b;try{b=await request.json();}catch{return new Response('bad request',{status:400});}
  if(!object(b)||b.type!=='client-request'||!validText(b.rpcId,128)||b.method!=='task-artifacts/control'||!object(b.payload))return new Response('bad request',{status:400});
  let result;try{if(!['check','session','gitee','download'].includes(b.payload.method)||!object(b.payload.args))throw Error('METHOD_DENIED');
   if(b.payload.method==='download'){
    if(!authenticatedOwnerOrigin(request,{desktop:officialDesktopCarrier(),serverOrigin:sub.get?.('webServer')?.getOrigin?.()}))throw Error('ARTIFACT_BROWSER_ORIGIN_REQUIRED');
   }
   result={ok:true,value:await g.call(b.payload.method==='download'?'artifact_download':'artifact_access',b.payload.method==='download'?b.payload.args:{...b.payload.args,action:b.payload.method})};}catch(e){result={ok:false,error:{code:errorInfo(e).code,message:'成果访问未通过核验；本次未提供文件或入口。',details:{}}};}
  return Response.json({type:'server-response',rpcId:b.rpcId,result},{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 }}));
}

// Read durable development authority even when the optional runtime is currently disabled.
function developmentArtifactState(db,run){
 const has=t=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
 if(!has('development_requests')||!has('development_jobs'))return 'owner_mismatch';
 const r=db.prepare('SELECT r.state,r.task_id FROM development_requests r JOIN development_jobs j ON j.request_id=r.id WHERE j.job_id=?').get(run.job_id);
 if(!r||r.task_id!==run.task_id)return 'owner_mismatch';
 return r.state==='completed'?null:r.state==='active'?'pending_run':'failed_run';
}
