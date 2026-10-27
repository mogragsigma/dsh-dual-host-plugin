// Official clients can throw a RemoteError instead of returning the error arm.
// Preserve only our machine code, never arbitrary host/credential error text.
export async function callOnboarding(call, method, args) {
 try {
  const r=await call('/api','task-onboarding/control',{method,args});
  if(!r?.ok) throw {code:r?.error?.code};
  return r.value;
 } catch(e) {
  const code=[e?.code,e?.message].find(x=>typeof x==='string'&&/^ONBOARDING_[A-Z_]+$/.test(x));
  if(code)throw Error(code);
  // Fixed upstream transport wording only; never expose arbitrary exception
  // messages, request IDs, credential values or response bodies to the UI.
  const status=/^transport failure for \/api\/task-onboarding\/control: HTTP (\d{3})$/.exec(e?.message??'')?.[1];
  if(status)throw Error(['401','403'].includes(status)?'ONBOARDING_TRANSPORT_AUTH_REQUIRED':status==='431'?'ONBOARDING_TRANSPORT_HEADERS_TOO_LARGE':['502','503','504'].includes(status)?'ONBOARDING_TRANSPORT_UNAVAILABLE':'ONBOARDING_TRANSPORT_HTTP_REJECTED');
  if(e?.name==='AbortError'||e?.name==='TimeoutError')throw Error('ONBOARDING_TRANSPORT_INTERRUPTED');
  if(e?.name==='TypeError'&&['Failed to fetch','NetworkError when attempting to fetch resource.','Load failed'].includes(e.message))throw Error('ONBOARDING_TRANSPORT_INTERRUPTED');
  if(typeof e?.message==='string'&&(/^connection: invalid server-response (envelope|result|failure)$/.test(e.message)||e.message.startsWith('rpcId mismatch for task-onboarding/control: ')))throw Error('ONBOARDING_TRANSPORT_RESPONSE_INVALID');
  throw Error('ONBOARDING_UNAVAILABLE');
 }
}
