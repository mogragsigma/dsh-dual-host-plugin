import {readFileSync} from 'node:fs';
import {identity} from './task-envelope.js';
const rules=readFileSync(new URL('./native-rules/AGENTS.md',import.meta.url),'utf8');
// Additive native context, not a replacement for workspace/user AGENTS or preset.
export function installNativeContext(ctx){
 return ctx.inject(['systemPrompt'],scope=>scope.systemPrompt.context({
  name:'dsh-task-gateway-native-rules',order:80,
  text:assembly=>{
   try{ctx.taskGateway.assertNativeAgent(assembly?.agent);}catch{return '';}
   const who=identity(ctx.taskGateway.c.role);
   return `${rules}\n\n## 当前 Host 的真实身份（插件配置，非用户文本）\n${JSON.stringify(who)}\n你现在是${who.name}的入口会话，不是独立 worker。对端是${who.peer_name}。\n`;
  },
 }));
}
