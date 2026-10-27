// Per-window capability lives only in memory. No registration, platform-bound
// credentials, automatic polling or resend. Losing the page never replays a decision.
export function createWorkbenchDecisionAdapter(call){
 const operations=new Map();let key;
 const windowKey=()=>{if(!globalThis.crypto?.getRandomValues||!globalThis.crypto?.randomUUID)throw Error('APPROVAL_BROWSER_CRYPTO_REQUIRED');return key??=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');};
 const event=()=>{windowKey();return crypto.randomUUID();};
 const scope=a=>JSON.stringify([a.task_id,a.request_id,a.expected_revision]);
 const invoke=(m,args)=>call('approval-interaction-'+m,{client_key:windowKey(),...args});
 const checked=r=>{if(r?.schema!==1||r.execution_granted!==false)throw Error('APPROVAL_IDENTITY_CONTRACT_CHANGED');return r;};
 const adapter=async selection=>{
  const k=scope(selection);let op=operations.get(k);
  if(op)return adapter.status(selection);
  const text=selection.text.trim()||({approve:'同意',hold:'暂缓',reject:'拒绝'}[selection.shortcut]??'');
  const event_id=event();op={event_id};operations.set(k,op);
  const {task_id,request_id,expected_revision}=selection;
  try{return checked(await invoke('prepare',{task_id,request_id,expected_revision,text,event_id}));}catch(e){op.uncertain=true;throw e;}
 };
 adapter.drafts=new Map();adapter.serverValidated=true;adapter.pending=a=>operations.get(scope(a));
 adapter.status=async a=>{const op=operations.get(scope(a));if(!op)throw Error('APPROVAL_OPERATION_NOT_FOUND');let r;try{r=checked(await invoke('status',{event_id:op.event_id}));}catch(e){if(e.message!=='APPROVAL_OPERATION_NOT_FOUND'||op.confirmAttempted)throw e;r={schema:1,execution_granted:false,prepared:false,recorded:false,uncertain:false,operation_state:'not_received',state:'not_received',message:'云端未找到这次意见核对，且本窗口尚未发送保存决定。可返回修改后重新核对；不会自动提交。'};}op.uncertain=!!r.uncertain;return r;};
 adapter.confirm=async a=>{const op=operations.get(scope(a));if(!op)throw Error('APPROVAL_OPERATION_NOT_FOUND');op.confirmAttempted=true;try{return checked(await invoke('confirm',{event_id:op.event_id}));}catch(e){op.uncertain=true;throw e;}};
 adapter.discard=a=>operations.delete(scope(a));
 adapter.identity=async action=>invoke('identity_'+action,action==='send'?{event_id:event()}:{});
 const interventions=new Map();
 const interventionScope=a=>JSON.stringify([a.task_id,a.intervention_id,a.expected_revision]);
 const interventionCall=async(m,a)=>{const r=await call('intervention-action-'+m,{client_key:windowKey(),...a});if(r?.schema!==1||r.grants_execution!==false)throw Error('INTERVENTION_CONTRACT_CHANGED');return r;};
 adapter.intervention={
  drafts:new Map(),pending:a=>interventions.get(interventionScope(a)),
  inspect:a=>interventionCall('inspect',a),
  prepare:async a=>{const k=interventionScope(a);if(interventions.has(k))return adapter.intervention.status(a);const op={event_id:event()};interventions.set(k,op);return interventionCall('prepare',{...a,event_id:op.event_id});},
  status:async a=>{const op=interventions.get(interventionScope(a));if(!op)throw Error('INTERVENTION_OPERATION_NOT_FOUND');try{return await interventionCall('status',{event_id:op.event_id});}catch(e){if(e.message!=='INTERVENTION_OPERATION_NOT_FOUND'||op.confirmAttempted)throw e;return {schema:1,grants_execution:false,operation_state:'not_received',prepared:false,recorded:false,uncertain:false,message:'云端未收到核对请求，且未发送确认。可返回修改后再核对。'};}},
  confirm:a=>{const op=interventions.get(interventionScope(a));if(!op)throw Error('INTERVENTION_OPERATION_NOT_FOUND');op.confirmAttempted=true;return interventionCall('confirm',{event_id:op.event_id});},
  discard:a=>interventions.delete(interventionScope(a)),identity:adapter.identity
 };
 return adapter;
}
