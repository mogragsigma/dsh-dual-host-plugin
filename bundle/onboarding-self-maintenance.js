// Read-only classification through the official manager. Never adopt a directory
// from a module URL or accept a caller-selected entry/package as our identity.
import {createHash} from 'node:crypto';
const packageName='@mogragsigma/dsh-dual-host-plugin';
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const phases=['pending','loading','active','failed','unloading',null];
const bounded=x=>typeof x==='string'&&x.length>0&&x.length<=4096&&!/[\x00-\x1f]/.test(x);
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const entryView=x=>({enabled:x.enabled,phase:x.fiberPhase,readOnlyReason:x.readOnlyReason??null});
const validEntry=x=>object(x)&&bounded(x.entryId)&&bounded(x.moduleName)&&typeof x.enabled==='boolean'&&phases.includes(x.fiberPhase)&&[undefined,'management-required','unaddressable'].includes(x.readOnlyReason);
const sameEntry=(a,b)=>a.entryId===b.entryId&&a.moduleName===b.moduleName&&JSON.stringify(entryView(a))===JSON.stringify(entryView(b));
export function createOnboardingSelfMaintenance({manager=()=>null,entryId=null,now=Date.now}={}){
 async function status(args={}){
  if(!object(args)||Object.keys(args).length)throw Error('ONBOARDING_INVALID_ARGUMENTS');
  const base={contract:1,scope:'current_host_own_plugin',packageName,observedAt:now(),expiresAt:now()+60000,readOnly:true,canApply:false,hostStopAuthorized:false,
   mutationsImplemented:false,wholeHostRemoval:false,dataDeletion:false,
   risks:['late_native_input_may_abort','self_unload_may_lose_reply'],
   retained:['user_rules','unknown_skills','credentials','sessions','tasks','artifacts','backups','third_party_dependencies'],
   workflow:['protect_rules_and_skills_separately','official_manager_owns_package_lifecycle','explicit_risk_consent_before_host_stop','reconcile_unknown_result_before_new_action'],
   limitations:['not_an_idle_check','not_a_stop_or_removal_plan','no_atomic_inventory_snapshot','read_only_inspection_use_separate_disable_plan']};
  const result=(state,extra={})=>({...base,state,...extra});
  if(!bounded(entryId))return result('own_entry_unresolved');
  let owner;try{owner=manager();}catch{return result('manager_unavailable');}
  if(!owner||typeof owner.listPlugins!=='function'||typeof owner.listBundles!=='function')return result('manager_unavailable');
  try{
   const entries=await owner.listPlugins();
   if(!Array.isArray(entries)||entries.length>4096||entries.some(x=>!validEntry(x)))return result('inventory_review');
   const matches=entries.filter(x=>x.entryId===entryId);
   if(matches.length!==1)return result(matches.length?'inventory_review':'own_entry_not_observed');
   const own=matches[0],bundles=await owner.listBundles();
   if(!Array.isArray(bundles)||bundles.length>1024||bundles.some(b=>!object(b)||!bounded(b.name)||!Array.isArray(b.rows)||b.rows.length>4096||b.rows.some(x=>!object(x)||!bounded(x.moduleName)||(x.entryId!==undefined&&!bounded(x.entryId)))))return result('inventory_review');
   const reread=await owner.listPlugins();
   if(manager()!==owner||!Array.isArray(reread)||reread.length>4096)return result('inventory_changed');
   const current=reread.filter(x=>x?.entryId===entryId);
   if(current.length!==1||!validEntry(current[0])||!sameEntry(own,current[0]))return result('inventory_changed');
   const associated=bundles.filter(b=>b.rows.some(x=>x.entryId===entryId));
   const entry=entryView(own),identityDigest=digest({entryId,moduleName:own.moduleName});
   if(associated.length>1)return result('inventory_review',{entry,identityDigest});
   if(!associated.length)return result('entry_only',{entry,identityDigest,entryToggleListed:own.readOnlyReason===undefined,packageRemovalListed:false,reason:'no_unique_bundle_relationship'});
   const bundle=associated[0];
   // Name alone cannot establish ownership. Shared/overriding packages are not
   // safe self-removal targets even when the upstream manager lists them removable.
   if(bundle.name!==packageName||bundle.rows.some(x=>x.entryId!==entryId||x.moduleName!==own.moduleName)||bundle.rows.length!==1||!Array.isArray(bundle.overrides)||bundle.overrides.length)return result('bundle_scope_review',{entry,identityDigest});
   if(!['profile','installation','missing'].includes(bundle.availability)||['enabled','installed','removable'].some(k=>typeof bundle[k]!=='boolean')||![undefined,'management-required','unaddressable'].includes(bundle.readOnlyReason))return result('inventory_review',{entry,identityDigest});
   const version=typeof bundle.version==='string'&&/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(bundle.version)&&bundle.version.length<=128?bundle.version:null;
   const summary={availability:bundle.availability,enabled:bundle.enabled,installed:bundle.installed,removableListed:bundle.removable,version,hasProblem:!!bundle.error,readOnlyReason:bundle.readOnlyReason??null};
   const listed=bundle.availability==='profile'&&bundle.installed&&bundle.removable&&!bundle.readOnlyReason&&!bundle.error;
   return result(listed?'profile_bundle_observed':'bundle_not_self_manageable',{entry,identityDigest,bundle:summary,packageRemovalListed:listed,entryToggleListed:own.readOnlyReason===undefined});
  }catch{return result('manager_query_failed');}
 }
 return {status};
}
