import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:net';
import {hostname} from 'node:os';
import {join} from 'node:path';
import {realpathSync,statSync,existsSync,openSync,closeSync} from 'node:fs';
import {canonical,digest} from './approval-ledger.js';
const has=(db,n)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n);
const owner=db=>has(db,'scheduler_owner')?db.prepare('SELECT * FROM scheduler_owner WHERE id=1').get():null;
const identity=p=>{const s=statSync(p);return {path:realpathSync(p),dev:s.dev,ino:s.ino};};
const quoted=s=>'"'+s.replaceAll('"','""')+'"';
function snapshot(db){
 return digest(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('scheduler_owner','scheduler_owner_migrations') ORDER BY name").all().map(t=>({...t,rows:db.prepare('SELECT * FROM '+quoted(t.name)).all().map(r=>canonical(r)).sort()})));
}
// Operator-only offline migration, not an RPC/model tool. The prior port and config
// hash MUST come from the effective legacy configuration, not an invented free port.
export function schedulerMigrationPlan(stateDir,{priorLockPort,sourceVersion,sourceConfigHash}={}){
 if(!Number.isInteger(priorLockPort)||priorLockPort<1||priorLockPort>65535||!/^0\.(?:[5-9]|1\d|20)\./.test(sourceVersion??'')||!/^[a-f0-9]{64}$/.test(sourceConfigHash??''))throw Error('SCHEDULER_MIGRATION_CONFIG_REQUIRED');
 const file=join(stateDir,'jobs.sqlite'),db=new DatabaseSync(file,{readOnly:true});
 try{if(owner(db))throw Error('SCHEDULER_OWNER_ALREADY_BOUND');if(!has(db,'jobs'))throw Error('SCHEDULER_MIGRATION_NOT_A_JOB_DATABASE');
  const plan={schema:1,host:hostname(),identity:identity(file),priorLockPort,sourceVersion,sourceConfigHash,snapshot:snapshot(db),jobCount:db.prepare('SELECT count(*) n FROM jobs').get().n};return {...plan,proof_hash:digest(plan)};
 }finally{db.close();}
}
export async function adoptSchedulerOwner(plan,{confirmLegacyStopped=false,backupPath}={}){
 const {proof_hash,...payload}=plan??{};
 if(!confirmLegacyStopped||!proof_hash||digest(payload)!==proof_hash||plan.host!==hostname()||!Number.isInteger(plan.priorLockPort)||plan.priorLockPort<1||plan.priorLockPort>65535||typeof backupPath!=='string'||!backupPath)throw Error('SCHEDULER_MIGRATION_CONFIRMATION_REQUIRED');
 const file=plan.identity?.path;if(canonical(identity(file))!==canonical(plan.identity))throw Error('SCHEDULER_MIGRATION_DATABASE_CHANGED');
 const lock=createServer(s=>s.destroy());let db;
 try{
  await new Promise((resolve,reject)=>{lock.once('error',reject);lock.listen({host:'127.0.0.1',port:plan.priorLockPort,exclusive:true},resolve);});
  db=new DatabaseSync(file);db.exec('PRAGMA busy_timeout=5000;');
  const existing=owner(db),prior=has(db,'scheduler_owner_migrations')&&db.prepare('SELECT * FROM scheduler_owner_migrations WHERE proof_hash=?').get(proof_hash);
  if(existing){if(!prior||existing.host!==plan.host||existing.port!==plan.priorLockPort)throw Error('SCHEDULER_OWNER_CHANGED');return {migrated:true,replayed:true,recoveryStarted:false,port:existing.port};}
  if(snapshot(db)!==plan.snapshot)throw Error('SCHEDULER_MIGRATION_STALE_PLAN');
  if(existsSync(backupPath))throw Error('SCHEDULER_MIGRATION_BACKUP_EXISTS');
  closeSync(openSync(backupPath,'wx',0o600));db.prepare('VACUUM INTO ?').run(backupPath);
  db.exec('BEGIN IMMEDIATE');
  try{
   if(canonical(identity(file))!==canonical(plan.identity)||snapshot(db)!==plan.snapshot||owner(db))throw Error('SCHEDULER_MIGRATION_STALE_PLAN');
   db.exec('CREATE TABLE IF NOT EXISTS scheduler_owner(id INTEGER PRIMARY KEY CHECK(id=1),host TEXT NOT NULL,port INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS scheduler_owner_migrations(proof_hash TEXT PRIMARY KEY,source_version TEXT NOT NULL,source_config_hash TEXT NOT NULL,backup_path TEXT NOT NULL,created INTEGER NOT NULL);');
   db.prepare('INSERT INTO scheduler_owner VALUES(1,?,?)').run(plan.host,plan.priorLockPort);
   db.prepare('INSERT INTO scheduler_owner_migrations VALUES(?,?,?,?,?)').run(proof_hash,plan.sourceVersion,plan.sourceConfigHash,backupPath,Date.now());db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return {migrated:true,replayed:false,recoveryStarted:false,port:plan.priorLockPort};
 }finally{db?.close();if(lock.listening)await new Promise(r=>lock.close(r));}
}
