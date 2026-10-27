// Shared pure validation. References only: this contract deliberately cannot accept secrets.
export const ONBOARDING_CONTRACT=1;
export const defaults=()=>({host:'',user:'',port:'22',sshReference:'',deepseekReference:'',cloudDeepseekReference:'',scope:'both',model:'',extra:false,tokenPlan:'token-cn',tokenReference:'',cloudTokenReference:'',im:false,approval:'later',repo:false,repoUrl:'',repoAlias:'',development:false});
const names=Object.keys(defaults());
const suspectedSecret=value=>typeof value==='string'&&(/\bsk[-_][A-Za-z0-9_-]{6,}|PRIVATE[ -]KEY|\bBearer\s+|(?:api[-_ ]?key|token|password)\s*[:=]\s*\S+/i.test(value)||/[A-Za-z0-9_-]{32,}/.test(value)&&!/^DSH_[A-Z0-9_]+$/.test(value));
// Conservative mistake prevention; arbitrary prose cannot be proven secret-free.
export function assertNonsecretDraft(d){
 if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).some(k=>!names.includes(k)))throw Error('ONBOARDING_INVALID_DRAFT');
 for(const value of Object.values(d))if(suspectedSecret(value))throw Error('ONBOARDING_SECRET_IN_DRAFT');
 // Even an incomplete/disabled optional repository field must not persist URL secrets.
 if(typeof d.repoUrl==='string'&&(/[?#@]/.test(d.repoUrl)))throw Error('ONBOARDING_SECRET_IN_DRAFT');
}
const text=(v,max=200)=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u001f\u007f]/u.test(v);
const reference=v=>!/^sk[-_]/i.test(v)&&/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(v);
export function repositoryURL(v){
 try{const u=new URL(v.startsWith('gitee.com/')?'https://'+v:v);return u.protocol==='https:'&&u.hostname==='gitee.com'&&!u.port&&!u.username&&!u.password&&!u.search&&!u.hash&&/^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(u.pathname)&&!u.pathname.split('/').some(x=>x==='.'||x==='..')?u.href:null;}catch{return null;}
}
export function validateDraft(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!names.includes(k)))throw Error('ONBOARDING_INVALID_DRAFT');
 const d={...defaults(),...value},errors=[];
 const err=(page,field,message)=>errors.push({page,field,message});
 for(const [k,v] of Object.entries(d))if(typeof defaults()[k]==='boolean'?typeof v!=='boolean':!text(v, k==='repoUrl'?500:200))throw Error('ONBOARDING_INVALID_DRAFT');
 // Show the same conservative storage guard before clicking Continue. A long
 // opaque reference is not necessarily a secret; do not claim that it is one.
 for(const [k,v] of Object.entries(d))if(suspectedSecret(v)||k==='repoUrl'&&/[?#@]/.test(v))err(['host','user','port','sshReference'].includes(k)?0:['im','approval'].includes(k)?2:['repo','repoUrl','repoAlias','development'].includes(k)?3:1,k,'此字段疑似密钥或过长标识，请改用简短引用；Key 请使用独立凭据入口。');
 // No shell/URL syntax is accepted as a host. Bracketless IPv6 is intentionally not in v1.
 const host=d.host.trim();
 if(!host||host.length>253||!host.split('.').every(x=>/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(x))||/^\d+(?:\.\d+){3}$/.test(host)&&host.split('.').some(x=>+x>255))err(0,'host','填写 ECS 主机名或有效 IPv4 地址，不包含协议、端口或命令。');
 if(!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(d.user))err(0,'user','填写 SSH 登录用户名。它不等于云端 DSH 服务账号。');
 if(!/^\d{1,5}$/.test(d.port)||+d.port<1||+d.port>65535)err(0,'port','SSH 端口必须是 1–65535 的整数。');
 if(!reference(d.sshReference))err(0,'sshReference','填写凭据引用名称；不要粘贴私钥或密码。');
 if(!reference(d.deepseekReference))err(1,'deepseekReference','填写 DeepSeek 凭据引用名称，不是 Key 原文。');
 if(!['both','separate'].includes(d.scope))err(1,'scope','选择凭据用途。');
 if(d.scope==='separate'&&!reference(d.cloudDeepseekReference))err(1,'cloudDeepseekReference','分开配置时必须提供云端凭据引用。');
 if(!d.model.trim())err(1,'model','填写模型名称或简称，后续按目标端清单解析。');
 if(d.extra){if(d.tokenPlan!=='token-cn')err(1,'tokenPlan','选择支持的套餐。');if(!d.tokenReference&&!d.cloudTokenReference)err(1,'tokenReference','启用 Token Plan 后至少填写本端或云端一端的凭据引用；不要求两端同时接入。');if(d.tokenReference&&!reference(d.tokenReference))err(1,'tokenReference','填写本端 Token Plan 凭据引用，不是 Key 原文。');}
 if(d.cloudTokenReference&&!reference(d.cloudTokenReference))err(1,'cloudTokenReference','填写云端 Token Plan 的独立引用，不是 Key 原文；留空可跳过云端可选接入。');
 if(!['later','chat','web'].includes(d.approval)||d.approval==='chat'&&!d.im)err(2,'approval','可信聊天确认需要先选择聊天入口，或选择以后配置。');
 if(d.repo&&!repositoryURL(d.repoUrl))err(3,'repoUrl','启用后填写 https://gitee.com/拥有者/仓库；不要包含令牌、分支或文件路径。');
 if(d.development&&!d.repo)err(3,'development','准备开发环境需要先选择任务仓库；不会开放实际写入。');
 return {contract:1,valid:!errors.length,errors,pageValid:[0,1,2,3].map(p=>!errors.some(e=>e.page===p)),authorization:false,validation:'format_only'};
}
