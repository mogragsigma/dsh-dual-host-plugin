import {workspacePlan} from './development-plan.js';
import {canonical,digest} from './approval-ledger.js';

// Deliberately one bounded code exercise, not an arbitrary shell/build adapter.
export function developmentSpec(value){
 if(value?.kind==='workspace-v1')return workspacePlan(value);
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['kind','branch','file','validator','max_writes','executors'].includes(k)))throw Error('DEVELOPMENT_INVALID_SPEC');
 if(value.kind!=='bounded-js-v1'||!/^dsh-task\/[a-z0-9-]{1,64}$/.test(value.branch??'')||!/^s[0-9]+-task-summary\.mjs$/.test(value.file??'')||value.validator!=='task-summary-v1'||!Number.isInteger(value.max_writes)||value.max_writes<1||value.max_writes>3)throw Error('DEVELOPMENT_INVALID_SPEC');
 if(value.executors!==undefined&&(!Array.isArray(value.executors)||!value.executors.length||value.executors.length>2||new Set(value.executors).size!==value.executors.length||value.executors.some(x=>!['local','cloud'].includes(x))))throw Error('DEVELOPMENT_INVALID_SPEC');
 return {...(value.executors?{executors:[...value.executors].sort()}:{}),kind:value.kind,branch:value.branch,file:value.file,validator:value.validator,max_writes:value.max_writes};
}
export function approvedDevelopment(ledger,task,approval,policy,{review=false}={}){
 const v=ledger.view(approval),spec=developmentSpec(v.proposal.development);
 if(review)v.state=ledger.validity(ledger.row(approval),{ignoreTaskBlock:true});
 if(v.task_id!==task||v.state!=='approved'||v.proposal.scopes.length!==1||v.proposal.scopes[0]!=='develop'||!v.proposal.repository||canonical(v.proposal.model_policy)!==canonical(policy))throw Error('DEVELOPMENT_APPROVAL_REQUIRED');
 return {approval:v,spec,hash:digest({approval:v.id,proposal_hash:v.proposal_hash,spec})};
}
