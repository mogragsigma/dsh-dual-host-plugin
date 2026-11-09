import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFileSync,mkdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers/continuity-fixture.mjs';
import {fetchArtifactDownload} from '../ui-source/artifact-download-client.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
async function setup(t,extra={}){
 const f=fixture(t,{managedExecution:{enabled:true}}),id=await f.create('native files'),cwd=join(f.dir,'work');mkdirSync(cwd);const development={delivery:'workspace',checks:[],no_checks_reason:'仅生成样例文件，核对内容',artifacts:['report.docx'],...extra};
 f.g.ctx.llm.resolveCallConfig=async p=>p;const p=await f.g.call('execution_prepare',{task_id:id,expected_revision:1,role:'cloud',cwd:realpathSync(cwd),scope:'生成约定成果',model_policy:{provider:'fixture',model:'fixture'},development,event_id:'proposal'});
 f.g.continuity.decide('cloud',{request_id:p.id,expected_revision:1,proposal_hash:p.proposal_hash,expected_decision_id:null,action:'approve',source:f.source('同意','cloud','approve')});await f.g.call('execution_enqueue',{task_id:id,approval_id:p.id});const claim=f.g.execution.claim('cloud',{development_contract:1,instance_id:'endpoint'}).item;const r=f.g.execution.begin('cloud',{task_id:id,claim:claim.claim,instance_id:claim.instance}).item;
 const own={task_id:id,claim:r.claim,instance_id:r.instance};return {...f,id,r,own,p,development};
}
async function upload(f,bytes,stage='draft'){
 let result;for(let offset=0;offset<bytes.length||offset===0;offset+=49152){result=await f.g.call('execution_artifact',{...f.own,path:'report.docx',stage,size:bytes.length,sha256:sha(bytes),offset,content:bytes.subarray(offset,offset+49152).toString('base64')});if(result.complete)break;}return result.artifact;
}
test('generic file >2MiB, chunked immutable snapshot and download; no session restore or model request',async t=>{
 const f=await setup(t),bytes=Buffer.alloc(2*1024*1024+17,42),a=await upload(f,bytes);assert.equal(a.kind,'native_file');assert.equal(a.stage,'draft');assert.equal(a.size,bytes.length);assert.equal(a.state,'needs_verification');
 const access=async(method,args)=>f.g.artifacts.download(args);const {bytes:download}=await fetchArtifactDownload(access,a);assert.deepEqual(Buffer.from(download),bytes);
 assert.equal(f.g.execution.budgets.view(f.id).used,0);assert.equal(f.sideEffects.agents,0);
});
test('draft/history remains available after finish, revision change and absent execution session',async t=>{
 const f=await setup(t),a=await upload(f,Buffer.from('old bytes'));f.g.execution.finish('cloud',{...f.own,session_id:'managed-fixture',drained:true,outcome:'waiting',summary:'draft saved'});f.g.store.db.prepare('UPDATE task_catalog SET spec_revision=2 WHERE task_id=?').run(f.id);
 const got=f.g.artifacts.download({task_id:f.id,artifact_id:a.id,expected_revision:1,expected_sha256:a.sha256});assert.equal(Buffer.from(got.content,'base64').toString(),'old bytes');assert.equal(got.artifact.historical,true);
 assert.equal((await f.g.artifacts.access({task_id:f.id,artifact_id:a.id,action:'session'})).error,'ARTIFACT_ACTION_UNAVAILABLE');
});
test('chunk retry is exact, changed/out-of-order/foreign path and unapproved authority reject',async t=>{
 const f=await setup(t),bytes=Buffer.alloc(60000,42),a={...f.own,path:'report.docx',stage:'draft',size:bytes.length,sha256:sha(bytes),offset:0,content:bytes.subarray(0,49152).toString('base64')};
 await f.g.call('execution_artifact',a);await f.g.call('execution_artifact',a);await assert.rejects(f.g.call('execution_artifact',{...a,content:Buffer.alloc(49152).toString('base64')}),/CHUNK_CONFLICT/);await assert.rejects(f.g.call('execution_artifact',{...a,path:'secret'}),/NOT_AUTHORIZED/);
 await assert.rejects(f.g.call('execution_artifact',{...a,offset:59000,content:Buffer.alloc(1).toString('base64')}),/CHUNK_ORDER/);
 f.g.continuity.decide('cloud',{request_id:f.p.id,expected_revision:1,proposal_hash:f.p.proposal_hash,expected_decision_id:f.g.approvals.view(f.p.id).decision_id,action:'revoke',source:f.source('撤销')});await assert.rejects(f.g.call('execution_artifact',a),/AUTHORITY_CHANGED/);
});
test('mutable source does not replace retained bytes; draft and candidate have separate immutable IDs',async t=>{
 const f=await setup(t),a=await upload(f,Buffer.from('original')),b=await upload(f,Buffer.from('changed')),c=await upload(f,Buffer.from('original'),'candidate');assert.notEqual(a.id,b.id);assert.notEqual(a.id,c.id);assert.equal(f.g.artifacts.readLocal(f.g.artifacts.load(f.id,a.id)).bytes.toString(),'original');
 writeFileSync(join(f.g.artifacts.root,a.id+'.bin'),'tampered');await assert.rejects(fetchArtifactDownload(async(_,args)=>f.g.artifacts.download(args),a),/FILE_CHANGED|DOWNLOAD_CHANGED/);
});
test('download abandonment never saves, wrong digest/order cannot produce valid browser bytes',async t=>{
 const f=await setup(t),a=await upload(f,Buffer.from('fixture'));
 await assert.rejects(fetchArtifactDownload(async(_,args)=>f.g.artifacts.download(args),a,()=>false),/ABANDONED/);
 await assert.rejects(fetchArtifactDownload(async(_,args)=>({...f.g.artifacts.download(args),offset:1}),a),/DOWNLOAD_CHANGED/);
});

test('old endpoint cannot claim new development work; legacy ready cannot bypass new evidence requirements',async t=>{
 const f=await setup(t);assert.throws(()=>f.g.execution.finish('cloud',{...f.own,session_id:'managed-test',drained:true,outcome:'ready',summary:'unsupported old worker'}),/DEVELOPMENT_EVIDENCE_REQUIRED/);
 f.g.execution.finish('cloud',{...f.own,session_id:'managed-test',drained:true,outcome:'waiting',summary:'waiting'});f.g.continuity.receive('cloud',f.input(f.id));assert.equal(f.g.execution.claim('cloud',{instance_id:'old-endpoint'}).item,null);assert(f.g.execution.claim('cloud',{instance_id:'new-endpoint',development_contract:1}).item);
 const {CAPABILITIES,requireCapability}=await import('../bundle/link-contract.js'),own={schema:1,namespace:'fixture',role:'local',plugin_version:'0.34.0-alpha.2',instance_id:'a'.repeat(36),protocol:{min:1,max:1},capabilities:CAPABILITIES},peer={...own,role:'cloud',capabilities:{...CAPABILITIES}};delete peer.capabilities.managed_development;
 for(const [method,args] of [['execution_prepare',{development:{}}],['execution_claim',{development_contract:1}],['notification_media_chunk',{}]])assert.throws(()=>requireCapability(method,own,peer,args),/CAPABILITY/);
});
