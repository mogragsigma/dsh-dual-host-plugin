import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const bundle=await fs.readFile(new URL('../bundle/workbench-client.js',import.meta.url),'utf8');
const text=bundle.replace(/\\u([0-9a-f]{4})/gi,(_,h)=>String.fromCharCode(parseInt(h,16)));
test('connection actions have scoped spacing and readable capsule boundaries',()=>{
 assert(bundle.includes('.dsh-onboarding .connection-panel .connection-actions{display:flex;flex-wrap:wrap;align-items:center;gap:16px;'));
 assert(bundle.includes('.dsh-onboarding .connection-panel .button{min-height:44px;max-width:100%;'));
 assert(bundle.includes('.dsh-onboarding .connection-panel .button.secondary{background:#fff;border-color:#d4e3f1;'));
 assert(bundle.includes('.dsh-onboarding .connection-utility{display:flex;flex-wrap:wrap;align-items:center;gap:16px;margin-top:24px;padding-top:20px;'));
 assert(bundle.includes('.dsh-onboarding .connection-confirm{display:grid;gap:12px;'));
});
test('connection controls expose action groups and preserve keyboard/reduced-motion feedback',()=>{
 for(const label of ['确认或取消模型接入','云端凭据交接操作','确认或取消凭据交接','模型名称核对'])assert(text.includes(label),label);
 assert(text.includes('token_model_status'));
 assert(bundle.includes('.dsh-onboarding .connection-panel .button:focus-visible{outline:2px solid #5fa8ef;outline-offset:-3px;box-shadow:none;transition:none}'));
 assert(bundle.includes('.dsh-onboarding .connection-panel .button:focus-visible:active{transform:none}'));
 assert(bundle.includes('.dsh-onboarding .connection-panel .button:hover,.dsh-onboarding .connection-panel .button:active{transform:none!important}'));
});
test('credential rows separate status from actions and keep the same button language',()=>{
 assert(bundle.includes('.dsh-onboarding .credential-row{display:flex;flex-direction:column;align-items:stretch;gap:14px;'));
 assert(bundle.includes('.dsh-onboarding .credential-row>.info-row{border:0;padding:0;'));
 assert(bundle.includes('.dsh-onboarding .credential-actions{display:flex;flex-wrap:wrap;align-items:center;gap:16px;'));
 assert(bundle.includes('.dsh-onboarding .credential-actions>.button{flex:1 1 130px;font-size:12px}'));
 assert(text.includes('凭据操作'));
});
test('all onboarding buttons wrap within their container and have consistent focus boundaries',()=>{
 assert(bundle.includes('.dsh-onboarding .button{display:inline-flex;align-items:center;justify-content:center;flex:0 1 auto;gap:8px;min-width:0;max-width:100%;min-height:44px;'));
 assert(bundle.includes('.dsh-onboarding .button.secondary{background:#fff;border-color:#d4e3f1;'));
 assert(bundle.includes('.dsh-onboarding .button>span{min-width:0;overflow-wrap:anywhere}'));
 assert(bundle.includes('.dsh-onboarding .button:focus-visible:active{transform:none}'));
 assert(text.includes('云端启动计划操作'));
 assert(!bundle.includes('.credential-row>div:nth-child(2){flex:1'));
});
test('credential consent help is not raised into the preceding input',()=>{
 assert(!bundle.includes('.check-controls>.field-markers{margin-top:-4px}'));
 assert(bundle.includes('.dsh-onboarding .modal-body>.field,.dsh-onboarding .modal-body>.check-controls{margin-top:20px}'));
 assert(bundle.includes('.dsh-onboarding .install-plan>.check-controls+.button{margin-top:16px}'));
});
test('SSH trust and read-only probe keep separate bounded action groups',()=>{
 for(const label of ['主机信任记录操作','主机信任确认','云端只读预检'])assert(text.includes(label),label);
 assert(bundle.includes('.dsh-onboarding .ssh-probe-actions{margin-top:20px;padding-top:20px;border-top:1px solid #e1ebf6}'));
 assert(bundle.includes('.dsh-onboarding .ssh-trust-consent{margin-top:20px}'));
});
test('cloud plan preview and stacked panels have explicit spacing',()=>{
 assert(text.includes('云端安装计划预览'));
 assert(bundle.includes('.dsh-onboarding .cloud-plan-preview{margin-top:20px}'));
 assert(bundle.includes('.dsh-onboarding .cloud-installation>.stack{display:grid;grid-template-columns:minmax(0,1fr);gap:18px}'));
 assert(!bundle.includes('.dsh-onboarding .cloud-installation>.stack{display:block}'));
});

