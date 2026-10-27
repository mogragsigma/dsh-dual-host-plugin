// Capability discovery is not consent. Every mutation retains its own revision,
// preview and explicit confirmation checks. Legacy isolation constraints fail closed.
import path from 'node:path';
import {homedir} from 'node:os';
import {resolveOnboardingPaths} from './onboarding-paths.js';
export function onboardingBoundary(config={},runtime={},kind){
 const platform=runtime.platform??process.platform,env=runtime.env??process.env,home=runtime.home??homedir();
 const p=platform==='win32'?path.win32:path.posix,setting=config.onboarding?.[kind];
 const reject=()=>{throw Error('ONBOARDING_'+(kind==='installation'?'INSTALL':'PERSISTENCE')+'_DISABLED');};
 if(setting?.enabled!==undefined&&setting.enabled!==true)reject();
 if(Object.keys(config.onboarding?.paths??{}).length)reject();
 const paths=resolveOnboardingPaths({platform,home,env});
 const within=(root,target)=>target===root||target.startsWith(root+p.sep);
 const roots=[paths.dsh.path,paths.agents.path];
 if(roots.some(root=>root===p.parse(root).root||within(root,home))||within(roots[0],roots[1])||within(roots[1],roots[0]))reject();
 const root=setting?.isolatedRoot,marker=env.DSH_ONBOARDING_ISOLATED_ROOT;
 const isolated=root!==undefined||marker!==undefined;
 if(isolated&&(!p.isAbsolute(root??'')||p.resolve(root)!==root||marker!==root||root===home||!within(root,home)||roots.some(target=>target===root||!within(root,target))))reject();
 return {paths,roots,isolated};
}
