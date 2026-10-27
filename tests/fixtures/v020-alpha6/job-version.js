// Durable execution semantics, not plugin semver. Unknown readers must hold the job.
import {parseEnvelope} from './task-envelope.js';
export const supportedJobVersions=new Set(['0.5.0','0.17.0','0.17.1','0.18.0','0.18.1','0.18.2','0.18.3','0.19.0','0.19.1','0.19.2']);
export const isWorkflowJobVersion=v=>['0.17.1','0.18.1','0.18.3','0.19.1'].includes(v);
export const isSourceJobVersion=v=>['0.18.0','0.18.1','0.18.2','0.18.3','0.19.0','0.19.1'].includes(v);
export const isSearchJobVersion=v=>['0.18.2','0.18.3','0.19.0','0.19.1'].includes(v);
export function requiredJobVersion(j){
 if(j.kind==='development'&&parseEnvelope(j.goal)?.notification_contract===1)return '0.19.2';
 if(j.kind==='plan'&&parseEnvelope(j.goal)?.notification_contract===1)return isWorkflowJobVersion(j.version)?'0.19.1':'0.19.0';
 if(j.kind==='plan'&&parseEnvelope(j.goal)?.search)return isWorkflowJobVersion(j.version)?'0.18.3':'0.18.2';
 if(j.kind==='plan'&&parseEnvelope(j.goal)?.task_context?.references?.length)return isWorkflowJobVersion(j.version)?'0.18.1':'0.18.0';
 return j.version;
}
