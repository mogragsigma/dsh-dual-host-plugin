import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../bundle/'+p,import.meta.url),'utf8');
for(const p of ['native-rules/AGENTS.md','global-rules/AGENTS.md','skills/task-approval/SKILL.md']){
 test(p+' distinguishes record-only authority from current runtime capability',()=>{
  const s=read(p);assert(s.includes('### 真实执行方案与仅记账方案'));
  assert(s.includes('先修订并重新送审，不修改旧方案或追溯扩大授权'));
  assert(s.includes('开发不包含 commit 或 push'));
  assert(s.includes('代理输入')&&s.includes('不冒称本人手打'));
  assert(!s.includes('本版本不开放开发写入')&&!s.includes('本版本所有开发及发布执行器仍关闭'));
  assert(s.includes('当前运行时')||s.includes('当前运行开关'));
 });
}
test('worker and repository skills preserve independent grants and no raw Git bypass',()=>{
 assert(read('skills/task-development/SKILL.md').includes('不能通过开启运行能力把旧方案转为执行许可'));
 assert(read('skills/task-repository/SKILL.md').includes('push 另需独立审批与运行门禁'));
 assert(read('skills/task-approval/SKILL.md').includes('不能调用旧 runner、bash、git push 绕过'));
});
