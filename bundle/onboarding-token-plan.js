// Optional native adapter, in our namespace. No changes to upstream plugin config.
import {createOnboardingModelBinding} from './onboarding-models.js';
export const TOKEN_PLAN_PROVIDER='dsh-onboarding-token-cn';
export const TOKEN_PLAN_NAME='阿里云 Token Plan（双端配置）';
export const TOKEN_PLAN_ENDPOINT='https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
const fail=()=>{throw Error('ONBOARDING_MODEL_ADAPTER_UNAVAILABLE');};
// Load only when this optional service is previewed/enabled. A missing optional
// dependency must not prevent the base DeepSeek onboarding from starting.
async function dependencies(){
 try{
  const [native,models,catalog,protocol,llm]=await Promise.all([
   import('@deepseek-ai/dsh-llm-pi-ai'),import('@earendil-works/pi-ai/models'),
   import('@earendil-works/pi-ai/providers/qwen-token-plan-cn'),
   import('@earendil-works/pi-ai/api/openai-completions.lazy'),import('@deepseek-ai/dsh-llm')
  ]);
  return {native,models,catalog,protocol,llm};
 }catch{fail();}
}
export function createOnboardingTokenPlanModels(ctx,config={},runtime={}){
 let prepared;
 async function prepare(){
  if(!prepared)prepared=(async()=>{
   const d=await (runtime.loadTokenPlan??dependencies)(),source=d.catalog.qwenTokenPlanCnProvider();
   if(source.id!=='qwen-token-plan-cn'||source.baseUrl!==TOKEN_PLAN_ENDPOINT)fail();
   const catalog=source.getModels();
   if(!catalog.length||catalog.some(m=>m.api!=='openai-completions'||m.baseUrl!==TOKEN_PLAN_ENDPOINT))fail();
   const piProvider=d.models.createProvider({id:TOKEN_PLAN_PROVIDER,name:TOKEN_PLAN_NAME,baseUrl:TOKEN_PLAN_ENDPOINT,
    // No env, file, OAuth or native credential fallback. resolveApiKey below is authoritative.
    auth:{apiKey:{name:TOKEN_PLAN_NAME,resolve:async({credential})=>credential?.key?{auth:{apiKey:credential.key},source:TOKEN_PLAN_NAME}:undefined}},
    models:catalog.map(m=>({...m,provider:TOKEN_PLAN_PROVIDER})),api:d.protocol.openAICompletionsApi()});
   const profile={provider:TOKEN_PLAN_PROVIDER,displayName:TOKEN_PLAN_NAME,baseURL:TOKEN_PLAN_ENDPOINT,
    api:'openai-completions',reasoning:'high',streamIdleTimeoutMs:300000,maxRequestImageBytes:20971520,
    requestImagePixelBudget:4194304,requestImageMaxBytes:1048576,
    retryPolicy:d.llm.resolveRetryPolicy({mode:'normal',maxRetries:0}),piProvider,
    modelErrors:new Map(),configuredMaxTokens:new Map()};
   return {d,profiles:new Map([[TOKEN_PLAN_PROVIDER,profile]])};
  })().catch(()=>{prepared=undefined;fail();});
  return prepared;
 }
 const definition={provider:TOKEN_PLAN_PROVIDER,providerName:TOKEN_PLAN_NAME,slot:'token-plan',record:'onboarding-token-cn-binding-v1',endpoint:TOKEN_PLAN_ENDPOINT,prepare,
  async register(modelContext,resolveKey){
   const {d,profiles}=await prepare(),deny=async()=>{throw new d.llm.LlmError('请使用本项目配置导览管理凭据。','MISSING_CREDENTIAL');};
   const adapter=new d.native.PiAiAdapter({profiles:()=>profiles,
    resolveApiKey:async provider=>{if(provider!==TOKEN_PLAN_PROVIDER)throw new d.llm.LlmError('非本项目模型路由。','NO_ADAPTER');return resolveKey();},
    auth:{credentials:{read:async()=>undefined,list:async()=>[],modify:deny,delete:deny},authContext:{env:async()=>undefined,fileExists:async()=>false}},
    resolveAttachments:()=>modelContext.get?.('attachments'),
    resolveImageAccess:(attachments,ref)=>d.llm.resolveImageAttachmentAccess(attachments,p=>modelContext.get?.('fs')?.processPathFromHostPath(p),ref)});
   (runtime.llm??modelContext.llm).registerAdapter([TOKEN_PLAN_PROVIDER],adapter);
  }
 };
 return createOnboardingModelBinding(ctx,config,runtime,definition);
}
