// Official Desktop owns the renderer and strips Origin before forwarding HTTP.
// This exception is derived on the Host, never from a caller's payload/header.
export const officialDesktopCarrier=(runtime=process)=>!!runtime.versions?.electron&&runtime.env?.ELECTRON_RUN_AS_NODE==='1'&&/(?:^|\/)@deepseek-ai\/dsh-desktop-host\/lib\/index\.js$/.test((runtime.argv?.[1]??'').replaceAll('\\','/'));
export function authenticatedOwnerOrigin(request,{desktop=false,serverOrigin}={}){
 const origin=request.headers.get('origin'),host=request.headers.get('host');
 if(request.headers.get('sec-fetch-site')==='cross-site')return false;
 if(origin!==null){try{const u=new URL(origin);return u.host===host&&['http:','https:'].includes(u.protocol);}catch{return false;}}
 // The registered native fetch route has already passed DSH's owner-session
 // authentication and Host/Origin fence. No unauthenticated fallback is added.
 if(!desktop)return false;
 try{const u=new URL(serverOrigin);return u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!!u.port&&host===u.host;}catch{return false;}
}
