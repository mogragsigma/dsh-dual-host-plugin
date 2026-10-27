// One-shot, zero-model admission check using public DSH services. Never drives an agent loop.
import fs from 'node:fs/promises';
import {VERSION} from './link-contract.js';
import {createNativeInspectionGuard} from './onboarding-inspection-guard.js';
import {isManagedGatewayRuntime} from './onboarding-task-runtime-contract.js';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {agentEvents,assembleContextFor} from '@deepseek-ai/dsh-agent';
export const inject=['agents','agentPresets','agentDefaultModel','sessions','skills','systemPrompt','connection','webServer'];
const sha=b=>createHash('sha256').update(b).digest('hex');
export function apply(ctx,c){
 const timer=setTimeout(async()=>{
  let rows=[],stage='roster';const guard=createNativeInspectionGuard(ctx,c.nonce);
  try{
   const roster=await ctx.agentPresets.list(),compat=JSON.parse(await fs.readFile(new URL('./compatibility.json',import.meta.url)));
   const require=createRequire(import.meta.url),host=JSON.parse(await fs.readFile(require.resolve('@deepseek-ai/dsh/package.json')));
   if(host.version!==compat.hostBaseline)throw Error('NATIVE_HOST_VERSION_REVIEW');
   for(const preset of ['standard','ptc','cordis','minimal']){
    if(!roster.some(x=>x.id===preset))throw Error('NATIVE_PRESET_MISSING');
    stage=preset+':create';const h=await ctx.agents.withoutInitiator(()=>ctx.agents.create({sessionId:'onboarding-check-'+c.nonce+'-'+preset,meta:{cwd:c.workspace,agentPreset:preset},agentOptions:ctx.agentDefaultModel.currentSelection(),setup:async ac=>{await ctx.agentPresets.mount(ac,preset);}}));
    try{
     const agent=h.agent,options={scope:agent,cwd:c.workspace};
     stage=preset+':skills';const catalog=await ctx.skills.snapshot(options),body=await ctx.skills.get('task-onboarding',options);
     const msg={id:randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text:'Configuration capability inspection only; do not run a task.'}]};
     stage=preset+':instructions';const decision=await agentEvents(ctx,agent).waterfall('agent/pre-step',{messages:[msg],turn:1,step:1,signal:AbortSignal.timeout(15000)},async()=>({kind:'enter',messages:[msg]}));
     const instructions=decision.messages?.filter(x=>x.source?.kind==='agent-instructions')??[];
     const text=instructions.flatMap(m=>m.content).filter(x=>x.type==='text').map(x=>x.text).join('\n'),assembly=await ctx.systemPrompt.assemble(assembleContextFor(agent));
     const globalSkills=catalog.skills.filter(x=>compat.globalSkills.includes(x.name));
     const pathsValid=compat.globalSkills.every(name=>globalSkills.some(s=>s.name===name&&s.resourceBase?.path===path.join(c.dshHome,'skills',name)));
     const globalRuleLoaded=text.includes('dsh-dual-host:end')&&text.includes('云端大肥鱼（Host role：cloud）');
     const valid=preset==='minimal'?globalSkills.length===0&&!text:pathsValid&&globalRuleLoaded&&body?.content?.includes('配置导览');
     stage=preset+':check';
     rows.push({preset,idle:agent.status==='idle',catalogComplete:catalog.complete,valid,globalRuleLoaded,globalSkillPathsVerified:pathsValid,globalSkillCount:globalSkills.length,skillBodyLoaded:!!body?.content?.includes('配置导览'),instructionSha256:sha(text),tools:assembly.tools.map(x=>x.name).sort()});
     if(!catalog.complete||!valid||agent.status!=='idle')throw Error('NATIVE_CONTEXT_NOT_READY');
    }finally{await h.dispose();}
   }
   let im=null;
   if(c.expectedIm===true){
    stage='optional-im';const service=ctx.get('dshIm');
    const pkg=JSON.parse(await fs.readFile(createRequire(import.meta.url).resolve('@xmanrui/dsh-im/package.json')));
    const expected=JSON.parse(await fs.readFile(new URL('./runtime-im-package.json',import.meta.url))).dependencies?.['@xmanrui/dsh-im'];
    if(!expected||pkg.version!==expected||service?.contractVersion!==1||typeof service.listBots!=='function')throw Error('NATIVE_IM_NOT_READY');
    const rows=await service.listBots();if(!Array.isArray(rows))throw Error('NATIVE_IM_NOT_READY');
    im={version:pkg.version,contract:1,botsConfigured:rows.length};
   }
   const gateway=ctx.get('taskGateway'),manager=ctx.get('onboardingTaskRuntime'),taskRuntime=manager?await manager.status({}):null;
   const runtimeScopeVerified=isManagedGatewayRuntime(gateway,taskRuntime);
   const origin=ctx.webServer.getOrigin();if(new URL(origin).hostname!=='127.0.0.1'||guard.attempts)throw Error('NATIVE_ADMISSION_SCOPE');
   await fs.writeFile(path.join(c.control,'native-access.json'),JSON.stringify({url:ctx.connection.authenticatedUrl(origin)}),{flag:'wx',mode:0o600});
   await fs.writeFile(path.join(c.control,'native-receipt.json'),JSON.stringify({ok:true,nonce:c.nonce,pid:process.pid,hostVersion:host.version,pluginVersion:VERSION,origin,im,roster:roster.map(x=>x.id),rows,modelAttempts:guard.attempts,modelAttemptScope:guard.scope,gatewayBound:!!gateway,taskRuntime,runtimeScopeVerified,workspace:c.workspace,dshHome:c.dshHome,agentsHome:c.agentsHome}),{flag:'wx',mode:0o600});
  }catch(e){await fs.writeFile(path.join(c.control,'native-diagnostic.json'),JSON.stringify({stage,name:e.name,code:e.code??null,message:String(e.message).slice(0,1000)}),{flag:'wx',mode:0o600}).catch(()=>{});await fs.writeFile(path.join(c.control,'native-receipt.json'),JSON.stringify({ok:false,nonce:c.nonce,pid:process.pid,error:/^NATIVE_[A-Z_]+$/.test(e.message)?e.message:'NATIVE_ADMISSION_FAILED',stage,rows,modelAttempts:guard.attempts,modelAttemptScope:guard.scope}),{flag:'wx',mode:0o600}).catch(()=>{});}
  finally{guard.dispose();}
 },1800);
 ctx.effect(()=>()=>clearTimeout(timer));
}
