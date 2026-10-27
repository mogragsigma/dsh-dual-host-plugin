// Bytes only arrive after an authenticated, explicit workbench gesture. No URL fetch or storage.
export async function decodeArtifactDownload(reply,expected,env=globalThis){
 const a=reply?.artifact;
 if(!a||a.kind!=='report'||a.state!=='verified'||reply.encoding!=='base64'||reply.disposition!=='attachment'||reply.mime!=='application/octet-stream'||typeof reply.content!=='string'||reply.content.length>349528||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(reply.content))throw Error('ARTIFACT_DOWNLOAD_INVALID');
 if(['id','task_id','spec_revision','sha256','size','name'].some(k=>a[k]!==expected[k])||!Number.isInteger(a.size)||a.size<0||a.size>262144||!/^[a-f0-9]{64}$/.test(a.sha256))throw Error('ARTIFACT_DOWNLOAD_CHANGED');
 if(typeof a.name!=='string'||!a.name||a.name.length>120||a.name!==a.name.trim()||/[\\/:*?"<>|\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(a.name)||/^[.]|[. ]$/.test(a.name)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(a.name))throw Error('ARTIFACT_DOWNLOAD_INVALID');
 if(!env.crypto?.subtle)throw Error('ARTIFACT_BROWSER_CRYPTO_REQUIRED');
 const bytes=Uint8Array.from(env.atob(reply.content),c=>c.charCodeAt(0));
 const digest=Array.from(new Uint8Array(await env.crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
 if(bytes.length!==a.size||digest!==a.sha256)throw Error('ARTIFACT_DOWNLOAD_CHANGED');
 return bytes;
}
export function saveArtifactDownload(bytes,name,env=globalThis){
 if(!env.document?.body||!env.URL?.createObjectURL)throw Error('ARTIFACT_BROWSER_DOWNLOAD_UNAVAILABLE');
 const url=env.URL.createObjectURL(new env.Blob([bytes],{type:'application/octet-stream'})),link=env.document.createElement('a');
 try{link.href=url;link.download=name;link.rel='noopener';link.style.display='none';env.document.body.append(link);link.click();}
 finally{link.remove();env.setTimeout(()=>env.URL.revokeObjectURL(url),1000);}
 return {state:'browser_save_requested',message:'已交给浏览器保存，请查看下载列表；这不是落盘成功回执。'};
}
