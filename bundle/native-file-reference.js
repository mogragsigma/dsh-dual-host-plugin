import path from 'node:path';

// IM image ingress includes a normalized image block alongside the original-file
// path in user text. Only that text can select a file; image bytes/metadata are
// never authorization. This does not relax task intake or approval contracts.
export function currentFileRequest(agent){
 const messages=agent?.session?.deriveMessages?.();
 if(!Array.isArray(messages))throw Error('HUMAN_REQUEST_UNAVAILABLE');
 const m=messages.findLast(x=>x?.role==='user'&&x.source?.kind==='user');
 if(!m||typeof m.id!=='string'||!m.id)throw Error('HUMAN_REQUEST_UNAVAILABLE');
 if(!Array.isArray(m.content)||m.content.some(x=>!x||!['text','image'].includes(x.type)))throw Error('FILE_CONTEXT_UNSUPPORTED');
 const blocks=m.content.filter(x=>x.type==='text');
 if(blocks.some(x=>typeof x.text!=='string'))throw Error('TEXT_FILE_REQUEST_REQUIRED');
 const text=blocks.map(x=>x.text).join('\n');
 if(!text.trim())throw Error('TEXT_FILE_REQUEST_REQUIRED');
 if(text.length>8000)throw Error('REQUEST_SIZE_UNSUPPORTED');
 return {message_id:m.id,text};
}

// Resolve spelling, not authority. PeerFiles still checks the independently
// granted roots, directory identities, file type, byte limit and immutable spool.
// No IM manifest parsing, private adapter imports, cwd fallback or file copying.
export function nativeFileReference(file,agent){
 if(typeof file!=='string'||!file||/[\x00-\x1f\x7f]/u.test(file))throw Error('PEER_FILE_SOURCE_INVALID');
 if(path.isAbsolute(file))return file;
 if(!/[\\/]/u.test(file))return file; // Preserve unique send-root basename lookup.
 const parts=file.split(path.sep==='\\'?/[\\/]/u:/\//u);
 if(parts.some(p=>!p||p==='.'||p==='..')||parts[0]==='~'||path.sep!=='\\'&&file.includes('\\')||/^[A-Za-z]:/u.test(file))throw Error('PEER_FILE_SOURCE_INVALID');
 const cwd=agent?.session?.header?.cwd;
 if(typeof cwd!=='string'||!path.isAbsolute(cwd)||path.resolve(cwd)!==cwd||/[\x00-\x1f\x7f]/u.test(cwd))throw Error('PEER_FILE_WORKSPACE_UNAVAILABLE');
 return path.resolve(cwd,file);
}
