// Directory publication must never replace even an empty, newly arrived path.
// No check-then-rename fallback: unsupported kernels/filesystems fail closed.
import path from 'node:path';
// The archive controller can supply Koffi from its verified runtime dependencies;
// an immutable archive itself need not have a node_modules link.
export function createExclusiveRename(k,platform=process.platform){
 if(!['darwin','linux'].includes(platform))throw Error('ONBOARDING_VERSION_MOVE_UNSUPPORTED');
 const lib=k.load(platform==='darwin'?'/usr/lib/libSystem.B.dylib':'libc.so.6');
 const call=platform==='darwin'?lib.func('int renamex_np(const char *from, const char *to, unsigned int flags)'):lib.func('int renameat2(int fromfd, const char *from, int tofd, const char *to, unsigned int flags)');
 return (from,to)=>{
  if(![from,to].every(p=>typeof p==='string'&&path.isAbsolute(p)&&path.resolve(p)===p&&!p.includes('\0'))||from===to)throw Error('ONBOARDING_VERSION_MOVE_ARGUMENTS');
  k.errno(0);const code=platform==='darwin'?call(from,to,4):call(-100,from,-100,to,1);if(code!==0){const e=Error('ONBOARDING_VERSION_MOVE_REFUSED');e.errno=k.errno();throw e;}
 };
}
let move;
export async function renameExclusive(from,to){move??=createExclusiveRename((await import('koffi')).default);move(from,to);}
