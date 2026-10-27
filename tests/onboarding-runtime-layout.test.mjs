import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
test('runtime section wrapper stays one column while its approved card grid remains unchanged',async()=>{
 const ui=await fs.readFile(new URL('../bundle/workbench-client.js',import.meta.url),'utf8');
 assert.match(ui,/className:"run-sections"/);
 assert(ui.includes('.dsh-onboarding .run-sections{display:grid;grid-template-columns:minmax(0,1fr);gap:18px;min-width:0}'));
 assert(ui.includes('.dsh-onboarding .stack{display:grid;grid-template-columns:minmax(0,1.24fr) minmax(0,1fr);gap:18px;align-items:start}'));
});
