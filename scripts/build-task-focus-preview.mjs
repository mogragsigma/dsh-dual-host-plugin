// Build a self-contained, synthetic UI preview; no Host config or credentials.
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),tools=process.env.ONBOARDING_BUILD_TOOLS;
if(!tools)throw Error('ONBOARDING_BUILD_TOOLS_REQUIRED');
const out=path.join(root,'private/task-focus-preview');mkdirSync(out,{recursive:true});
const client=readFileSync(path.join(root,'bundle/workbench-client.js'),'utf8'),needle="return {name:'task-workbench',inject:['connection','slots','layout','uiWorkspace','sessions'],apply};";
if(!client.includes(needle))throw Error('PREVIEW_EXPORT_CHANGED');
const component=client.replace(needle,'return {WorkbenchUI,css};');
const source=readFileSync(path.join(root,'ui-source/preview/task-focus-preview.jsx'),'utf8').replace('/*PREVIEW_COMPONENT*/',component);
const esbuild=createRequire(import.meta.url)(path.join(tools,'esbuild'));
await esbuild.build({stdin:{contents:source,resolveDir:path.join(root,'ui-source/preview'),loader:'jsx'},bundle:true,format:'iife',outfile:path.join(out,'app.js'),nodePaths:[tools],minify:false});
copyFileSync(path.join(root,'bundle/workbench-assets/whale-ui-states.png'),path.join(out,'whale-ui-states.png'));
writeFileSync(path.join(out,'index.html'),`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self'; img-src 'self' blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>大肥鱼bot · 成果与待处理预览</title><link rel="stylesheet" href="./app.css"><style>html,body,#root{margin:0;min-height:100%;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;background:#f5f8fc}.preview-bar{display:flex;align-items:center;gap:12px;padding:10px 24px;font-size:12px;background:#edf5ff;border-bottom:1px solid #d6e7fb;color:#365c80;flex-wrap:wrap}.preview-bar button{margin-left:auto;background:white;color:#315f87;border:1px solid #cadff2;padding:6px 12px;border-radius:20px;cursor:pointer}.preview-notice{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);max-width:calc(100% - 40px);padding:14px 18px;border:1px solid #c9deef;background:#fff;box-shadow:0 10px 40px #153f6b20;border-radius:16px;font-size:13px;color:#32506b;z-index:100}.preview-notice button{margin-left:12px;border:0;background:#eaf3ff;color:#075ba9;padding:5px 9px;border-radius:12px;cursor:pointer}#root>.dtu{height:auto;min-height:calc(100dvh - 49px)}</style></head><body><div id="root"></div><script src="./app.js"></script></body></html>`);
console.log(out);
