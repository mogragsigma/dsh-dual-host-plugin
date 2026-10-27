// Actual compiled UI rendered with a tiny element adapter; no browser or network.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import vm from 'node:vm';
function component(){
 const source=readFileSync(new URL('../bundle/workbench-client.js',import.meta.url),'utf8');let output;
 const replaced=source.replace("return {name:'task-workbench',inject:['connection','slots','layout','uiWorkspace','sessions'],apply};",'return {RepositoryEvidence,repositoryNotice};');assert.notEqual(source,replaced);
 const React={createElement:(tag,props,...children)=>typeof tag==='function'?tag({...props,children}):({tag,props,children})};
 vm.runInNewContext(replaced,{window:{__ModuleLoader__:{load:m=>{output=m.factory(n=>{assert.equal(n,'react');return React;});}}}});return output;
}
const base={state:'bound',url:'https://gitee.com/fixture/no-network',branch:'main',revision:1,verified_at:1000,verification_fresh:false,base_sha:'a'.repeat(40)};
for(const [error,text] of [['REPOSITORY_ACCESS_DENIED','上次核验未获访问权限'],['REPOSITORY_NOT_FOUND_OR_PRIVATE','不能据此断言已被删除'],['REPOSITORY_RATE_LIMIT','不代表权限被撤销'],['REPOSITORY_PROVIDER_UNAVAILABLE','当前访问能力未知'],['REPOSITORY_BASELINE_CHANGED','重新核对关联与审批'],['REPOSITORY_IDENTITY_MISMATCH','不能沿用旧关联授权']])test('stored repository error is visible without a new provider request: '+error,()=>{
 const c=component(),r={...base,error},s=JSON.stringify(c.RepositoryEvidence({repository:r}));assert(s.includes(text));assert(s.includes('页面刷新只读取已保存记录'));assert(!s.includes('"tag":"button"'));assert(!s.includes('"tag":"a"'));assert(c.repositoryNotice(r));
});
test('fresh/unbound/stale states do not fabricate an access failure',()=>{
 const c=component();assert.equal(c.repositoryNotice({state:'unbound'}),null);assert.equal(c.repositoryNotice({...base,verification_fresh:true}),null);
 assert.equal(c.repositoryNotice(base).label,'历史核验待更新');assert(!JSON.stringify(c.RepositoryEvidence({repository:base})).includes('权限被撤销'));
 assert(c.repositoryNotice({...base,error:'REPOSITORY_ACCESS_DENIED',verification_fresh:true}).detail.includes('上次核验未获访问权限'));
});
test('unknown errors never echo raw provider or credential strings',()=>{
 const c=component(),s=JSON.stringify(c.RepositoryEvidence({repository:{...base,error:'SECRET_TOKEN_RAW_PROVIDER_TRACE'}}));assert(s.includes('原因未能安全识别'));assert(!s.includes('SECRET_TOKEN'));
});
