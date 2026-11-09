// Deterministic closeout journal. No model, retry loop, new delivery engine or
// inference of completion from files. The worker must explicitly declare ready.
import {snapshotFile} from './managed-development.js';
const json=JSON.stringify;
const fail=s=>{throw Error('TASK_EXECUTION_'+s);};
const binding=b=>({task_id:b.item.task_id,claim:b.item.claim,instance_id:b.item.instance});
export class ManagedCloseout {
 constructor(endpoint){this.e=endpoint;this.db=endpoint.db;this.db.exec('CREATE TABLE IF NOT EXISTS managed_closeouts(claim TEXT PRIMARY KEY,record TEXT NOT NULL,state TEXT NOT NULL,error TEXT)');}
 get(claim){const r=this.db.prepare('SELECT * FROM managed_closeouts WHERE claim=?').get(claim);return r?{...r,record:JSON.parse(r.record)}:null;}
 async intent(b,a){
  if(!b.originalComplete)fail('ORIGINAL_CONTEXT_NOT_COVERED');
  const status=await this.e.validate(b);
  if(b.tools>1||this.e.background(b.agent.id))fail('BACKGROUND_NOT_DRAINED');
  if(status.pending_input||status.input_cursor!==(b.coveredInput??b.item.input_cursor??0))fail('INPUTS_NOT_COVERED');
  const evidence=this.e.development.ready(b,a.review),files={};
  for(const path of b.item.spec.development?.artifacts??[]){const f=snapshotFile(b.item.spec.cwd,path);files[path]={sha256:f.sha256,size:f.size};}
  const record={task_id:b.item.task_id,revision:b.item.revision,round:b.item.runs,input_cursor:status.input_cursor,control_version:status.control_version,summary:a.summary,review:a.review??null,evidence,files};
  // A repeated call can replace an intent only within the SAME still-owned run.
  this.db.prepare("INSERT INTO managed_closeouts VALUES (?,?,'intent',NULL) ON CONFLICT(claim) DO UPDATE SET record=excluded.record,state='intent',error=NULL").run(b.item.claim,json(record));
  this.db.prepare('UPDATE managed_endpoint_runs SET safe_checkpoint=1 WHERE claim=?').run(b.item.claim);
  b.completion=record;return {saved:true,completion_intent:true,committed:false,input_cursor:record.input_cursor};
 }
 async finish(b){
  const r=this.get(b.item.claim);if(!r||!['intent','materialized'].includes(r.state))fail('COMPLETION_INTENT_REQUIRED');
  const c=r.record,status=await this.e.validate(b);
  if(c.revision!==b.item.revision||c.round!==b.item.runs||status.control_version!==c.control_version||status.pending_input||status.input_cursor!==c.input_cursor)fail('COMPLETION_STALE');
  if(b.agent&&this.e.background(b.agent.id)||b.tools)fail('BACKGROUND_NOT_DRAINED');
  // Check exact current inputs again before importing artifacts. Unrelated receipt
  // files cannot invalidate checks with explicitly declared relevant inputs.
  const evidence=this.e.development.ready(b,c.review);
  for(const [path,saved] of Object.entries(c.files)){
   const f=snapshotFile(b.item.spec.cwd,path);if(f.sha256!==saved.sha256||f.size!==saved.size)fail('COMPLETION_ARTIFACT_CHANGED');
   const stored=await this.e.artifact(b,{path,stage:'candidate'});if(!stored?.complete||stored.artifact.sha256!==saved.sha256||stored.artifact.size!==saved.size)fail('COMPLETION_ARTIFACT_CHANGED');
  }
  // Snapshotting yields between chunks. Recheck real test inputs after import.
  const finalEvidence=this.e.development.ready(b,c.review);
  if(finalEvidence)await this.e.call('evidence',{...binding(b),evidence:finalEvidence});
  const latest=await this.e.validate(b);
  if(latest.pending_input||latest.input_cursor!==c.input_cursor||latest.control_version!==c.control_version)fail('COMPLETION_STALE');
  this.db.prepare("UPDATE managed_closeouts SET state='materialized',error=NULL WHERE claim=?").run(b.item.claim);
  b.completion=c;b.report={outcome:'ready',summary:c.summary};b.review=c.review;
  return {outcome:'ready',summary:c.summary,completion:{input_cursor:c.input_cursor,control_version:c.control_version,round:c.round}};
 }
 invalidate(claim,error){this.db.prepare("UPDATE managed_closeouts SET state='needs_review',error=? WHERE claim=?").run(error,claim);}
}
