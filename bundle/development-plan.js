import {managedTaskBranch} from './task-branch.js';
// Explicit plan contract. No model-supplied shell string or host executable path.
const fail=()=>{throw Error('DEVELOPMENT_INVALID_WORKSPACE_PLAN');};
const object=(x,keys)=>{if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!keys.includes(k)))fail();};
const budget=(n,max)=>{if(!Number.isInteger(n)||n<1||n>max)fail();return n;};
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export function developmentPath(p){
 if(typeof p!=='string'||Buffer.byteLength(p)>512||!p||/[\\\x00-\x1f\x7f:]/.test(p)||p.startsWith('/')||p.endsWith('/')||
  p.split('/').some(s=>!s||s==='.'||s==='..'||s.toLowerCase()==='.git'||s.startsWith('.dsh-dev-')))fail();
 return p;
}
export function workspacePlan(v){
 object(v,['kind','branch','files','reads','commands','max_writes','max_commands','max_model_requests','executors']);
 if(v.kind!=='workspace-v1'||!managedTaskBranch(v.branch))fail();
 if(!Array.isArray(v.files)||!v.files.length||v.files.length>128||!Array.isArray(v.reads)||v.reads.length>512||
  !Array.isArray(v.commands)||!v.commands.length||v.commands.length>32)fail();
 const files=v.files.map(f=>{object(f,['path','action','base_sha256']);developmentPath(f.path);
  if(!['create','modify','delete'].includes(f.action)||(f.action==='create'?f.base_sha256!==null:!sha(f.base_sha256)))fail();return {...f};});
 const reads=v.reads.map(f=>{object(f,['path','sha256']);developmentPath(f.path);if(!sha(f.sha256))fail();return {...f};});
 const paths=[...files,...reads].map(f=>f.path);if(new Set(paths.map(p=>p.toLowerCase())).size!==paths.length)fail();
 if(paths.some(p=>paths.some(q=>q!==p&&q.startsWith(p+'/'))))fail();
 const commands=v.commands.map(c=>{object(c,['id','image','argv','cwd','timeout_ms','required']);
  if(!/^[a-z][a-z0-9-]{0,63}$/.test(c.id??'')||!/^sha256:[a-f0-9]{64}$/.test(c.image??'')||
   !Array.isArray(c.argv)||!c.argv.length||c.argv.length>64||c.argv.some(a=>typeof a!=='string'||a.includes('\0')||Buffer.byteLength(a)>8192)||
   !/^\/[a-zA-Z0-9_./-]+$/.test(c.argv[0])||c.argv[0].split('/').includes('..')||typeof c.required!=='boolean')fail();
  if(c.cwd!=='.')developmentPath(c.cwd);budget(c.timeout_ms,300000);return {...c,argv:[...c.argv]};});
 if(new Set(commands.map(c=>c.id)).size!==commands.length||!commands.some(c=>c.required))fail();
 if(v.executors!==undefined&&(!Array.isArray(v.executors)||!v.executors.length||v.executors.length>2||
   new Set(v.executors).size!==v.executors.length||v.executors.some(x=>!['local','cloud'].includes(x))))fail();
 return {kind:v.kind,branch:v.branch,files:files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),reads:reads.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),
  commands,max_writes:budget(v.max_writes,256),max_commands:budget(v.max_commands,128),max_model_requests:budget(v.max_model_requests,256),
  ...(v.executors?{executors:[...v.executors].sort()}:{} )};
}

const string={type:'string'},shaSchema={type:'string',pattern:'^[a-f0-9]{64}$'};
const record=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
// Schema is discovery only; workspacePlan remains the authoritative normalization.
export const workspacePlanSchema=record({kind:{type:'string',enum:['workspace-v1']},branch:string,
 files:{type:'array',minItems:1,maxItems:128,items:record({path:string,action:{type:'string',enum:['create','modify','delete']},base_sha256:{anyOf:[shaSchema,{type:'null'}]}})},
 reads:{type:'array',maxItems:512,items:record({path:string,sha256:shaSchema})},
 commands:{type:'array',minItems:1,maxItems:32,items:record({id:string,image:{type:'string',pattern:'^sha256:[a-f0-9]{64}$'},argv:{type:'array',minItems:1,maxItems:64,items:string},cwd:string,timeout_ms:{type:'integer',minimum:1,maximum:300000},required:{type:'boolean'}})},
 max_writes:{type:'integer',minimum:1,maximum:256},max_commands:{type:'integer',minimum:1,maximum:128},max_model_requests:{type:'integer',minimum:1,maximum:256},executors:{type:'array',minItems:1,maxItems:2,items:{type:'string',enum:['local','cloud']}}
},['kind','branch','files','reads','commands','max_writes','max_commands','max_model_requests']);
