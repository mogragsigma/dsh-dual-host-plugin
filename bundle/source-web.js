// Public official adapter only. No native settings mutation, browser identity, search or model calls.
export function sourceUrl(value){
 let u;try{u=new URL(value);}catch{throw Error('SOURCE_URL_INVALID');}
 if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||!u.hostname.includes('.')||u.hostname.startsWith('[')||/^[\d.]+$/.test(u.hostname)||/\.(local|localhost|internal)$/i.test(u.hostname))throw Error('SOURCE_URL_DENIED');
 if([...u.searchParams.keys()].some(k=>/^(?:access_?token|api_?key|token|secret|password|authorization|credential|signature)$/i.test(k)))throw Error('SOURCE_URL_CREDENTIALS_DENIED');
 u.hash='';return u;
}
export async function createAnonymousWebReader(){
 const [{HttpFetchProvider},{proxyRouteFor}]=await Promise.all([import('@deepseek-ai/dsh-web-fetch-http'),import('@deepseek-ai/dsh-http-proxy')]);
 const provider=new HttpFetchProvider({maxResponseBytes:65536,maxBodyChars:65536,timeoutMs:15000,maxRedirects:2,userAgent:'dsh-task-gateway/0.18 (readonly-source)'});
 return {async fetch(url,signal){
  const u=sourceUrl(url);
  // Do not bypass a native/operator proxy or pretend its DNS can be locally pinned.
  if(proxyRouteFor(u).proxied||Object.entries(process.env).some(([k,v])=>/^(?:https?|all)_proxy$/i.test(k)&&v))throw Error('SOURCE_PROXY_UNSUPPORTED');
  return provider.fetch({url:u.href},signal);
 }};
}
