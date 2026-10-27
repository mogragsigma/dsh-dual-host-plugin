import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
test('built wizard scopes installation claims instead of declaring current model disabled',async()=>{
 const ui=(await fs.readFile(new URL('../bundle/workbench-client.js',import.meta.url),'utf8')).replace(/\\u([0-9a-f]{4})/gi,(_,h)=>String.fromCharCode(parseInt(h,16)));
 assert(ui.includes('本安装操作范围'));
 assert(ui.includes('模型接入不代表请求、IM 或全链路验收通过'));
 assert(!ui.includes('未配置 · 后续工作包，不因 Host 启动而宣称完成'));
 assert(!ui.includes('模型、IM 和整套初始化尚未完成'));
 assert(ui.includes('云端 Host 尚未完全就绪或仍在安装／重启收尾'));
});
