import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// Fixed test suite owned by the plugin, not a model-selected command or repository script.
const source=readFileSync(0,'utf8');
const {summarize}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
assert.equal(typeof summarize,'function');
assert.deepEqual(summarize({completed:7,queued:3,review:2}),{total:12,completionRate:58.3});
assert.deepEqual(summarize({completed:0,queued:0,review:0}),{total:0,completionRate:0});
assert.deepEqual(summarize({completed:1,queued:2,review:0}),{total:3,completionRate:33.3});
assert.throws(()=>summarize({completed:-1,queued:1,review:0}));
assert.throws(()=>summarize({completed:1.5,queued:1,review:0}));
assert.throws(()=>summarize({completed:'1',queued:1,review:0}));
process.stdout.write(JSON.stringify({validator:'task-summary-v1',cases:6,passed:true}));
