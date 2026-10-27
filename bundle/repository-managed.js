// Explicit runtime opt-in only. Existing static repositoryAccess stays unchanged.
import {GiteeReadOnly,repositoryURL} from './repository-gitee.js';
import {repositoryAlias} from './onboarding-repositories.js';
const fail=c=>{throw Error('REPOSITORY_'+c);};
export class ManagedGiteeReadOnly {
 constructor(config={},io={}){this.legacy=new GiteeReadOnly(config,io);this.registry=io.registry;this.state=io.state;this.fetch=io.fetch;}
 async registryView(){
  try{return await this.registry.status({});}catch{fail('REGISTRY_UNAVAILABLE');}
 }
 referenceFrom(reference,view){
  if(typeof reference!=='string')fail('INVALID_REFERENCE');
  const matches=view.entries.filter(e=>repositoryAlias(e.alias)===repositoryAlias(reference));
  if(matches.some(e=>!e.enabled)&&!matches.some(e=>e.enabled))return {requires_clarification:true,reason:'REGISTERED_REPOSITORY_DISABLED',candidates:[]};
  return new GiteeReadOnly({aliases:[...this.legacy.aliases,...view.entries.filter(e=>e.enabled).map(e=>({name:e.alias,url:e.url}))]}).reference(reference.trim());
 }
 async reference(reference){return this.referenceFrom(reference,await this.registryView());}
 async resolve(reference,branch){
  const view=await this.registryView(),ref=this.referenceFrom(reference,view);
  if(ref.requires_clarification)return {reference:ref};
  return {reference:ref,snapshot:await this.read('inspect',[ref.url,branch],view)};
 }
 async read(method,args,view){
  view??=await this.registryView();
  const url=repositoryURL(typeof args[0]==='string'?args[0]:args[0].url).url;
  const e=view.entries.find(e=>e.url.toLowerCase()===url.toLowerCase());
  if(e&&!e.enabled)fail('REGISTRATION_DISABLED');
  let provider=this.legacy,credential=null;
  if(e){
   if(typeof args[0]==='object'&&args[0].repository_id!==e.repositoryId)fail('IDENTITY_MISMATCH');
   if(e.authentication==='managed'){
    try{credential=await this.state.readManagedSecret('gitee');}catch{fail('CREDENTIAL_UNAVAILABLE');}
    if(!credential.value)fail('CREDENTIAL_REQUIRED');
   }
   try{provider=new GiteeReadOnly({}, {fetch:this.fetch,...(credential?{token:credential.value}:{})});}catch{fail('INVALID_CREDENTIAL');}
  }
  const result=await provider[method](...args);
  if((await this.registryView()).revision!==view.revision)fail('REGISTRY_CHANGED');
  if(credential){let current;try{current=await this.state.readManagedSecret('gitee');}catch{fail('CREDENTIAL_UNAVAILABLE');}if(current.revision!==credential.revision)fail('CREDENTIAL_CHANGED');}
  if(e&&['inspect','identity'].includes(method)&&result.repository_id!==e.repositoryId)fail('IDENTITY_MISMATCH');
  return result;
 }
 inspect(...a){return this.read('inspect',a);}
 identity(...a){return this.read('identity',a);}
 file(...a){return this.read('file',a);}
 commit(...a){return this.read('commit',a);}
}
