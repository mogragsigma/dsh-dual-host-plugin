// Render the actual compiled component with a tiny hook adapter; not a browser
// screenshot or actual-host visual acceptance.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import vm from 'node:vm';
import {CAPABILITIES,requireCapability} from '../bundle/link-contract.js';
function components(){
 const source=readFileSync(new URL('../bundle/workbench-client.js',import.meta.url),'utf8');let output;
 const patched=source.replace("return {name:'task-workbench',inject:['connection','slots','layout','uiWorkspace','sessions'],apply};",'return {ArtifactFiles,safeGiteeURL,safeNotificationURL,DeliveryActions};');assert.notEqual(source,patched);
 const React={createElement:(tag,props,...children)=>typeof tag==='function'?tag({...props,children}):({tag,props,children}),useState:v=>[v,()=>{}],useRef:v=>({current:v}),useEffect(){}};
 vm.runInNewContext(patched,{URL,window:{__ModuleLoader__:{load:m=>output=m.factory(n=>{assert.equal(n,'react');return React;})}}});return output;
}
test('delivery card is not described as pre-existing file or worker report; no unverified link',()=>{
 const r=JSON.stringify(components().ArtifactFiles({item:{title:'任务名称',artifacts:{items:[{id:'delivery',kind:'gitee_delivery',name:'交付成果',description:'本任务推送变更',description_source:'delivery_ledger',spec_revision:1,state:'needs_verification',repository:{branch:'acceptance/unit',commit:'a'.repeat(40)}}]}},fresh:true}));
 for(const text of ['本任务交付','介绍来源：交付账本','acceptance/unit','核验 Gitee 入口'])assert(r.includes(text));
 for(const text of ['已有文件 · 非本次生成','独立 worker 报告','查看执行会话','"href"'])assert(!r.includes(text));
});
test('ordinary report keeps session navigation, existing file keeps provenance; failed ledger is not empty success',()=>{
 const c=components(),file={id:'file',kind:'gitee',name:'已有',description_source:'direct_user',description:'原文',repository:{path:'report.md',commit:'b'.repeat(40)}},report={id:'report',kind:'report',name:'报告',description:'介绍',description_source:'worker'};
 const r=JSON.stringify(c.ArtifactFiles({item:{title:'task',artifacts:{items:[file,report],delivery_unavailable:1}},fresh:false}));
 for(const text of ['已有文件 · 非本次生成','查看执行会话','用户原文','交付证据不完整'])assert(r.includes(text));
 assert(JSON.stringify(c.ArtifactFiles({item:{artifacts:{state:'evidence_unavailable',items:[]}}})).includes('交付成果证据待核对'));
});
test('commit URL is exact HTTPS Gitee fixed SHA, never arbitrary provider HTML',()=>{
 const c=components(),url='https://gitee.com/owner/repo/commit/'+'a'.repeat(40);assert.equal(c.safeGiteeURL(url),url);assert.equal(c.safeNotificationURL({kind:'gitee',url}),url);
 for(const bad of [url+'/extra',url+'?token=secret',url+'#x',url.replace('https:','http:'),url.replace('gitee.com','gitee.com.evil.invalid'),url.replace('/commit/','/tree/'),url.replace('a'.repeat(40),'main'),'javascript:alert(1)','https://secret@gitee.com/owner/repo/commit/'+'a'.repeat(40)])assert.throws(()=>c.safeGiteeURL(bad),/ARTIFACT_URL_REJECTED/);
 const file='https://gitee.com/owner/repo/blob/'+'b'.repeat(40)+'/reports/%E6%88%90%E6%9E%9C.md';assert.equal(c.safeGiteeURL(file),file);
});
test('older peer cannot misrender new artifact kind; unrelated native catalog stays compatible',()=>{
 const own={schema:1,protocol:{min:1,max:1},role:'local',namespace:'fixture',plugin_version:'0.24.0-alpha.16',instance_id:'11111111-1111-1111-1111-111111111111',capabilities:{...CAPABILITIES}},old={...own,role:'cloud',capabilities:{...CAPABILITIES,artifacts:1,taskboard:1,notification_media:1}};
 for(const method of ['artifact_list','artifact_access','board_detail','notification_artifact_send'])assert.throws(()=>requireCapability(method,own,old),/CAPABILITY_VERSION_INCOMPATIBLE/);
 assert.doesNotThrow(()=>requireCapability('catalog',own,old));assert.doesNotThrow(()=>requireCapability('artifact_list',own,{...old,capabilities:own.capabilities}));
});

test('historical report text remains evidence, not the current delivery conclusion',()=>{
 const c=components(),r=JSON.stringify(c.ArtifactFiles({item:{title:'任务',delivery:{execution:{total:2}},artifacts:{items:[{id:'report',kind:'report',name:'开发报告',description:'未提交、未推送',created_at:1700000000000}]}},fresh:true}));
 assert(r.includes('未提交、未推送'));assert(r.includes('说明反映当时阶段，后续提交与推送请看交付账本'));
 const source=readFileSync(new URL('../bundle/workbench-client.js',import.meta.url),'utf8');assert(!source.includes('未核验 · 本流程未推送'));assert(source.includes('预览生成时尚未推送；后续结果见交付动作'));assert(source.includes('本动作绑定的提交：'));
});

test('refresh in flight disables historical artifact actions and exposes no cached jump link',()=>{
 const source=readFileSync(new URL('../bundle/workbench-client.js',import.meta.url),'utf8');assert(source.includes('detailRecent&&fresh&&!list.busy&&!detail.busy&&'));
 const r=components().ArtifactFiles({item:{title:'task',artifacts:{items:[{id:'delivery',kind:'gitee_delivery',name:'交付',description:'原介绍',repository:{branch:'acceptance/test',commit:'a'.repeat(40)}}]}},fresh:false});
 const nodes=[];function walk(x){if(!x||typeof x!=='object')return;if(x.tag)nodes.push(x);for(const c of x.children??[])walk(c);}walk(r);
 const buttons=nodes.filter(x=>x.tag==='button');assert.equal(buttons.length,2);assert(buttons.every(x=>x.props.disabled));assert(!nodes.some(x=>x.tag==='a'));
});
