// Bytes only arrive after an authenticated, explicit workbench gesture. No URL fetch or storage.
export async function decodeArtifactDownload(reply,expected,env=globalThis){
 const a=reply?.artifact;
 if(!a||!['report','native_file'].includes(a.kind)||a.state!=='verified'||reply.encoding!=='base64'||reply.disposition!=='attachment'||reply.mime!=='application/octet-stream'||typeof reply.content!=='string'||reply.content.length>(a.kind==='native_file'?89478488:349528)||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(reply.content))throw Error('ARTIFACT_DOWNLOAD_INVALID');
 if(['id','task_id','spec_revision','sha256','size','name'].some(k=>a[k]!==expected[k])||!Number.isInteger(a.size)||a.size<0||a.size>(a.kind==='native_file'?67108864:262144)||!/^[a-f0-9]{64}$/.test(a.sha256))throw Error('ARTIFACT_DOWNLOAD_CHANGED');
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

// Chunks use the same owner-authenticated endpoint, never a new download URL.
export async function fetchArtifactDownload(access,expected,isCurrent=()=>true,env=globalThis){
 if(!expected||!Number.isSafeInteger(expected.size)||expected.size<0||expected.size>67108864||typeof expected.name!=='string'||!expected.name||expected.name.length>120||/[\\/:*?"<>|\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(expected.name)||/^[.]|[. ]$/.test(expected.name)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(expected.name))throw Error('ARTIFACT_DOWNLOAD_INVALID');
 const args={task_id:expected.task_id,artifact_id:expected.id,expected_revision:expected.spec_revision,expected_sha256:expected.sha256};
 let reply=await access('download',args);if(expected.kind!=='native_file')return {reply,bytes:await decodeArtifactDownload(reply,expected,env)};
 const parts=[];let offset=0;
 for(;;){
  if(!isCurrent())throw Error('ARTIFACT_DOWNLOAD_ABANDONED');
  if(!reply?.artifact||['id','task_id','kind','spec_revision','name','size','sha256'].some(k=>reply.artifact[k]!==expected[k])||reply.artifact.state!=='verified'||reply.encoding!=='base64'||reply.disposition!=='attachment'||reply.mime!=='application/octet-stream'||reply.offset!==offset||typeof reply.content!=='string'||reply.content.length>65536||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(reply.content))throw Error('ARTIFACT_DOWNLOAD_CHANGED');
  const bytes=Uint8Array.from(env.atob(reply.content),c=>c.charCodeAt(0));if(reply.next_offset!==offset+bytes.length||reply.next_offset>expected.size||reply.complete!==(reply.next_offset===expected.size)||!bytes.length&&expected.size!==0)throw Error('ARTIFACT_DOWNLOAD_CHANGED');
  parts.push(bytes);offset=reply.next_offset;if(reply.complete)break;reply=await access('download',{...args,offset});
 }
 if(!Number.isSafeInteger(expected.size)||expected.size<0||expected.size>67108864||!env.crypto?.subtle)throw Error('ARTIFACT_DOWNLOAD_INVALID');
 const bytes=new Uint8Array(offset);let at=0;for(const p of parts){bytes.set(p,at);at+=p.length;}
 const digest=Array.from(new Uint8Array(await env.crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
 if(digest!==expected.sha256)throw Error('ARTIFACT_DOWNLOAD_CHANGED');return {reply,bytes};
}
