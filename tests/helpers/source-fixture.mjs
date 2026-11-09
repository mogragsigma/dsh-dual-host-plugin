// Synthetic adapters only: no platform clients, credentials, background loops or retries.
import {openSync,closeSync,fstatSync,readFileSync,lstatSync,realpathSync} from 'node:fs';
import {constants} from 'node:fs';
import {resolve,relative,sep} from 'node:path';
export const source=(id='fixture',overrides={})=>({id,adapterId:'fixture-adapter',namespace:'r1-test',enabled:true,revision:'1',scopes:['project'],...overrides});
export const event=(id='message-1',overrides={})=>({id,scope:'project',occurredAt:100,actor:{id:'untrusted-person',kind:'human'},thread:{id:'thread-1'},text:'synthetic body',url:'https://example.invalid/thread/1',...overrides});
export const batch=(events=[event()],expectedCursor=null,nextCursor='page-1',configRevision='1')=>({events,expectedCursor,nextCursor,configRevision});
export function memoryAdapter(port,batches){
 let stopped=false,acks=0,reads=0;
 return {pull(index){if(stopped)throw Error('FIXTURE_STOPPED');reads++;const r=port.receiveBatch(structuredClone(batches[index]));acks++;return r;},close(){stopped=true;},get acks(){return acks;},get reads(){return reads;}};
}
export function fileAdapter(port,root){
 root=realpathSync(root);let stopped=false,acks=0;
 return {pull(file){
  if(stopped)throw Error('FIXTURE_STOPPED');
  const path=resolve(root,file),rel=relative(root,path);
  if(!rel||rel.startsWith('..'+sep)||rel==='..'||rel.startsWith(sep))throw Error('FIXTURE_PATH_DENIED');
  let current=root;for(const part of rel.split(sep)){current=resolve(current,part);if(lstatSync(current).isSymbolicLink())throw Error('FIXTURE_PATH_DENIED');}
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size>1200000||stat.nlink!==1)throw Error('FIXTURE_FILE_DENIED');
   const r=port.receiveBatch(JSON.parse(readFileSync(fd,'utf8')));acks++;return r;
  }finally{closeSync(fd);}
 },close(){stopped=true;},get acks(){return acks;}};
}
