import path from 'node:path';
import {digest,fail} from './onboarding-ssh.js';
const number=x=>Number.isSafeInteger(x)&&x>=0;
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const absolute=x=>typeof x==='string'&&x.length<=1024&&path.posix.isAbsolute(x)&&path.posix.normalize(x)===x&&!/[\x00-\x1f\x7f]/.test(x);
const baselineKeys=['platform','arch','uid','user','home','parent','root','ancestors','rootExists','owner','node'];
export function baselineOf(snapshot){return Object.fromEntries(baselineKeys.map(k=>[k,snapshot[k]]));}
// Verify the fixed probe's result, not merely a remote self-reported hash.
export function validateRemoteSnapshot(r,installationId,parentOverride){
 const reject=()=>fail('CLOUD_RESPONSE_INVALID');
 if(!r||r.ok!==true||r.contract!==1||r.platform!=='linux'||!number(r.uid)||typeof r.user!=='string'||!r.user.length||r.user.length>64||typeof r.arch!=='string'||r.arch.length>32||!absolute(r.home)||r.home==='/'||r.remoteWrites!==0||r.servicePathsVerified!==false)reject();
 const parent=parentOverride??path.posix.join(r.home,'.local/share/dsh-dual-host/instances'),root=path.posix.join(parent,'host-'+installationId);
 if(!absolute(parent)||r.parent!==parent||r.root!==root||typeof r.rootExists!=='boolean'||typeof r.writable!=='boolean'||r.freeBytes!==null&&!number(r.freeBytes))reject();
 const expected=['/'];let current='/';for(const segment of root.split('/').filter(Boolean)){current=path.posix.join(current,segment);expected.push(current);}
 if(!Array.isArray(r.ancestors)||r.ancestors.length!==expected.length)reject();
 let missing=false;
 for(let i=0;i<expected.length;i++){
  const a=r.ancestors[i];if(!a||a.path!==expected[i])reject();
  if(a.missing===true){missing=true;if(Object.keys(a).sort().join()!=='missing,path')reject();}
  else if(missing||!number(a.dev)||!number(a.ino)||!number(a.uid)||!number(a.mode)||a.mode>0o777||Object.keys(a).sort().join()!=='dev,ino,mode,path,uid')reject();
 }
 if(r.rootExists===missing||r.owner!==null&&(!r.rootExists||!hash(r.owner?.sha256)||typeof r.owner?.matches!=='boolean'))reject();
 const n=r.node;
 if(!n||!absolute(n.path)||!/^\d+\.\d+\.\d+$/.test(n.version)||!number(n.dev)||!number(n.ino)||!number(n.size)||!Number.isFinite(n.mtime)||n.mtime<0)reject();
 if(!Array.isArray(r.protectedHomes)||r.protectedHomes.length!==2||r.protectedHomes.some((p,i)=>p.path!==path.posix.join(r.home,['.dsh','.agents'][i])||typeof p.exists!=='boolean'||p.read!==false||p.modified!==false))reject();
 if(!Array.isArray(r.possibleHosts)||r.possibleHosts.length>8192||r.possibleHosts.some(p=>!number(p.pid)||!p.pid||p.classification!=='possible_dsh_cli'||p.configurationRead!==false))reject();
 if(!hash(r.baselineHash)||digest(baselineOf(r))!==r.baselineHash)reject();
 return r;
}
