import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {SourceIntake} from '../bundle/source-intake.js';
import {source,batch,event} from './helpers/source-fixture.mjs';
for(const phase of ['before','after'])test(`AC-R1-${phase==='before'?'12':'13'} process exits ${phase} COMMIT with no ACK`,t=>{
 const dir=mkdtempSync(join(tmpdir(),'r1-crash-')),path=join(dir,'gateway.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('./helpers/source-intake-child.mjs',import.meta.url)),path,phase],{encoding:'utf8',timeout:5000});
 assert.equal(child.status,phase==='before'?77:78,child.stderr);assert.equal(child.stdout,'');
 const db=new DatabaseSync(path),core=new SourceIntake(db,{enabled:()=>true,resolveSource:()=>source()});
 try{
  const p=core.bind('fixture','fixture-adapter');assert.equal(p.status().records,phase==='before'?0:1);assert.equal(p.status().cursor,phase==='before'?null:'page-1');
  const r=p.receiveBatch(batch([event()],p.status().cursor,'recovered'));assert.equal(r.duplicates,phase==='before'?0:1);assert.equal(p.status().records,1);
 }finally{core.close();db.close();}
});
