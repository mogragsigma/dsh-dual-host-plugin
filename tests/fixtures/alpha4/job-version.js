// Durable execution semantics, not plugin semver. Unknown readers must hold the job.
import {parseEnvelope} from './task-envelope.js';
export const supportedJobVersions=new Set(['0.5.0','0.17.0','0.17.1','0.18.0','0.18.1','0.18.2','0.18.3']);
export const isWorkflowJobVersion=v=>['0.17.1','0.18.1','0.18.3'].includes(v);
export const isSourceJobVersion=v=>['0.18.0','0.18.1','0.18.2','0.18.3'].includes(v);
export const isSearchJobVersion=v=>['0.18.2','0.18.3'].includes(v);
export function requiredJobVersion(j){
 if(j.kind==='plan'&&parseEnvelope(j.goal)?.search)return isWorkflowJobVersion(j.version)?'0.18.3':'0.18.2';
 if(j.kind==='plan'&&parseEnvelope(j.goal)?.task_context?.references?.length)return isWorkflowJobVersion(j.version)?'0.18.1':'0.18.0';
 return j.version;
}
