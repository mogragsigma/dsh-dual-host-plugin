import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Gateway} from '../../bundle/index.js';
import {createOnboardingFileTransfer} from '../../bundle/onboarding-file-transfer.js';
export const hash=b=>createHash('sha256').update(b).digest('hex'),confirm=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true}),max=2097152;
export async function fixture(t,role='cloud',namespaceId=null){
 const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'s57-review-'))),id=randomUUID(),root=path.join(parent,id),a=path.join(parent,'old-source'),b=path.join(parent,'new-source');for(const p of [root,root+'/state',a,b])fs.mkdirSync(p,{mode:0o700});
 const records=new Map();let clock=10000,writes=0,tail=Promise.resolve();
 const credentials={readRecord:async k=>structuredClone(records.get(k)),modifyRecord(k,fn){const promise=tail.then(()=>{const next=fn(structuredClone(records.get(k)));if(next!==undefined){records.set(k,structuredClone(next));writes++;}});tail=promise.catch(()=>{});return promise;}};
 const g=new Gateway({on(){},effect(){},agents:{list:()=>[]},agentPresets:{}},{role,stateDir:root+'/state',namespace:'managed-'+(namespaceId??id),port:0,entryMode:'native',peerEnabled:false,legacyFeishu:false},{now:()=>clock,secrets:{localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}}),deps={g,root,credentials:()=>credentials,now:()=>clock};let manager=createOnboardingFileTransfer(deps);
 t.after(async()=>{await manager.close();await g.close();fs.rmSync(parent,{recursive:true,force:true});});
 return {id,parent,root,a,b,g,records,get m(){return manager;},writes:()=>writes,advance:()=>clock+=300001,
  enable:async(roots=[a],size=max)=>manager.apply(confirm(await manager.preview({enabled:true,sendRoots:roots,maxBytes:size}))),
  disable:async()=>{const s=await manager.status({});return manager.apply(confirm(await manager.preview({enabled:false,sendRoots:s.sendRoots,maxBytes:s.maxBytes})));},
  migrate:async(size=max)=>manager.apply(confirm(await manager.migrationPreview({sendRoots:[b],maxBytes:size}))),
  restart:async()=>{await manager.close();manager=createOnboardingFileTransfer(deps);await manager.start();},
  queue:()=>g.db.prepare('SELECT * FROM peer_file_out ORDER BY id').all()};
}
export async function enqueue(f,name='safe.txt',text='immutable',task_id='task-'+randomUUID()){
 const id='file-'+hash(name),file=f.a+'/'+name;fs.writeFileSync(file,text);await f.g.files.enqueue({id,task_id,file});return {id,task_id,file,item:{queue:'outgoing',id,origin:''},blob:f.root+'/state/peer-files/send/'+f.g.c.role+'/'+id+'.blob'};
}
export async function held(t){const f=await fixture(t);await f.enable();const sent=await enqueue(f);f.g.db.prepare('UPDATE peer_file_out SET attempts=3,next_at=1234').run();await f.disable();await f.migrate();return {...f,sent,get m(){return f.m;}};}
