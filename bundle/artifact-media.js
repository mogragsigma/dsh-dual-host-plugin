// Bytes only, no arbitrary filesystem imports, remote URLs or HTML renderers.
import {createHash} from 'node:crypto';
export const mediaHash=b=>createHash('sha256').update(b).digest('hex');
export function decodeImage(format,content){
 if(typeof content!=='string'||content.length>349528||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content))throw Error('ARTIFACT_INVALID_IMAGE');
 const bytes=Buffer.from(content,'base64');if(!bytes.length||bytes.length>262144)throw Error('ARTIFACT_TOO_LARGE');imageType(bytes,format);return bytes;
}
export function imageType(b,expected){
 let type;
 if(b.length>32&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&b.toString('ascii',12,16)==='IHDR'&&b.readUInt32BE(8)===13){
  const w=b.readUInt32BE(16),h=b.readUInt32BE(20);if(!w||!h||w>8192||h>8192||w*h>16777216)throw Error('ARTIFACT_IMAGE_DIMENSIONS');
  // Bound and structurally validate chunks through exact IEND; provider decodes the image.
  let p=8,ended=false,data=false;while(p+12<=b.length){const n=b.readUInt32BE(p),kind=b.toString('ascii',p+4,p+8);if(n>b.length-p-12)throw Error('ARTIFACT_INVALID_IMAGE');if(kind==='IDAT')data=true;p+=12+n;if(kind==='IEND'){if(n||p!==b.length)throw Error('ARTIFACT_INVALID_IMAGE');ended=true;break;}}if(!ended||!data)throw Error('ARTIFACT_INVALID_IMAGE');type='png';
 }else if(b.length>4&&b[0]===255&&b[1]===216&&b[b.length-2]===255&&b[b.length-1]===217){
  // JPEG dimensions from a bounded SOF scan; no decoding or executable content processing.
  let p=2,found=false;while(p+4<=b.length){if(b[p++]!==255)throw Error('ARTIFACT_INVALID_IMAGE');while(p<b.length&&b[p]===255)p++;if(p+3>b.length)throw Error('ARTIFACT_INVALID_IMAGE');const marker=b[p++];if(marker===218)break;if(marker===216||marker===217||marker===1||marker>=208&&marker<=215)continue;const n=b.readUInt16BE(p);if(n<2||p+n>b.length)throw Error('ARTIFACT_INVALID_IMAGE');if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){if(n<8)throw Error('ARTIFACT_INVALID_IMAGE');const h=b.readUInt16BE(p+3),w=b.readUInt16BE(p+5);if(!w||!h||w>8192||h>8192||w*h>16777216)throw Error('ARTIFACT_IMAGE_DIMENSIONS');found=true;}p+=n;}if(!found)throw Error('ARTIFACT_INVALID_IMAGE');type='jpeg';
 }else throw Error('ARTIFACT_INVALID_IMAGE');
 if(expected&&expected!==type)throw Error('ARTIFACT_INVALID_IMAGE');return 'image/'+type;
}
export async function artifactSnapshot(g,task,id,mode){
 const a=g.artifacts,r=a.load(task,id);if(a.eligibility(r)!=='needs_verification')throw Error('NOTIFICATION_ARTIFACT_STALE');
 if(r.kind==='gitee_delivery'){
  if(mode!=='page')throw Error('NOTIFICATION_PAGE_ONLY');
  const access=await a.access({task_id:task,artifact_id:id,action:'gitee'});a.assertOpen();
  if(access.artifact.state!=='verified'||a.eligibility(r)!=='needs_verification'||access.artifact.sha256!==r.sha256)throw Error('NOTIFICATION_ARTIFACT_CHANGED');
  return {artifact_id:r.id,name:r.name,description:r.description,sha256:r.sha256,size:0,mode,spec_revision:r.spec_revision,mime:'text/uri-list',url:access.url};
 }
 const f=r.kind==='report'?a.readLocal(r):await g.repositories.provider.file(r.repository,r.path);a.assertOpen();
 if(a.eligibility(r)!=='needs_verification'||f.bytes.length!==r.size||mediaHash(f.bytes)!==r.sha256||r.kind==='gitee'&&f.blob_sha!==r.blob_sha)throw Error('NOTIFICATION_ARTIFACT_CHANGED');
 if(mode==='page'&&r.kind!=='gitee')throw Error('NOTIFICATION_PAGE_UNAVAILABLE');
 const mime=mode==='image'?imageType(f.bytes):'application/octet-stream';
 if(mode==='image'&&!/\.(png|jpe?g)$/i.test(r.name))throw Error('ARTIFACT_INVALID_IMAGE');
 return {artifact_id:r.id,name:r.name,description:r.description??'暂无介绍',sha256:r.sha256,size:r.size,mode,spec_revision:r.spec_revision,mime,...(mode==='page'?{url:f.url}:{bytes:f.bytes})};
}
