// Build tooling is installed ONLY in the isolated preview tools directory.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const require=createRequire(import.meta.url),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(!process.env.ONBOARDING_BUILD_TOOLS)throw Error('Set ONBOARDING_BUILD_TOOLS to an isolated esbuild installation; do not install into linked runtime dependencies.');
const esbuild=require(path.join(process.env.ONBOARDING_BUILD_TOOLS,'esbuild'));
await esbuild.build({entryPoints:[path.join(root,'ui-source/onboarding/app.jsx')],bundle:true,format:'iife',globalName:'DSHOnboarding',outfile:path.join(root,'ui-source/onboarding.generated.js'),minify:true,nodePaths:[process.env.ONBOARDING_BUILD_TOOLS],plugins:[{name:'host-react',setup(build){build.onResolve({filter:/^react$/},()=>({path:'host-react',namespace:'host'}));build.onLoad({filter:/.*/,namespace:'host'},()=>({contents:'module.exports = React;',loader:'js'}));}}]});
