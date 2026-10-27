export const inject=['tools','taskGateway'];
export function apply(ctx){
 const service=ctx.taskGateway;
 const register=(name,fields,run,optional=[])=>ctx.tools.register({name,description:name==='task_control'?'Persist an explicitly requested pause, resume or cancel of a job. No approval or write authority; paused is not proof of drained execution.':name==='task_schedule'?'Persist a bounded read-only planning batch with an explicit model route; never approves development.':name==='task_submit'?'Submit a task to cloud authority and return immediately. Load task-intake Skill first.':'Read task state once; no polling.',parameters:{type:'object',properties:Object.fromEntries([...fields,...optional].map(x=>[x,{type:'string',...(x==='action'?{enum:['pause','resume','cancel']}:{})}])),required:fields,additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_a,r)=>[{type:'text',text:JSON.stringify(r)}]},execute(a,e){service.assertAgent(e.agent);return run(a,e);}});
 register('task_submit',['task_key','goal'],(a,e)=>service.submit({...a,source:'desktop',ingress_id:'desktop:'+e.agent.id+':'+e.callId}));
 register('task_status',['task_id'],a=>service.call('status',a));
 register('task_schedule',['task_id','provider','model','delay_seconds'],(a,e)=>service.call('schedule',{task_id:a.task_id,policy:{provider:a.provider,model:a.model,...(a.reasoning_effort?{reasoningEffort:a.reasoning_effort}:{})},delay_seconds:Number(a.delay_seconds),trigger_id:'desktop:'+e.agent.id+':'+e.callId}),['reasoning_effort']);
 register('task_control',['job_id','action'],(a,e)=>{
  if(!['pause','resume','cancel'].includes(a.action))throw Error('INVALID_CONTROL_ACTION');
  return service.call('job_control',{job_id:a.job_id,action:a.action,event_id:'desktop:'+e.agent.id+':'+e.callId});
 });
 ctx.tools.guard(e=>['skill','task_submit','task_status','task_schedule','task_control'].includes(e.name)?undefined:'MANAGED_ENTRY_CAPABILITY_DENIED');
}
