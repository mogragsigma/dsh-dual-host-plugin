import {DatabaseSync} from 'node:sqlite';
import {SourceIntake} from '../../bundle/source-intake.js';
import {source,batch} from './source-fixture.mjs';
const [path,phase]=process.argv.slice(2),db=new DatabaseSync(path);
db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL');
const connection=new Proxy(db,{get(target,key){if(key==='exec')return sql=>{if(phase==='before'&&sql==='COMMIT')process.exit(77);return target.exec(sql);};const v=target[key];return typeof v==='function'?v.bind(target):v;}});
const core=new SourceIntake(connection,{enabled:()=>true,resolveSource:()=>source()});
core.bind('fixture','fixture-adapter').receiveBatch(batch());
if(phase==='after')process.exit(78); // No receipt/ACK is sent to the parent.
core.close();db.close();
