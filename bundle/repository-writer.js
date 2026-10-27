import {execFileSync} from 'node:child_process';
import {readFileSync,realpathSync,lstatSync,writeFileSync,renameSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {resolve,join,relative,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

// Operator-owned bindings, never supplied by a model tool. No push or generic shell capability.
export class RepositoryWriter {
  constructor(bindings={}){this.bindings=new Map(Object.entries(bindings));}
  assertBound(id){if(!this.bindings.has(id))throw Error('REPOSITORY_NOT_BOUND');}
  target(id){
    this.assertBound(id);const b=this.bindings.get(id);
    if(!/^dsh-task\/[a-z0-9-]+$/.test(b.branch))throw Error('BRANCH_DENIED');
    const root=realpathSync(b.root);
    if(root!==resolve(b.root))throw Error('ROOT_SYMLINK_DENIED');
    if(!b.path||b.path.includes('\\')||b.path.startsWith('/')||b.path.split('/').some(x=>!x||x==='.'||x==='..'||x.startsWith('.')))throw Error('PATH_DENIED');
    const file=resolve(root,b.path);
    if(relative(root,file).startsWith('..'))throw Error('PATH_DENIED');
    let cursor=root;
    for(const part of b.path.split('/')){
      cursor=join(cursor,part);
      try{if(lstatSync(cursor).isSymbolicLink())throw Error('SYMLINK_DENIED');}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    if(realpathSync(dirname(file))!==dirname(file))throw Error('PARENT_DENIED');
    if(this.git(root,['rev-parse','--show-toplevel']).trim()!==root)throw Error('REPOSITORY_ROOT_MISMATCH');
    if(this.git(root,['branch','--show-current']).trim()!==b.branch)throw Error('BRANCH_MISMATCH');
    // Linked worktrees/submodules can share writable Git metadata outside our boundary.
    if(!lstatSync(join(root,'.git')).isDirectory())throw Error('SHARED_GITDIR_DENIED');
    return {...b,root,file};
  }
  git(root,args){return execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','core.fsmonitor=false','-C',root,...args],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'},stdio:['ignore','pipe','pipe']});}
  contents(id){if(!this.bindings.has(id))return '';const b=this.target(id);try{return readFileSync(b.file,'utf8');}catch(e){if(e.code==='ENOENT')return '';throw e;}}
  write(q){
    const b=this.target(q.task_id);
    if(this.git(b.root,['status','--porcelain','--untracked-files=all']).trim())throw Error('DIRTY_REPOSITORY');
    const temp=join(dirname(b.file),'.dsh-pending-'+randomUUID());
    writeFileSync(temp,q.content,{mode:0o600,flag:'wx'});
    const fd=openSync(temp,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(temp,b.file);const dir=openSync(dirname(b.file),'r');try{fsyncSync(dir);}finally{closeSync(dir);}
    this.git(b.root,['add','--',b.path]);
    this.git(b.root,['-c','user.name=DSH Task Gate','-c','user.email=dsh-task@localhost','commit','--no-verify','-m','DSH controlled write '+q.id,'--',b.path]);
    return this.git(b.root,['rev-parse','HEAD']).trim();
  }
}
