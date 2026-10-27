// Capture before replace: publication uses link(no-replace), never rename over
// a newly created user file. Backups/journals stay in this Host's private state.
import path from 'node:path';
import {constants} from 'node:fs';
import {fs,hash,bytes,snapshot,ancestors,sameIdentity,identity,syncWrite,fail} from './onboarding-install-fs.js';
export async function syncDirectory(dir){const h=await fs.open(dir,'r');try{await h.sync();}finally{await h.close();}}
export async function statMaybe(file){try{return await fs.lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export async function knownFile(file,expected,alias){
 await ancestors(path.dirname(file));const s=await statMaybe(file);if(!s)return null;
 if(!s.isFile()||s.isSymbolicLink()||!sameIdentity(s,expected)||s.size!==expected.size||![1,2].includes(s.nlink))fail('MAINTENANCE_FILE_DRIFT');
 if(s.nlink===2){const a=alias&&await statMaybe(alias);if(!a||!a.isFile()||a.isSymbolicLink()||!sameIdentity(a,s))fail('MAINTENANCE_FILE_DRIFT');}
 const h=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
 try{const before=await h.stat();if(!sameIdentity(before,s)||before.nlink!==s.nlink)fail('MAINTENANCE_FILE_DRIFT');
  const b=await h.readFile(),after=await h.stat();if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||hash(b)!==expected.sha256)fail('MAINTENANCE_FILE_DRIFT');
 }finally{await h.close();}return s;
}
export async function publishMaintenanceItem(item,dir,n,save,hook,maxBytes=262144){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>4194304)fail('MAINTENANCE_SIZE_LIMIT');
 const stage=path.join(dir,'stage-'+n),backup=path.join(dir,'backup-'+n);
 if(JSON.stringify(await snapshot(item.path,maxBytes))!==JSON.stringify(item.before))fail('MAINTENANCE_FILE_DRIFT');
 if(item.after!==null){
  await syncWrite(stage,Buffer.from(item.after,'base64'));
  await fs.chmod(stage,item.before.missing?0o600:item.before.mode);
  item.published={...identity(await fs.lstat(stage)),size:Buffer.from(item.after,'base64').length,sha256:item.afterHash};
  await syncDirectory(dir);
 }
 item.phase='intent';await save();await hook?.('before_capture',n,item.path);
 if(!item.before.missing){
  if(await statMaybe(backup))fail('MAINTENANCE_BACKUP_CONFLICT');
  await fs.rename(item.path,backup);await syncDirectory(path.dirname(item.path));await syncDirectory(dir);
  await knownFile(backup,item.before,item.path);await hook?.('after_capture',n,item.path);
 }
 if(item.after!==null){
  await knownFile(stage,item.published,item.path);
  await fs.link(stage,item.path);await syncDirectory(path.dirname(item.path));await hook?.('after_publish',n,item.path);
  await fs.unlink(stage);await syncDirectory(dir);
  const s=await snapshot(item.path,maxBytes);if(s.sha256!==item.afterHash||!sameIdentity(s,item.published))fail('MAINTENANCE_FILE_DRIFT');
 }
 item.phase='done';await save();await hook?.('after_write',n,item.path);
}
export async function rollbackMaintenanceItem(item,dir,n,maxBytes=262144){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>4194304)fail('MAINTENANCE_SIZE_LIMIT');
 if(item.phase==='pending')return;
 const stage=path.join(dir,'stage-'+n),backup=path.join(dir,'backup-'+n);
 const b=await statMaybe(backup),target=await statMaybe(item.path);
 if(b)await knownFile(backup,item.before,item.path);
 // A crash after restoration may leave the only two links: target + backup.
 if(target&&!item.before.missing&&sameIdentity(target,item.before)){
  await knownFile(item.path,item.before,b?backup:null);
  if(b){await fs.unlink(backup);await syncDirectory(dir);}
 }else{
  if(target){
   if(!item.published)fail('MAINTENANCE_ROLLBACK_DRIFT');
   await knownFile(item.path,item.published,stage);
   await fs.unlink(item.path);await syncDirectory(path.dirname(item.path));
  }
  if(!item.before.missing){
   if(!b)fail('MAINTENANCE_ROLLBACK_DRIFT');
   await fs.link(backup,item.path);await syncDirectory(path.dirname(item.path));
   await knownFile(item.path,item.before,backup);await fs.unlink(backup);await syncDirectory(dir);
  }
 }
 if(await statMaybe(stage)){
  if(!item.published)fail('MAINTENANCE_ROLLBACK_DRIFT');
  await knownFile(stage,item.published,item.path);await fs.unlink(stage);await syncDirectory(dir);
 }
 const current=await snapshot(item.path,maxBytes);
 if(item.before.missing?!current.missing:current.sha256!==item.before.sha256||!sameIdentity(current,item.before))fail('MAINTENANCE_ROLLBACK_DRIFT');
}
