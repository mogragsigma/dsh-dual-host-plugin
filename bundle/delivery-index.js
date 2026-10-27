// Pure private index-v2 compiler. No filesystem or Git invocation.
import {createHash} from 'node:crypto';
import {verifyObjects,indexTree} from './delivery-object-plan.js';
export function compileIndex(plan,objects){
 verifyObjects(plan,objects);const byId=new Map(objects.map(o=>[o.oid,o])),entries=[],oidBytes=plan.format==='sha1'?20:32;
 const walk=(id,prefix='')=>{
  const raw=byId.get(id).data;let at=0;
  while(at<raw.length){
   const nul=raw.indexOf(0,at),header=raw.subarray(at,nul).toString('utf8'),space=header.indexOf(' '),mode=header.slice(0,space),name=header.slice(space+1),oid=raw.subarray(nul+1,nul+1+oidBytes).toString('hex');at=nul+1+oidBytes;
   if(mode==='40000')walk(oid,prefix+name+'/');else entries.push({path:prefix+name,mode:mode==='100755'?0o755:0o644,oid});
  }
 };walk(plan.tree_oid);entries.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
 if(indexTree(entries,plan.format)!==plan.tree_oid)throw Error('DELIVERY_INDEX_TREE_MISMATCH');
 const header=Buffer.alloc(12);header.write('DIRC');header.writeUInt32BE(2,4);header.writeUInt32BE(entries.length,8);
 const chunks=[header];for(const e of entries){
  const name=Buffer.from(e.path),prefix=40+oidBytes+2,raw=Buffer.alloc(Math.ceil((prefix+name.length+1)/8)*8);
  // Zero stat cache deliberately forces Git to recheck filesystem content; no assume-valid flag.
  raw.writeUInt32BE(e.mode===0o755?0o100755:0o100644,24);Buffer.from(e.oid,'hex').copy(raw,40);
  raw.writeUInt16BE(Math.min(name.length,0xfff),40+oidBytes);name.copy(raw,prefix);chunks.push(raw);
 }
 const body=Buffer.concat(chunks),checksum=createHash(plan.format).update(body).digest();
 return {bytes:Buffer.concat([body,checksum]),entries,tree_oid:plan.tree_oid,format:plan.format};
}
