import {randomUUID} from 'node:crypto';
import {SEMANTIC_SYSTEM} from './approval-semantics.js';
import {validPolicy} from './task-context.js';
// Public DSH LLM seam. No agent, tools, session, filesystem or development executor is created.
export function semanticClassifier(ctx,config){
 if(!config?.enabled||!config.policy)return undefined;
 const policy=validPolicy(config.policy);
 const classify=async({text,proposal,signal})=>{
  const {BlockAssembler,createUserMessage}=await import('@deepseek-ai/dsh-llm');
  const deadline=AbortSignal.any([signal,AbortSignal.timeout(45000)]),llm=ctx.llm??ctx.get?.('llm');
  if(!llm)throw Error('CHAT_SEMANTIC_MODEL_UNAVAILABLE');
  const call=await llm.prepareCall({...policy,maxTokens:800},deadline);
  if(call.config.provider!==policy.provider||call.config.model!==policy.model||call.config.maxTokens!==800||(policy.reasoningEffort!==undefined&&call.config.reasoningEffort!==policy.reasoningEffort))throw Error('CHAT_SEMANTIC_ROUTE_CHANGED');
  const messages=[createUserMessage({content:[{type:'text',text:JSON.stringify({proposal,user_reply:text})}],source:{kind:'dsh-approval-interpretation'}})];
  const assembled=new BlockAssembler();let bytes=0,finished=false;
  for await(const chunk of call.stream({...call.config,system:SEMANTIC_SYSTEM,messages,tools:[],sessionId:'approval-interpret-'+randomUUID(),purpose:'approval-interpretation',signal:deadline})){
   deadline.throwIfAborted();bytes+=JSON.stringify(chunk).length;if(bytes>24000)throw Error('CHAT_SEMANTIC_OUTPUT_LIMIT');assembled.push(chunk);if(chunk.type==='finish')finished=true;
  }
  deadline.throwIfAborted();if(!finished||assembled.finish.kind!=='stop')throw Error('CHAT_SEMANTIC_INCOMPLETE');
  const blocks=assembled.blocks();if(blocks.some(b=>!['text','reasoning'].includes(b.type)))throw Error('CHAT_SEMANTIC_TOOL_DENIED');
  const outputText=blocks.filter(b=>b.type==='text').map(b=>b.text).join('').trim();
  const json=/^```(?:json)?\s*\n([\s\S]*?)\n```$/u.exec(outputText)?.[1]??outputText;
  try{return JSON.parse(json);}catch{throw Error('CHAT_SEMANTIC_INVALID_JSON');}
 };
 classify.policy=Object.freeze({...policy});return classify;
}
