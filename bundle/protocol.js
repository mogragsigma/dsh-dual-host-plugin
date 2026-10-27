import {createHmac,timingSafeEqual} from 'node:crypto';
export const prefix='[A2A] DSH-TASK/1 ';
export function signedNotice(c,key,task,id,now=Date.now()){
 const payload=Buffer.from(JSON.stringify({v:1,namespace:c.namespace,from:c.role,to:c.role==='local'?'cloud':'local',id,kind:'task_notice',task_id:task.id,epoch:task.epoch,revision:task.revision,issuedAt:now,expiresAt:now+300000})).toString('base64url');
 return prefix+JSON.stringify({payload,mac:createHmac('sha256',key).update(payload).digest('hex')});
}
export function verifyNotice(c,key,m,now=Date.now()){
 if(m.chatId!==c.chatId||m.senderType!=='bot'||m.userId!==c.peerOpenId)throw Error('PEER_IDENTITY_DENIED');
 if(!m.text.startsWith(prefix))throw Error('PROTOCOL_DENIED');
 const w=JSON.parse(m.text.slice(prefix.length));
 if(!w||typeof w!=='object'||Array.isArray(w)||typeof w.payload!=='string'||w.payload.length>4096||!(/^[0-9a-f]{64}$/).test(w.mac??''))throw Error('BAD_ENVELOPE');
 if(!timingSafeEqual(Buffer.from(w.mac,'hex'),createHmac('sha256',key).update(w.payload).digest()))throw Error('BAD_SIGNATURE');
 const b=JSON.parse(Buffer.from(w.payload,'base64url').toString());
 if(!b||typeof b!=='object'||Array.isArray(b)||b.v!==1||b.namespace!==c.namespace||b.to!==c.role||b.from!==(c.role==='local'?'cloud':'local')||b.kind!=='task_notice'||typeof b.id!=='string'||!b.id||b.id.length>128||!/^task-[0-9a-f-]{36}$/.test(b.task_id)||!Number.isSafeInteger(b.epoch)||b.epoch<1||!Number.isSafeInteger(b.revision)||b.revision<0)throw Error('ENVELOPE_POLICY_DENIED');
 if(!Number.isFinite(b.issuedAt)||!Number.isFinite(b.expiresAt)||b.issuedAt>now+30000||b.expiresAt<now||b.expiresAt<=b.issuedAt||b.expiresAt-b.issuedAt>300000)throw Error('ENVELOPE_EXPIRED');
 return b; // Advisory only; never approval, grant, task creation or execution.
}
