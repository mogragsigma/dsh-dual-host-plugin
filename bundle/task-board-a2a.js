// A display must not invoke TaskA2A.list/reap, migrate a catalog row or inspect unrelated session logs.
const has=(db,t)=>!!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const parse=(s,f=null)=>{try{return JSON.parse(s);}catch{return f;}};
const text=(s,n=4000)=>typeof s==='string'?s.slice(0,n):null;
const code=s=>/^A2A_[A-Z_]{1,80}$/.test(s??'')?s:s?'A2A_STATE_UNAVAILABLE':null;
const policy=p=>p&&typeof p==='object'?{provider:text(p.provider,128),model:text(p.model,128),reasoningEffort:text(p.reasoningEffort,128)}:null;
const terminal=new Set(['completed','revoked','invalidated']);
function state(w,rows,now){
 if(rows.some(r=>['running','stopping'].includes(r.state)&&r.drained_at===null))return w.status==='active'&&w.end_at>now&&rows.every(r=>r.deadline>now||r.state==='completed')?'a2a_running':'a2a_draining';
 if(rows.some(r=>r.state==='needs_review'&&r.drained_at===null))return 'a2a_drain_unknown';
 if(terminal.has(w.status))return 'a2a_'+w.status;
 if(w.status==='needs_review')return 'a2a_needs_review';
 if(w.end_at<=now)return 'a2a_expired';
 if(w.status==='paused')return 'a2a_paused';
 if(w.status==='waiting_input')return 'a2a_waiting_input';
 if(w.status!=='active')return 'a2a_unknown';
 if(rows.some(r=>r.deadline<=now&&['queued','claimed'].includes(r.state)))return 'a2a_expired';
 return rows.some(r=>['queued','claimed'].includes(r.state))?'a2a_queued':'a2a_authorized';
}
const result=s=>{const r=parse(s);return r?{summary:text(r.summary),followup:text(r.followup),evidence:(Array.isArray(r.evidence)?r.evidence:[]).slice(0,8).map(e=>({host:e.host,title:text(e.title,500),format:text(e.format,20),size:e.size,sha256:text(e.sha256,64),read_at:e.read_at}))}:null;};
export function a2aSnapshot(g,task,revision,detail=true){
 const db=g.db??g.store?.db,available=has(db,'a2a_grants')&&has(db,'a2a_requests');
 if(!available)return {available:false,total:0,items:[],current:null,read_only:true};
 const total=db.prepare('SELECT count(*) n FROM a2a_grants WHERE task_id=?').get(task).n;
 const grants=db.prepare("SELECT * FROM a2a_grants WHERE task_id=? ORDER BY CASE WHEN revision=? THEN 0 WHEN status IN ('completed','revoked','invalidated') THEN 2 ELSE 1 END,created DESC,rowid DESC LIMIT 20").all(task,revision??-1);
 const items=grants.map(w=>{
  const scope=parse(w.scope,{})??{},rows=db.prepare('SELECT * FROM a2a_requests WHERE grant_id=? ORDER BY created,rowid LIMIT 12').all(w.id);
  return {id:w.id,spec_revision:w.revision,created:w.created,recorded_state:w.status,state:state(w,rows,g.now()),reason:code(w.reason),budget:{turns:w.used_turns,max_turns:w.max_turns,model_requests:w.used_requests,max_model_requests:w.max_requests,end_at:w.end_at},models:{local:policy(scope.local?.model_policy),cloud:policy(scope.cloud?.model_policy)},
   requests:detail?rows.map(r=>({id:r.id,parent_id:r.parent_id,from:r.origin,to:r.destination,state:r.state,created:r.created,deadline:r.deadline,drained:r.drained_at!==null,error:code(r.error),session_id:/^a2a-[a-f0-9-]{36}$/.test(r.session_id??'')?r.session_id:null,result:result(r.result),late_result:result(r.late_result),model_calls:has(db,'a2a_model_observations')?db.prepare('SELECT record FROM a2a_model_observations WHERE request_id=? ORDER BY rowid LIMIT 6').all(r.id).map(x=>{const m=parse(x.record,{});return {provider:text(m.provider,128),model:text(m.model,128),reasoningEffort:text(m.reasoningEffort,128),stage:text(m.stage,40),finish_kind:text(m.finish_kind,40),started_at:m.started_at,ended_at:m.ended_at,error_code:code(m.error_code)};}):[]})):[]};
 });
 const current=items.find(w=>w.spec_revision===revision);
 return {available,total,display_limit:20,items:detail?items:[],current:current?{id:current.id,state:current.state,reason:current.reason,budget:current.budget}:null,read_only:true};
}
export function a2aDisplayState(existing,a){return ['registered','completed','cancelled'].includes(existing)&&a.current?a.current.state:existing;}
// Exact endpoint ownership. Never accept a user-supplied native session solely by its prefix.
export function ownedA2ASession(g,id){
 if(typeof id!=='string'||!/^a2a-[a-f0-9-]{36}$/.test(id))return null;
 const db=g.a2aEndpoint?.db;if(!has(db,'endpoint_requests'))return null;
 const row=db.prepare("SELECT id,item FROM endpoint_requests WHERE json_extract(item,'$.session_id')=? LIMIT 1").get(id),i=parse(row?.item);
 return i&&i.id===row.id&&i.to===g.c.role&&i.task_id&&i.session_id===id?{task_id:i.task_id,request_id:i.id,session_id:id,role:g.c.role}:null;
}
export async function a2aSession(ctx,g,args){
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['task_id','request_id','session_id'].includes(k)))throw Error('WORKBENCH_SESSION_NOT_FOUND');
 const owned=ownedA2ASession(g,args.session_id);
 if(!owned||owned.task_id!==args.task_id||owned.request_id!==args.request_id)throw Error('WORKBENCH_SESSION_NOT_FOUND');
 const q=ctx.get('sessionQuery');if(!q?.readSession)throw Error('WORKBENCH_SESSION_UNAVAILABLE');
 // Public read API checks existence; body stays on the Host, never returned by this route.
 let timer;try{if(!await Promise.race([q.readSession(owned.session_id),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error()),2000);})]))throw Error();}catch{throw Error('WORKBENCH_SESSION_NOT_FOUND');}finally{clearTimeout(timer);}
 return owned;
}
export function a2aRecentRuns(g){
 const db=g.db??g.store?.db;if(!has(db,'a2a_grants')||!has(db,'a2a_requests'))return {available:false,items:[]};
 const rows=db.prepare("SELECT r.id,r.session_id,r.destination,r.state,r.created,r.drained_at,w.task_id,w.revision,w.scope FROM a2a_requests r JOIN a2a_grants w ON w.id=r.grant_id WHERE r.session_id IS NOT NULL ORDER BY r.created DESC,r.rowid DESC LIMIT 20").all();
 return {available:true,items:rows.map(r=>({id:r.id,task_id:r.task_id,spec_revision:r.revision,title:g.board?.head(r.task_id)?.title??'协作任务',session_id:r.session_id,to:r.destination,state:r.state,created:r.created,drained:r.drained_at!==null,requested_model:policy((parse(r.scope,{})??{})[r.destination]?.model_policy)}))};
}
