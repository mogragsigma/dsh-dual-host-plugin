import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync,writeFileSync,renameSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {sameNativeTask} from './task-envelope.js';

export const hash=value=>createHash('sha256').update(value).digest('hex');
export class Coordinator {
  constructor(root, writer = null) {
    this.writer = writer;
    this.root=root;mkdirSync(root,{recursive:true,mode:0o700});
    this.db=new DatabaseSync(join(root,'tasks.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,task_key TEXT UNIQUE,owner TEXT,epoch INTEGER,busy INTEGER,revision INTEGER,blocked INTEGER DEFAULT 0,checkpoint TEXT);
      CREATE TABLE IF NOT EXISTS ingress(id TEXT PRIMARY KEY,task_id TEXT,source TEXT,node TEXT,goal TEXT);
      CREATE TABLE IF NOT EXISTS intents(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,task_id TEXT,node TEXT,fingerprint TEXT,content TEXT,base_hash TEXT,status TEXT,epoch INTEGER,receipt TEXT);
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT,data TEXT);`);
  }
  tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  log(type,data){this.db.prepare('INSERT INTO audit(type,data) VALUES (?,?)').run(type,JSON.stringify(data));}
  task(id){const t=this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);if(!t)throw Error('TASK_NOT_FOUND');return t;}
  file(id){this.task(id);return join(this.root,'workspaces',id,'artifact.txt');}
  contents(id){if(this.writer)return this.writer.contents(id);try{return readFileSync(this.file(id),'utf8');}catch(e){if(e.code==='ENOENT')return '';throw e;}}
  status(id){const t=this.task(id);return {...t,fileHash:hash(this.contents(id)),intents:this.db.prepare('SELECT id,node,status,epoch FROM intents WHERE task_id=? ORDER BY seq').all(id)};}
  accept(node,{task_key,ingress_id,source,goal=""}){
    if(!["local","cloud"].includes(node)||typeof goal!=="string"||goal.length>12000||typeof source!=="string"||source.length>64)throw Error("INVALID_INGRESS");
    if(!/^[a-z0-9-]{1,64}$/.test(task_key)||typeof ingress_id!=='string'||ingress_id.length>256)throw Error('INVALID_INGRESS');
    return this.tx(()=>{
      let t=this.db.prepare('SELECT * FROM tasks WHERE task_key=?').get(task_key);
      const old=this.db.prepare('SELECT * FROM ingress WHERE id=?').get(ingress_id);
      if(old){if(!t||old.task_id!==t.id||old.source!==source||old.node!==node||old.goal!==goal)throw Error('INGRESS_ID_CONFLICT');return this.status(t.id);}
      if(t){const first=this.db.prepare('SELECT goal FROM ingress WHERE task_id=? ORDER BY rowid LIMIT 1').get(t.id);
        if(first&&!sameNativeTask(first.goal,goal))throw Error('TASK_CONTENT_CONFLICT');}
      if(!t){const id='task-'+randomUUID();this.db.prepare('INSERT INTO tasks(id,task_key,owner,epoch,busy,revision) VALUES (?,?,?,1,0,0)').run(id,task_key,'cloud');t=this.task(id);}
      this.db.prepare('INSERT INTO ingress VALUES (?,?,?,?,?)').run(ingress_id,t.id,source,node,goal);
      this.log('accepted',{node,source,ingress_id,task_id:t.id});return this.status(t.id);
    });
  }
  fence(node,id,epoch){const t=this.task(id);if(t.owner!==node||t.epoch!==epoch)throw Error('STALE_FENCE');if(t.blocked)throw Error('NEEDS_REVIEW');return t;}
  begin(node,{task_id,epoch}){return this.tx(()=>{const t=this.fence(node,task_id,epoch);if(t.busy)throw Error('TASK_BUSY');this.db.prepare('UPDATE tasks SET busy=1 WHERE id=?').run(task_id);this.log('busy',{task_id,node,epoch});return this.status(task_id);});}
  drain(id){
    const t=this.task(id);if(t.busy||t.blocked)return;
    const q=this.db.prepare("SELECT * FROM intents WHERE task_id=? AND status='queued' ORDER BY seq LIMIT 1").get(id);if(!q)return;
    this.db.prepare('UPDATE tasks SET owner=?,epoch=epoch+1,busy=1 WHERE id=?').run(q.node,id);
    this.db.prepare("UPDATE intents SET status='granted',epoch=? WHERE id=?").run(t.epoch+1,q.id);
    this.log('handoff',{task_id:id,from:t.owner,to:q.node,epoch:t.epoch+1,intent:q.id});
  }
  request(node,{task_id,request_id,content,base_hash}){
    if(this.writer)this.writer.assertBound(task_id);
    if(typeof request_id!=='string'||!request_id||request_id.length>128||typeof content!=='string'||Buffer.byteLength(content)>4096||!(/^[a-f0-9]{64}$/).test(base_hash))throw Error('INVALID_WRITE');
    return this.tx(()=>{
      this.task(task_id);const fingerprint=hash(JSON.stringify({task_id,node,content,base_hash}));
      const old=this.db.prepare('SELECT * FROM intents WHERE id=?').get(request_id);
      if(old){if(old.fingerprint!==fingerprint)throw Error('INTENT_ID_CONFLICT');return {intent:this.intent(request_id),task:this.status(task_id)};}
      this.db.prepare("INSERT INTO intents(id,task_id,node,fingerprint,content,base_hash,status) VALUES (?,?,?,?,?,?,'queued')").run(request_id,task_id,node,fingerprint,content,base_hash);
      this.log('write-request',{task_id,node,request_id});this.drain(task_id);
      return {intent:this.intent(request_id),task:this.status(task_id)};
    });
  }
  intent(id){const q=this.db.prepare('SELECT * FROM intents WHERE id=?').get(id);if(!q)throw Error('INTENT_NOT_FOUND');return q;}
  apply(node,{request_id,epoch}){
    // A durable intent precedes the filesystem effect. Ambiguous effects remain fenced.
    const q=this.tx(()=>{
      const q=this.intent(request_id);if(q.node!==node)throw Error('WRITER_DENIED');
      if(q.status==='applied')return q;
      this.fence(node,q.task_id,epoch);
      if(q.status!=='granted'||q.epoch!==epoch)throw Error('NOT_GRANTED');
      if(hash(this.contents(q.task_id))!==q.base_hash)throw Error('BASE_HASH_CONFLICT');
      this.db.prepare("UPDATE intents SET status='writing' WHERE id=?").run(q.id);return q;
    });
    if(q.status==='applied')return JSON.parse(q.receipt);
    try{
      let commit;
      if(this.writer)commit=this.writer.write(q);else {
      const dir=join(this.root,'workspaces',q.task_id);mkdirSync(dir,{recursive:true,mode:0o700});
      const temporary=join(dir,'.pending-'+randomUUID());writeFileSync(temporary,q.content,{mode:0o600,flag:'wx'});
      const fd=openSync(temporary,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
      renameSync(temporary,this.file(q.task_id));
      const directory=openSync(dir,'r');try{fsyncSync(directory);}finally{closeSync(directory);}
      }
      return this.tx(()=>{
        this.fence(node,q.task_id,epoch);
        const receipt={request_id:q.id,task_id:q.task_id,node,epoch,sha256:hash(q.content),...(commit?{commit}:{})};
        this.db.prepare("UPDATE intents SET status='applied',receipt=? WHERE id=?").run(JSON.stringify(receipt),q.id);
        this.db.prepare('UPDATE tasks SET revision=revision+1 WHERE id=?').run(q.task_id);
        this.log('write-applied',receipt);return receipt;
      });
    }catch(e){this.db.prepare('UPDATE tasks SET blocked=1 WHERE id=?').run(q.task_id);throw e;}
  }
  safe(node,{task_id,epoch,checkpoint}){
    if(typeof checkpoint!=='string'||!checkpoint.trim()||checkpoint.length>2048)throw Error('CHECKPOINT_REQUIRED');
    return this.tx(()=>{
      this.fence(node,task_id,epoch);
      const pending=this.db.prepare("SELECT count(*) AS n FROM intents WHERE task_id=? AND status IN ('granted','writing')").get(task_id).n;
      if(pending)throw Error('WRITES_NOT_QUIESCENT');
      this.db.prepare('UPDATE tasks SET busy=0,checkpoint=? WHERE id=?').run(checkpoint,task_id);
      this.log('safe-point',{task_id,node,epoch});this.drain(task_id);return this.status(task_id);
    });
  }
  snapshot(){return {tasks:this.db.prepare('SELECT * FROM tasks').all(),ingress:this.db.prepare('SELECT * FROM ingress').all(),intents:this.db.prepare('SELECT id,task_id,node,status,epoch FROM intents').all(),audit:this.db.prepare('SELECT * FROM audit').all().map(x=>({...x,data:JSON.parse(x.data)}))};}
  close(){this.db.close();}
}
