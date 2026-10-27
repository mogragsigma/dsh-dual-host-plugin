import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,chmodSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DevelopmentContainer} from '../bundle/development-container.js';
import {digest} from '../bundle/approval-ledger.js';
const image=process.env.DSH_CONTAINER_IMAGE;
const options={skip:!image?'requires explicitly selected installed Linux image':false};
function fixture(t,code,{timeout=5000}={}){
 const directory=mkdtempSync(join(tmpdir(),'dsh-s41-container-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const command={id:'check',image,argv:['/usr/local/bin/python','-c',code],cwd:'.',timeout_ms:timeout,required:true};
 const spec={kind:'workspace-v1',branch:'dsh-task/container-fixture',files:[{path:'src/main.py',action:'create',base_sha256:null}],reads:[],commands:[command],max_writes:2,max_commands:2,max_model_requests:10};
 const content='def total(a,b):\n    return a+b\n',hash=digest(content);
 const workspace={spec,check:h=>assert.equal(h,hash),snapshot(h,p){assert.equal(h,hash);mkdirSync(p);mkdirSync(join(p,'src'));writeFileSync(join(p,'src/main.py'),content,{mode:0o444});for(const dir of [p,join(p,'src')])chmodSync(dir,0o755);chmodSync(join(p,'src/main.py'),0o444);assert.equal(statSync(directory).mode&0o777,0o700);}};
 const adapter=new DevelopmentContainer({directory}),cli=adapter.cli.bind(adapter);adapter.cli=async(...a)=>{try{return await cli(...a);}catch(e){console.error('fixture CLI diagnostic',a[0][0],String(e.stderr??e.message).slice(-1500));throw e;}};
 return {directory,workspace,hash,adapter};
}
async function run(t,code,extra={}){
 const f=fixture(t,code,extra),events=[],operation='operation-'+randomUUID();
 const result=await f.adapter.run(f.workspace,f.hash,'check',{operation,signal:extra.signal,onCreated:c=>{events.push({type:'created',...c});extra.onCreated?.();},onClosed:c=>events.push({type:'closed',...c})});
 assert.equal(events.map(e=>e.type).join(','),'created,closed');assert(result.drained);assert(result.started,'must have actually started, not just a rejected container');assert.equal(result.command_hash,digest(f.workspace.spec.commands[0]));
 // Removal only after a verified stop; absence means cleanup succeeded, not drain proof.
 const containers=await f.adapter.cli(['ps','-a','--filter','name='+f.adapter.name(operation),'--format','{{.ID}}']);assert.equal(containers.trim(),'');
 return result;
}
test('constructor fails closed on hosts without Linux container adapter',()=>{if(process.platform!=='linux')assert.throws(()=>new DevelopmentContainer({directory:'/tmp/unused'}),/UNAVAILABLE/);});
test('real offline build and result output, source remains read-only',options,async t=>{
 const r=await run(t,'import py_compile,runpy\npy_compile.compile("/work/src/main.py",cfile="/out/main.pyc",doraise=True)\nm=runpy.run_path("/work/src/main.py")\nassert m["total"](2,3)==5\nprint("build-and-test-passed")');assert(r.passed);assert.match(r.output,/build-and-test-passed/);
});
test('real container rejects source/root writes, host credential/socket access and outbound networking',options,async t=>{
 const r=await run(t,`import os,socket,re\nassert os.getuid()==65534\nstatus=open('/proc/self/status').read()\nassert re.search(r'CapEff:\\s*0+\\n',status)\nassert re.search(r'NoNewPrivs:\\s*1',status)\nassert re.search(r'Cpus_allowed_list:\\s*\\d+\\n',status)\nassert open('/sys/fs/cgroup/memory.max').read().strip()=='268435456'\nassert open('/sys/fs/cgroup/pids.max').read().strip()=='64'\nassert not os.path.exists('/root/.ssh')\nassert not os.path.exists('/var/run/docker.sock')\nassert not os.environ.get('DSH_CONTAINER_IMAGE')\nfor p in ['/work/src/main.py','/not-authorized']:\n try:\n  open(p,'w').write('bad')\n  raise AssertionError('write permitted')\n except OSError: pass\ns=socket.socket();s.settimeout(1)\ntry:\n s.connect(('1.1.1.1',443))\n raise AssertionError('network permitted')\nexcept OSError: pass\nopen('/out/result.txt','w').write('allowed scratch')\nprint('boundaries-passed')`);assert(r.passed);assert.match(r.output,/boundaries-passed/);
});
test('real nonzero command cannot claim success',options,async t=>{const r=await run(t,'raise SystemExit(7)');assert.equal(r.passed,false);assert.equal(r.exit_code,7);});
test('real timeout kills workload and verifies container stop',options,async t=>{const r=await run(t,'import time;time.sleep(300)',{timeout:400});assert.equal(r.passed,false);assert.equal(r.code,'DEVELOPMENT_COMMAND_LIMIT');});
test('real abort does not confuse client close with container drain',options,async t=>{const c=new AbortController();let timer;t.after(()=>clearTimeout(timer));const r=await run(t,'import time;time.sleep(300)',{signal:c.signal,onCreated:()=>{timer=setTimeout(()=>c.abort(),600);}});assert.equal(r.passed,false);assert.equal(r.code,'DEVELOPMENT_COMMAND_CANCELLED');});
test('real background descendants cannot survive container main process exit',options,async t=>{const r=await run(t,'import subprocess,sys\nsubprocess.Popen([sys.executable,"-c","import time;time.sleep(300)"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nprint("child-spawned")');assert(r.passed);assert.match(r.output,/child-spawned/);});
test('real output flood is bounded and workload stopped',options,async t=>{const r=await run(t,'import sys\nwhile True: sys.stdout.write("x"*8192);sys.stdout.flush()');assert.equal(r.passed,false);assert(r.output.length<=65536);});
test('unknown inspect result is not a false drain receipt',options,async t=>{const f=fixture(t,'print("unused")'),operation='operation-'+randomUUID();let closed=0;f.adapter.cli=async(args)=>{if(args[0]==='image')return JSON.stringify([{Id:image,Config:{}}]);throw Error('fixture lost daemon reply before/after create');};await assert.rejects(f.adapter.run(f.workspace,f.hash,'check',{operation,onClosed:()=>closed++}),e=>e.drained===false);assert.equal(closed,0);
 const dead=fixture(t,'print("never actually executed")');dead.adapter.cli=async args=>args[0]==='image'?JSON.stringify([{Id:image,Config:{}}]):'';
 for(const status of ['dead','created']){dead.adapter.inspect=async()=>({Id:'synthetic-unknown-container',State:{Running:false,Pid:0,Status:status}});
 await assert.rejects(dead.adapter.run(dead.workspace,dead.hash,'check',{operation:'operation-'+randomUUID(),onClosed:()=>closed++}),e=>e.message==='DEVELOPMENT_CONTAINER_DRAIN_UNKNOWN'&&e.drained===false);assert.equal(closed,0);}
});
