import {createHash} from 'node:crypto';
export const json=JSON.stringify;
export const digest=x=>createHash('sha256').update(json(x)).digest('hex');
export const roles=['local','cloud'];
export const text=(v,n=256)=>typeof v==='string'&&!!v.trim()&&v.length<=n&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
export function targets(config=[]){
 if(!Array.isArray(config)||config.length>20)throw Error('NOTIFICATION_TARGET_CONFIG_INVALID');
 const seen=new Set(),labels=new Set();return config.map(c=>{
  if(!c||Object.keys(c).some(k=>!['host','alias','label','botId','targetId','expectedFingerprint','expectedTargetDigest','conversationId','receipt_mode','transport'].includes(k))||(c.transport!==undefined&&c.transport!=='feishu-openapi')||!roles.includes(c.host)||!/^[-a-zA-Z0-9_]{1,64}$/.test(c.alias??'')||!text(c.label,80)||!/^[-a-zA-Z0-9_]{1,128}$/.test(c.botId??'')||!/^[-a-zA-Z0-9._:@]{1,128}$/.test(c.targetId??'')||!text(c.conversationId,512)||(c.receipt_mode!==undefined&&!['message','acceptance'].includes(c.receipt_mode))||!['expectedFingerprint','expectedTargetDigest'].every(k=>/^[a-f0-9]{64}$/.test(c[k]??'')))throw Error('NOTIFICATION_TARGET_CONFIG_INVALID');
  if(c.transport==='feishu-openapi'&&(c.receipt_mode!=='message'||c.targetId!==c.conversationId))throw Error('NOTIFICATION_TARGET_CONFIG_INVALID');
  const key=c.host+':'+c.alias;if(seen.has(key)||labels.has(c.host+':'+c.label))throw Error('NOTIFICATION_TARGET_AMBIGUOUS');seen.add(key);labels.add(c.host+':'+c.label);
  const route={...(c.transport?{transport:c.transport}:{}),botId:c.botId,targetId:c.targetId,expectedFingerprint:c.expectedFingerprint,expectedTargetDigest:c.expectedTargetDigest,conversationId:c.conversationId,receipt_mode:c.receipt_mode??'message'};
  return {key,host:c.host,alias:c.alias,label:c.label,route,route_hash:digest(route)};
 });
}
export function policy(p){
 if(!p||Object.keys(p).some(k=>!['events','progress_interval_seconds'].includes(k))||!Array.isArray(p.events)||p.events.length<1||p.events.length>3||new Set(p.events).size!==p.events.length||p.events.some(x=>!['result','attention','progress'].includes(x)))throw Error('NOTIFICATION_POLICY_INVALID');
 if(p.events.includes('progress')&&(!Number.isInteger(p.progress_interval_seconds)||p.progress_interval_seconds<60||p.progress_interval_seconds>86400))throw Error('NOTIFICATION_PROGRESS_INTERVAL_REQUIRED');
 if(!p.events.includes('progress')&&p.progress_interval_seconds!==undefined)throw Error('NOTIFICATION_POLICY_INVALID');
 return {events:[...p.events].sort(),...(p.events.includes('progress')?{progress_interval_seconds:p.progress_interval_seconds}:{})};
}
export function delivery(e){
 if(!e||Object.keys(e).some(k=>!['id','lease','task_id','binding_revision','target_key','route_hash','text','created'].includes(k))||!text(e.id,128)||!text(e.lease,128)||!text(e.task_id,128)||!Number.isInteger(e.binding_revision)||e.binding_revision<1||!text(e.target_key,128)||!/^[a-f0-9]{64}$/.test(e.route_hash??'')||!text(e.text,8000)||!Number.isSafeInteger(e.created)||e.created<0)throw Error('NOTIFICATION_DELIVERY_INVALID');return e;
}
export function outcome(v){
 if(!v||!['accepted','needs_review','cancelled'].includes(v.state)||Object.keys(v).some(k=>!['state','message_id','error','proof'].includes(k)))throw Error('NOTIFICATION_RECEIPT_INVALID');
 if(v.state==='accepted'&&(!['provider_message','sdk_accepted'].includes(v.proof)||v.error!=null||(v.proof==='provider_message'?!text(v.message_id,512):v.message_id!==undefined)))throw Error('NOTIFICATION_RECEIPT_INVALID');
 if(v.state!=='accepted'&&(v.message_id!==undefined||v.proof!==undefined||!/^NOTIFICATION_[A-Z_]{1,80}$/.test(v.error??'')))throw Error('NOTIFICATION_RECEIPT_INVALID');return v;
}