test('own controls reset Host corner shapes and preserve quiet action gaps',()=>{
 assert(bundle.includes('.dsh-onboarding .button,.dsh-onboarding .icon-button,.dsh-onboarding .field-help-button,.dsh-onboarding .toggle,.dsh-onboarding .toggle span{corner-shape:round}'));
 assert(bundle.includes('background:var(--blue);border-color:var(--blue);color:#fff'));
 assert(bundle.includes('.dsh-onboarding .form-actions>.button,.dsh-onboarding .connection-actions>.button,.dsh-onboarding .credential-actions>.button{margin:0}'));
 assert(bundle.includes('.dsh-onboarding .draft-toolbar{column-gap:16px;row-gap:16px}'));
 assert(bundle.includes('.dsh-onboarding .connection-actions>.button{flex:1 1 100%}'));
});
test('native IM surface has an owned padded boundary, not descendant theme overrides',()=>{
 assert(bundle.includes('.dsh-native-im-frame{flex:1 1 auto;min-height:0;min-width:0;overflow:auto;padding:20px;'));
 assert(bundle.includes('.dsh-native-im-shell{display:flex;flex-direction:column;gap:20px;'));
 assert(!/\.dsh-native-im-frame\s+(?:button|input|\*)/.test(bundle));
 assert(text.includes('原设置入口保留'));
});

test('small icon focus rings stay inside their hit areas instead of crossing field borders',()=>{
 assert(bundle.includes('.dsh-onboarding .field-help-button:focus-visible,.dsh-onboarding .icon-button:focus-visible{outline:2px solid #5fa8ef;outline-offset:-2px;box-shadow:none;transition:none}'));
 assert(bundle.includes('.dsh-onboarding .field-help-button:focus-visible{outline-offset:-6px}'));
 assert(bundle.includes('.dsh-onboarding .field-help-button:focus-visible:active,.dsh-onboarding .icon-button:focus-visible:active{transform:none}'));
 assert(bundle.includes('.dsh-onboarding .field{gap:8px}'));
 assert(!bundle.includes('.dsh-onboarding .field{gap:4px}'));
});

test('overview navigation has compact status badges and an inset focus ring',()=>{
 assert(text.includes('overview-title'));
 assert(bundle.includes('.dsh-onboarding .overview-list{display:flex;flex-direction:column;gap:12px;'));
 assert(bundle.includes('grid-template-columns:minmax(0,1fr) auto 14px'));
 assert(bundle.includes('.dsh-onboarding .overview-list>button:focus-visible{outline:2px solid #5fa8ef;outline-offset:-3px;box-shadow:none;transition:none}'));
 assert(bundle.includes('.dsh-onboarding .overview-list>button[aria-current=step]'));
 assert(!bundle.includes('.overview-list>button>span:first-child{flex:1}'));
 assert(bundle.includes('.dsh-onboarding .overview-list .badge{grid-column:1;grid-row:2}'));
});
test('disabled primary buttons do not gain an enabled blue hover fill',()=>{
 assert(bundle.includes('.dsh-onboarding .button.primary:not(:disabled):hover{background:#2689e5}'));
 assert(!bundle.includes('.dsh-onboarding .button.primary:hover{background:#2689e5}'));
});

test('all owned action focus rings remain within the approved capsule boundary',()=>{
 assert(bundle.includes('.dsh-onboarding .button:focus-visible{outline:2px solid #5fa8ef;outline-offset:-3px;'));
 assert(bundle.includes('.dsh-onboarding .guidance-help{border-radius:999px;corner-shape:round;appearance:none}'));
 assert(bundle.includes('.dsh-onboarding .guidance-help:focus-visible,.dsh-onboarding .toggle:focus-visible{outline:2px solid #5fa8ef;outline-offset:-3px;'));
 assert(!bundle.includes('.dsh-onboarding .connection-panel .button:focus-visible{outline:2px solid #5fa8ef;outline-offset:3px;'));
});

test('short text actions retain capsule proportions instead of looking like icon buttons',()=>{
 assert(bundle.includes('.dsh-onboarding .button.text{background:transparent;border-color:transparent;box-shadow:none;padding:10px 16px;min-width:72px;min-height:44px;'));
});
