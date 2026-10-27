import {test} from 'node:test';import assert from 'node:assert/strict';import {webcrypto,createHash} from 'node:crypto';
import {decodeArtifactDownload,saveArtifactDownload} from '../ui-source/artifact-download-client.mjs';
const bytes=Buffer.from('报告正文');const artifact={id:'artifact-test',task_id:'task-test',spec_revision:1,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,name:'报告.md',kind:'report',state:'verified'};
const reply={artifact,encoding:'base64',content:bytes.toString('base64'),mime:'application/octet-stream',disposition:'attachment'};const env={crypto:webcrypto,atob};
test('client checks exact identity, size and hash before making any save possible',async()=>{assert.deepEqual(Buffer.from(await decodeArtifactDownload(reply,artifact,env)),bytes);for(const field of ['id','task_id','spec_revision','size','name','sha256'])await assert.rejects(decodeArtifactDownload(reply,{...artifact,[field]:'changed'},env));});
test('corrupt bytes, unsafe names, executable disposition, insecure crypto and oversize rejected',async()=>{
 for(const r of [{content:'!!!!'},{content:Buffer.from('tampered').toString('base64')},{mime:'text/html'},{disposition:'inline'},{content:'A'.repeat(349529)},{artifact:{...artifact,kind:'gitee'}},{artifact:{...artifact,state:'failed_run'}}])await assert.rejects(decodeArtifactDownload({...reply,...r},artifact,env));
 for(const name of ['../x','CON.md','bad\u202e.md']){const a={...artifact,name};await assert.rejects(decodeArtifactDownload({...reply,artifact:a},a,env));}
 await assert.rejects(decodeArtifactDownload(reply,artifact,{atob}),/CRYPTO/);
});
test('save uses a local attachment blob, removes anchor/revokes URL and never reports saved',()=>{
 const events=[],link={style:{},click(){events.push('click');},remove(){events.push('remove');}};
 const out=saveArtifactDownload(bytes,'报告.md',{Blob,URL:{createObjectURL(b){assert.equal(b.type,'application/octet-stream');return 'blob:isolated';},revokeObjectURL:u=>events.push(u)},document:{body:{append:n=>assert.equal(n,link)},createElement:t=>{assert.equal(t,'a');return link;}},setTimeout:fn=>fn()});
 assert.equal(link.download,'报告.md');assert.equal(link.href,'blob:isolated');assert.deepEqual(events,['click','remove','blob:isolated']);assert.equal(out.state,'browser_save_requested');
});
