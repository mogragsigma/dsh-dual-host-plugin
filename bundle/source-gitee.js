// First live transport: explicitly selected Gitee issues, not repository-wide
// discovery, comments, webhooks or an IM consumer. Existing tick/credential/DB seams.
import {createHash} from 'node:crypto';
import {repositoryURL} from './repository-gitee.js';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export class GiteeIssueSources {
 constructor(g){this.g=g;this.closed=false;this.pending=null;this.states=new Map();}
 status(id){return this.states.get(id)??{transport:'not-attached',live_verified:false};}
 config(c){
  const x=c.gitee;
  if(c.adapterId!=='gitee-issues-v1'||!x||Object.keys(x).some(k=>!['url','repository_id','issues'].includes(k))||
   !Number.isSafeInteger(x.repository_id)||x.repository_id<=0||c.namespace!=='gitee-repository-'+x.repository_id||
   !Array.isArray(x.issues)||!x.issues.length||x.issues.length>8||new Set(x.issues).size!==x.issues.length||
   x.issues.some(n=>typeof n!=='string'||!/^I[A-Z0-9]{1,20}$/.test(n)))throw Error('SOURCE_GITEE_CONFIG_INVALID');
  const url=repositoryURL(x.url).url;if(c.scopes.length!==1||c.scopes[0]!==url)throw Error('SOURCE_GITEE_SCOPE_INVALID');
  return {...x,url,issues:[...x.issues].sort()};
 }
 tick(){
  if(this.closed||this.g.closed||this.g.maintenance.blocked||this.g.c.sourceIntake?.enabled!==true)return Promise.resolve();
  if(this.pending)return this.pending;
  this.pending=this.g.maintenance.run('source_gitee',()=>this.run()).finally(()=>{this.pending=null;});return this.pending;
 }
 async run(){
  for(const base of this.g.sourceRouting.configs().filter(c=>c.gitee)){
   if(this.closed||this.g.closed||this.g.maintenance.blocked)return;
   if(!this.g.sourceRouting.config(base).enabled)continue;
   const old=this.status(base.id);if((old.next_poll??0)>this.g.now())continue;
   const state={...old,transport:'gitee-selected-issues',next_poll:this.g.now()+30000};this.states.set(base.id,state);
   try{
    const config=this.config(base),row=this.g.sourceRouting.sourceRow(base.id),port=this.g.sourceRouting.adapter(base.id,base.adapterId),before=port.status(),items=[];
    for(const n of config.issues){
     if(this.closed||this.g.closed||this.g.maintenance.blocked) return;
     this.g.sourceRouting.assertSource(base.id);
     items.push(await this.g.repositories.provider.issue(config,n));
    }
    if(this.closed||this.g.closed||this.g.maintenance.blocked)return;
    this.g.sourceRouting.assertSource(base.id);
    if(port.status().currentConfigRevision!==before.currentConfigRevision)throw Error('SOURCE_GITEE_CONFIG_CHANGED');
    // Re-enabling/rebinding takes a current snapshot, not a replay of the
    // disabled interval. Config revision is durable in the existing intake row.
    const baseline=before.configRevision!==null?before.configRevision!==before.currentConfigRevision:row.revision>0;
    const next='gitee-issues-v1:'+digest([before.currentConfigRevision,items]),events=(baseline?[]:items).filter(x=>['open','progressing'].includes(x.state)).map(x=>({
     id:'gitee-issue:'+x.id+':'+digest(x),scope:config.url,occurredAt:x.updated_at,actor:x.actor,
     thread:{id:'gitee-issue:'+x.id},text:x.title+'\n'+x.body,url:x.url,
    }));
    if(next!==before.cursor)port.receiveBatch({expectedCursor:before.cursor,nextCursor:next,configRevision:before.currentConfigRevision,events});
    Object.assign(state,{live_verified:true,last_poll_success:this.g.now(),last_poll_error:null,selected_issues:config.issues.length,baseline_only:baseline});
   }catch(e){state.last_poll_error=/^(SOURCE_|REPOSITORY_)[A-Z_]+$/.test(e.message)?e.message:'SOURCE_GITEE_UNAVAILABLE';}
  }
 }
 close(){this.closed=true;return this.pending??Promise.resolve();}
}
