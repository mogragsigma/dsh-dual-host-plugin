// Private durable supervisor evidence. Not a signature or OS identity boundary:
// an administrator able to rewrite the journal and state directory remains trusted.
import {mkdirSync,lstatSync,realpathSync,openSync,closeSync,fstatSync,readSync,readFileSync,constants} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {canonical,digest} from './approval-ledger.js';
import {validateProcessReport} from './delivery-process.js';
const fail=c=>{throw Error('DELIVERY_RECEIPT_'+c);};
const same=(a,b)=>canonical(a)===canonical(b);
const stamp=s=>[s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
export function bootId(){const id=readFileSync('/proc/sys/kernel/random/boot_id','ascii').trim();if(!uuid(id))fail('BOOT_UNKNOWN');return id;}
export function supervisorLive(pid,start,boot){
 if(bootId()!==boot)return false;
 let raw;try{raw=readFileSync('/proc/'+pid+'/stat','ascii');}catch(e){if(e.code==='ENOENT')return false;throw e;}
 const rest=raw.slice(raw.lastIndexOf(')')+2).split(' ');
 if(rest.length<20||!/^\d+$/.test(rest[19])||!rest[0])fail('SUPERVISOR_UNKNOWN');
 return rest[19]===start&&!['Z','X'].includes(rest[0]);
}
export function validateReceiptBinding(v){
 if(!v||Object.keys(v).sort().join(',')!=='action_id,binding_hash,boot_id,directory,epoch,intent_fingerprint,nonce,operation_id,plan_fingerprint,schema'||v.schema!==1||
  !/^delivery-op-[a-f0-9-]{36}$/.test(v.operation_id??'')||!/^delivery-[a-f0-9-]{36}$/.test(v.action_id??'')||
  !Number.isSafeInteger(v.epoch)||v.epoch<1||![v.binding_hash,v.nonce,v.intent_fingerprint,v.plan_fingerprint].every(sha)||!uuid(v.boot_id)||
  !v.directory||Object.keys(v.directory).sort().join(',')!=='device,inode,path'||typeof v.directory.path!=='string'||!v.directory.path.startsWith('/')||
  v.directory.path.length>2048||/[\x00-\x1f\x7f]/.test(v.directory.path)||!/^\d{1,30}$/.test(v.directory.device)||!/^\d{1,30}$/.test(v.directory.inode))fail('BINDING_INVALID');
 const {binding_hash,...body}=v;if(digest(body)!==binding_hash)fail('BINDING_INVALID');return v;
}
export class DeliveryProcessReceipts {
 constructor({journal,directory,enabled=false},io={}){
  this.j=journal;this.db=journal.db;this.directory=directory;this.enabled=enabled;this.boot=io.bootId??bootId;this.live=io.supervisorLive??supervisorLive;
  if(enabled!==true)fail('DISABLED');
  if(typeof directory!=='string'||!directory.startsWith('/'))fail('DIRECTORY_INVALID');
  try{mkdirSync(directory,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}this.directoryIdentity=this.checkDirectory();
  this.db.exec(`CREATE TABLE IF NOT EXISTS delivery_process_receipts(operation_id TEXT PRIMARY KEY,nonce TEXT UNIQUE NOT NULL,
   binding TEXT NOT NULL,created INTEGER NOT NULL);`);
 }
 checkDirectory(expected){
  const s=lstatSync(this.directory,{bigint:true});
  if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(this.directory)!==this.directory||(s.mode&0o077n)!==0n||s.uid!==BigInt(process.getuid()))fail('DIRECTORY_CHANGED');
  const v={path:this.directory,device:String(s.dev),inode:String(s.ino)};if(expected&&!same(v,expected))fail('DIRECTORY_CHANGED');return v;
 }
 prepare(operation_id){
  if(this.enabled!==true)fail('DISABLED');
  const o=this.j.operation(operation_id),i=this.j.effectAuthority(o.action_id,o.epoch);
  if(o.kind!=='push'||o.state!=='intent'||o.pid!==null||i.kind!=='push-execution-intent-v1')fail('OPERATION_INVALID');
  this.checkDirectory(this.directoryIdentity);
  const body={schema:1,operation_id,action_id:o.action_id,epoch:o.epoch,intent_fingerprint:i.fingerprint,plan_fingerprint:i.plan.fingerprint,
   nonce:randomBytes(32).toString('hex'),boot_id:this.boot(),directory:this.directoryIdentity};
  const b=validateReceiptBinding({...body,binding_hash:digest(body)});
  this.db.prepare('INSERT INTO delivery_process_receipts VALUES (?,?,?,?)').run(operation_id,b.nonce,canonical(b),this.j.now());return b;
 }
 binding(operation_id){
  if(this.enabled!==true)fail('DISABLED');
  const row=this.db.prepare('SELECT * FROM delivery_process_receipts WHERE operation_id=?').get(operation_id);if(!row)fail('BINDING_REQUIRED');
  const b=validateReceiptBinding(JSON.parse(row.binding)),o=this.j.operation(operation_id),i=this.j.intent(this.j.row(o.action_id));
  if(b.operation_id!==operation_id||row.nonce!==b.nonce||b.action_id!==o.action_id||b.epoch!==o.epoch||o.kind!=='push'||
   b.intent_fingerprint!==i.fingerprint||b.plan_fingerprint!==i.plan.fingerprint||!same(b.directory,this.directoryIdentity))fail('OPERATION_CHANGED');
  this.checkDirectory(b.directory);return {b,o};
 }
 inspect(operation_id){
  const {b,o}=this.binding(operation_id),path=join(this.directory,b.nonce+'.json'),before=lstatSync(path,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||(before.mode&0o077n)!==0n||before.uid!==BigInt(process.getuid())||before.size<1n||before.size>16384n)fail('FILE_INVALID');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let data;
  try{
   if(stamp(fstatSync(fd,{bigint:true}))!==stamp(before))fail('FILE_CHANGED');
   const bytes=Buffer.alloc(Number(before.size)+1);let n=0,k;while(n<bytes.length&&(k=readSync(fd,bytes,n,bytes.length-n,null))>0)n+=k;
   if(n!==Number(before.size)||stamp(fstatSync(fd,{bigint:true}))!==stamp(before)||stamp(lstatSync(path,{bigint:true}))!==stamp(before))fail('FILE_CHANGED');data=bytes.subarray(0,n);
  }finally{closeSync(fd);}
  this.checkDirectory(b.directory);let r;try{r=JSON.parse(data.toString('utf8'));}catch{fail('FILE_INVALID');}
  if(!r||Object.keys(r).sort().join(',')!=='binding_hash,boot_id,kind,operation_id,pid,report,schema,start_ticks'||r.schema!==1||r.kind!=='sealed-process-receipt-v1'||
   r.binding_hash!==b.binding_hash||r.boot_id!==b.boot_id||r.operation_id!==operation_id||r.pid!==o.pid||!Number.isSafeInteger(r.pid)||r.pid<1||
   typeof r.start_ticks!=='string'||!/^\d{1,30}$/.test(r.start_ticks)||!r.report||Object.keys(r.report).sort().join(',')!=='cause,code,drained,nonce,reaped,schema,signal,started')fail('REPORT_INVALID');
  // Receipt has no stdout/stderr, argv, environment or credential paths.
  const report=validateProcessReport(JSON.stringify({...r.report,stdout:''}),b.nonce,0,null);
  const live=this.live(r.pid,r.start_ticks,r.boot_id);if(typeof live!=='boolean')fail('SUPERVISOR_UNKNOWN');
  const proof={operation_id,action_id:b.action_id,epoch:b.epoch,binding_hash:b.binding_hash,receipt_sha256:digest(data.toString('utf8')),
   state:live?'supervisor_live':'terminal_verified',code:report.code,signal:report.signal,cause:report.cause,started:report.started,reaped:report.reaped,grants_execution:false};
  return {...proof,fingerprint:digest({...proof,file_stamp:stamp(before)})};
 }
 reconcile(operation_id,expectedFingerprint){
  if(!sha(expectedFingerprint))fail('EVIDENCE_REQUIRED');
  const {o}=this.binding(operation_id),row=this.j.fence(o.action_id,o.epoch,['needs_review']);
  if(this.j.store.task(row.task_id).revision!==this.j.intent(row).task_revision)fail('TASK_REVISION_CHANGED');
  const proof=this.inspect(operation_id);
  if(proof.state!=='terminal_verified'||proof.fingerprint!==expectedFingerprint)fail('EVIDENCE_CHANGED');
  this.j.closed(operation_id,{code:proof.code,signal:proof.signal,evidence:{kind:'sealed-process-receipt-v1',binding_hash:proof.binding_hash,receipt_sha256:proof.receipt_sha256}});
  return {operation_id,state:'closed',task_released:false,retry_authorized:false};
 }
}
