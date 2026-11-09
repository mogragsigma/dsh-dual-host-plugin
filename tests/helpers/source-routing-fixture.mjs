import {fixture} from './continuity-fixture.mjs';
import {source,event,batch} from './source-fixture.mjs';
import {CLOUD_TASK_POLICY} from '../../bundle/managed-cloud-policy.js';
import {makeEnvelope} from '../../bundle/task-envelope.js';
import {mkdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
export const model={provider:'fixture',model:'fixture'};
export function positive(e,rules=['copy']){return {assessment:{decision:'accept',reason:'明确局部修正',rules:rules.map(id=>({id,matched:true,reason:'specified correction'})),implementation_requested:true,target_settled:true,requires_design_decision:false,evidence:e.text,title:'修正 '+e.id,goal:'修正文案，不提交不外发：'+e.text.slice(0,400)},model,usage:{input:3,output:2}};}
export function routingFixture(t,options={}){
 let calls=0,cursor=null,number=0;
 const f=fixture(t,{managedExecution:{enabled:true},sourceIntake:{enabled:true,sources:[source()]},sourceRouting:{assess:async({event,policy,signal})=>{calls++;return options.assess?options.assess({event,policy,signal}):positive(event,policy.rules);}},...options.fixture});
 f.g.ctx.llm.resolveCallConfig=async p=>Object.keys(p).length?p:model;
 const r=f.g.sourceRouting,port=r.adapter('fixture','fixture-adapter');
 const config=(extra={})=>({id:'copy-policy',period_id:'first',source_id:'fixture',scope:'project',goal:'只做明确文案修正',rules:['copy'],cwd:realpathSync(f.dir),delivery:'工作区保留成果，不提交、不外发',max_tasks:3,...extra});
 const ctl=(args,original=f.source('按明确方案设置；不调用真实模型，不发送消息。'))=>r.control(original.role,{...args,source:original});
 const save=(extra={},more={})=>ctl({action:'set_policy',expected_revision:r.latest(extra.id??'copy-policy')?.revision??0,policy:config(extra),...more});
 const mode=value=>ctl({action:'mode',mode:value,expected_version:r.mode().version});
 const push=(id='event-'+(++number),extra={})=>{const next='page-'+(++number);const result=port.receiveBatch(batch([event(id,{text:'请将“安桩”改为“安装”。',...extra})],cursor,next,port.status().currentConfigRevision));cursor=next;return result;};
 const create=async(name='manual')=>{const agent=f.agent('manual-'+name,'请完成 '+name),e=makeEnvelope(agent,'local',{goal:name,target:'cloud',intent:'register',continuity:1,notification_contract:1,execution_policy:CLOUD_TASK_POLICY,channel:'local-dsh'}),a=await f.g.call('accept',{goal:e.goal,task_key:e.task_key,ingress_id:e.ingress_id,source:'native-local'},'local');const cwd=join(f.dir,name);mkdirSync(cwd);await f.g.call('execution_start',{task_id:a.id,expected_revision:1,cwd,role:'cloud'},'local');return a.id;};
 const claim=()=>f.g.execution.claim('cloud',{instance_id:'fixture-endpoint',development_contract:1,autonomy_contract:1}).item;
 const binding=x=>({task_id:x.task_id,claim:x.claim,instance_id:x.instance});
 const begin=()=>{const item=claim();return item?f.g.execution.begin('cloud',binding(item)).item:null;};
 const finish=item=>{const s=f.g.execution.validate('cloud',binding(item));return f.g.execution.finish('cloud',{...binding(item),outcome:'ready',summary:'fixture completed',session_id:'managed-'+item.task_id,drained:true,completion:{input_cursor:s.input_cursor,control_version:s.control_version,round:item.runs}});};
 return {...f,r,port,config,ctl,save,mode,push,create,claim,begin,finish,binding,get calls(){return calls;}};
}
