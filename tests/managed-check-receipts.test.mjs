// Plain-file fixtures only: this suite never initializes or writes a Git repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,realpathSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ManagedDevelopment} from '../bundle/managed-development.js';
function fixture(t){
 const cwd=realpathSync(mkdtempSync(join(tmpdir(),'managed-check-receipt-')));writeFileSync(join(cwd,'source.txt'),'original');
 const db=new DatabaseSync(':memory:'),dev=new ManagedDevelopment({db,g:{now:()=>1234,c:{role:'cloud'}}});
 const d={delivery:'workspace',checks:[{name:'verify',command:'node --test test.mjs'}],artifacts:['source.txt']};
 const b={item:{task_id:'fixture',revision:1,spec:{cwd,development:d}}};dev.begin(b);
 t.after(()=>{db.close();rmSync(cwd,{recursive:true,force:true});});
 const run=(command=d.checks[0].command,result={value:{exitCode:0}},name='bash')=>{const token=dev.before(b,{name,arguments:name==='bash'?{command}:{name:command}},cwd);dev.after(b,token,result);return token;};
 return {cwd,dev,d,b,run,state:()=>dev.inspect(b).checks[0].state};
}
test('exact checks and stderr-only suffix retain a real foreground exit receipt',t=>{
 const f=fixture(t);assert.equal(f.dev.inspect(f.b).checks[0].command,f.d.checks[0].command);
 for(const command of [f.d.checks[0].command,f.d.checks[0].command+' 2>&1']){assert(f.run(command));assert.equal(f.state(),'passed');assert.equal(f.dev.ready(f.b,'review').delivery.state,'workspace_ready');}
});
test('no shell normalization or workdir bypass can manufacture a named receipt',t=>{
 const f=fixture(t),cmd=f.d.checks[0].command;
 for(const command of [cmd+' || true',cmd+'; true',cmd+' | cat',cmd+' && true',cmd+' 2>&1; true','echo '+cmd,cmd+' &',cmd+' 2>/dev/null'])assert.equal(f.run(command),null);
 assert.equal(f.dev.before(f.b,{name:'bash',arguments:{command:cmd}},f.cwd+'/other'),null);
 assert.equal(f.state(),'not_run');
});
test('failed, interrupted, unknown and background checks never pass',t=>{
 const f=fixture(t);
 for(const result of [{value:{exitCode:1}},{value:{kind:'background'}},{value:{kind:'promoted'}},{value:{exitCode:0,timedOut:true}},{value:{exitCode:0,aborted:true}},{value:{exitCode:0,signal:'TERM'}},{isError:true,value:{exitCode:0}},null]){
  f.run(f.d.checks[0].command+' 2>&1',result);assert.notEqual(f.state(),'passed');assert.throws(()=>f.dev.ready(f.b,'review'),/CHECKS_NOT_CURRENT: read managed_evidence/);
 }
});
test('changed or stale trees require fresh checks even with stderr redirection',t=>{
 const f=fixture(t);f.run();writeFileSync(join(f.cwd,'source.txt'),'after');assert.equal(f.state(),'stale');
 const token=f.dev.before(f.b,{name:'bash',arguments:{command:f.d.checks[0].command+' 2>&1'}},f.cwd);writeFileSync(join(f.cwd,'source.txt'),'during');f.dev.after(f.b,token,{value:{exitCode:0}});assert.equal(f.state(),'changed_during_check');
 f.run();assert.equal(f.state(),'passed');
});
test('local approved names stay exact and cannot accept shell suffixes',t=>{
 const f=fixture(t);f.d.checks=[{name:'verify',command:'test'}];assert.equal(f.run('test 2>&1',undefined,'managed_command'),null);assert(f.run('test',{exit_code:0,drained:true},'managed_command'));assert.equal(f.state(),'passed');
});
test('same-named renewed contract does not inherit its old command receipt',t=>{
 const f=fixture(t);f.run();f.d.checks[0].command='node --test new.mjs';const c=f.dev.inspect(f.b).checks[0];assert.equal(c.state,'not_run');assert.equal(c.command,'node --test new.mjs');assert.throws(()=>f.dev.ready(f.b,'review'),/CHECKS_NOT_CURRENT/);
});
test('missing and stale checks expose an exact invocation without loosening receipt validation',t=>{
 const f=fixture(t),expected={tool:'bash',arguments:{description:'Run named check: verify',command:f.d.checks[0].command,workdir:f.cwd,run_in_background:false}};
 assert.deepEqual(f.dev.inspect(f.b).checks[0].required_invocation,expected);
 assert.equal(f.run('cd '+f.cwd+' && '+f.d.checks[0].command+'; echo $?'),null);
 assert.throws(()=>f.dev.ready(f.b,'review'),/required_invocation.*workdir/);
 f.run();assert.equal(f.dev.inspect(f.b).checks[0].required_invocation,undefined);
 writeFileSync(join(f.cwd,'source.txt'),'changed');assert.deepEqual(f.dev.inspect(f.b).checks[0].required_invocation,expected);
 f.dev.e.g.c.role='local';assert.deepEqual(f.dev.inspect(f.b).checks[0].required_invocation,{tool:'managed_command',arguments:{name:f.d.checks[0].command}});
});
