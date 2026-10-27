// Optional public same-Host IM contract. Discovery neither sends nor alters IM targets.
import {randomUUID} from 'node:crypto';
import {digest,targets,text} from './notification-contract.js';
import {bounded} from './recovery.js';
const hash=x=>/^[a-f0-9]{64}$/.test(x??'');
const safe=e=>['account-unverified','capability-unavailable','unknown-bot','unknown-target','target-changed','account-changed'].includes(e?.code)?'NOTIFICATION_'+e.code.replaceAll('-','_').toUpperCase():'NOTIFICATION_DISCOVERY_UNAVAILABLE';
export class NotificationDiscovery {
 constructor(g,service){this.g=g;this.service=service;this.candidates=new Map();this.pending=null;this.inflight=0;}
 async query(fn){if(this.g.closed||this.inflight>=8)throw Error('NOTIFICATION_DISCOVERY_BUSY');this.inflight++;const work=Promise.resolve().then(fn).finally(()=>{this.inflight--;});return bounded(work,3000,'NOTIFICATION_DISCOVERY_TIMEOUT');}
 supported(s){return s?.contractVersion===1&&['listBots','listTargets','describeBot','sendChecked'].every(k=>typeof s[k]==='function');}
 async read(s,bot){
  const a=await this.query(()=>s.describeBot(bot.botId));
  if(a?.version!==1||a.botId!==bot.botId||a.channel!==bot.channel||!hash(a.account?.fingerprint)||!Array.isArray(a.capabilities))throw Error('NOTIFICATION_DISCOVERY_INVALID');
  const list=await this.query(()=>s.listTargets(bot.botId));
  // Official same-Host service returns an array; older adapters returned the RPC envelope.
  // Account identity remains independently verified above; never accept a mismatched envelope.
  const items=Array.isArray(list)?list:list?.botId===bot.botId&&list.channel===bot.channel?list.targets:null;
  if(!Array.isArray(items)||items.length>100)throw Error('NOTIFICATION_DISCOVERY_INVALID');
  return {account:a,targets:items};
 }
 normalize(bot,a,t){
  if(!['feishu','lark'].includes(bot.channel)||!['group','user'].includes(t?.kind)||!text(t?.name,80))return null;
  const field=t.kind==='group'?'chatId':'openId';
  if(!t.route||Object.keys(t.route).length!==1||!text(t.route[field],512))return null;
  const expectedTargetDigest=digest({kind:t.kind,route:{[field]:t.route[field]}}),expectedFingerprint=a.account.fingerprint;
  const alias='discovered-'+digest({bot:bot.botId,target:t.targetId,expectedFingerprint,expectedTargetDigest}).slice(0,24);
  const definition={host:this.g.c.role,alias,label:t.name,botId:bot.botId,targetId:t.targetId,expectedFingerprint,expectedTargetDigest,conversationId:t.route[field],receipt_mode:t.kind==='group'&&a.capabilities.includes('proactive-receipt-checked')&&this.service()?.receiptVersion===1?'message':'acceptance'};
  try{targets([definition]);return definition;}catch{return null;}
 }
 inspect(){if(this.pending)return this.pending;this.pending=this.scan().finally(()=>{this.pending=null;});return this.pending;}
 async scan(){
  const s=this.service(),out={host:this.g.c.role,observed_at:this.g.now(),state:'available',accounts:[],items:[],grants_delivery:false,scope:'saved public IM targets only; not a platform directory',images:false,files:false};
  this.candidates.clear();if(!this.supported(s))return {...out,state:'unavailable',error:'NOTIFICATION_CAPABILITY_UNAVAILABLE'};
  let bots;try{bots=await this.query(()=>s.listBots());if(!Array.isArray(bots)||bots.length>20)throw Error('NOTIFICATION_DISCOVERY_LIMIT');}catch(e){return {...out,state:'unavailable',error:safe(e)};}
  // Bound fanout and total latency. Never let a provider's hanging response monopolize the Host.
  for(let start=0;start<bots.length;start+=4){
   const rows=await Promise.all(bots.slice(start,start+4).map(async bot=>{
    if(!text(bot?.botId,128)||!text(bot.channel,40))return {error:'NOTIFICATION_DISCOVERY_INVALID',channel:'unknown'};
    try{const r=await this.read(s,bot);return {bot,...r};}catch(e){return {error:safe(e),channel:bot.channel};}
   }));
   if(this.g.closed||s!==this.service()){this.candidates.clear();return {...out,state:'unavailable',items:[],error:'NOTIFICATION_DISCOVERY_CHANGED'};}
   for(const r of rows){
    if(r.error){out.accounts.push({channel:r.channel,state:'unavailable',error:r.error});continue;}
    const {bot,account:a}=r,canText=a.connected===true&&a.capabilities.includes('proactive-text-checked');
    out.accounts.push({channel:bot.channel,name:text(a.account.name,80)?a.account.name:'未命名机器人',connected:a.connected===true,text_checked:canText,state:canText?'available':'unavailable'});
    for(const t of r.targets){
     if(out.items.length>=100){out.truncated=true;break;}
     const d=this.normalize(bot,a,t),id=d&&canText?randomUUID():null;
     if(id)this.candidates.set(id,{definition:d,service:s,created:this.g.now(),bot,kind:t.kind});
     out.items.push({candidate_id:id,label:text(t?.name,80)?t.name:'未命名目标',account:text(a.account.name,80)?a.account.name:'未命名机器人',host:this.g.c.role,channel:bot.channel,kind:['group','user'].includes(t?.kind)?t.kind:'unsupported',eligible:!!id,receipt_mode:d?.receipt_mode??null,reason:!canText?'NOTIFICATION_ACCOUNT_UNVERIFIED':!d?'NOTIFICATION_CAPABILITY_UNAVAILABLE':null});
    }
   }
  }
  if(out.accounts.some(a=>a.state==='unavailable'))out.state='partial';return out;
 }
 async resolve(id,label){
  const c=this.candidates.get(id);if(!c||this.g.now()-c.created>300000||this.g.now()<c.created||this.service()!==c.service)throw Error('NOTIFICATION_DISCOVERY_EXPIRED');
  if(label!==c.definition.label)throw Error('NOTIFICATION_TARGET_LABEL_MISMATCH');
  let r;try{r=await this.read(c.service,c.bot);}catch(e){throw Error(safe(e));}
  if(this.g.closed||this.service()!==c.service||this.g.now()-c.created>300000||this.g.now()<c.created)throw Error('NOTIFICATION_DISCOVERY_CHANGED');
  const t=r.targets.find(t=>t.targetId===c.definition.targetId),d=t&&this.normalize(c.bot,r.account,t);
  if(!d||r.account.connected!==true||!r.account.capabilities.includes('proactive-text-checked')||JSON.stringify(d)!==JSON.stringify(c.definition))throw Error('NOTIFICATION_DISCOVERY_CHANGED');
  return d;
 }
}
