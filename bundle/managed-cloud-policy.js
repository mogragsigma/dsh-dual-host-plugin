// Versioned task semantics. Historical approvals/limits are never migrated on read.
export const CLOUD_TASK_POLICY='cloud-autonomous-v1';
export const autonomous=spec=>spec?.execution_policy===CLOUD_TASK_POLICY;
export const TASK_CONTEXT_MAX=1024*1024; // Transport bound, not a model/request budget.

// This public lookup classifies an already-admitted native session, NOT a person.
// dsh-im owns ingress owner/whitelist checks. Never trust its last-speaker field
// as authentication, read its private storage, or couple execution to IM grants.
export async function taskChannel(ctx,role,agent){
 const im=ctx.get?.('dshIm');
 const conversation=await im?.describeConversation?.(agent.id);
 if(conversation)return role==='cloud'?'cloud-im':'local-im';
 if(role==='local')return 'local-dsh';
 throw Error('TASK_CREATION_CHANNEL_UNSUPPORTED');
}
export function validateTaskChannel(role,channel){
 if(!(role==='local'&&['local-dsh','local-im'].includes(channel)||role==='cloud'&&channel==='cloud-im'))throw Error('TASK_CREATION_CHANNEL_UNSUPPORTED');
 return channel;
}
