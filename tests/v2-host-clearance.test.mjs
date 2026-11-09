import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {widgetClearance,observeHostClearance} from '../ui-source/v2/host-clearance.mjs';
const rect=(left,top,width,height)=>({left,top,width,height,right:left+width,bottom:top+height});
const zero={top:0,right:0,bottom:0,left:0};
test('absent, hidden-sized and outside widget reserve no space',()=>{
 for(const pet of [null,rect(0,0,0,50),rect(1100,200,150,150),rect(50,-100,50,20)])assert.deepEqual(widgetClearance(rect(0,0,1000,800),pet),zero);
});
test('desktop right pet preserves full height and left pet can be avoided too',()=>{
 assert.deepEqual(widgetClearance(rect(280,0,1000,820),rect(1120,540,150,150)),{...zero,right:168});
 assert.deepEqual(widgetClearance(rect(0,0,1000,820),rect(0,540,150,150)),{...zero,left:158});
});
test('narrow desktop/web retain readable width, including titlebar and nested mount',()=>{
 for(const width of [320,390,520]){
  const frame=rect(0,0,width,820),pet=rect(width-100,610,100,100),i=widgetClearance(frame,pet,48);
  assert.equal(i.bottom,218);assert.equal(i.left+i.right,0);assert.equal(i.top,0);
 }
 const i=widgetClearance(rect(280,60,390,800),rect(570,680,100,100),0);assert.equal(i.bottom,188);
});
test('top and center pets use available free region without negative sizes',()=>{
 for(const frame of [rect(0,0,320,500),rect(20,50,1400,900)])for(const pet of [rect(frame.left+20,frame.top+20,120,120),rect(frame.left+60,frame.top+200,100,100)]){
  const i=widgetClearance(frame,pet,48);assert(Object.values(i).every(n=>n>=0));assert(i.left+i.right<frame.width);assert(i.top+i.bottom<frame.height);
 }
});
test('optional observer is read-only outside its own root and cleans subscriptions',()=>{
 const source=readFileSync(new URL('../ui-source/v2/host-clearance.mjs',import.meta.url),'utf8');
 assert.equal(typeof observeHostClearance(null),'function');
 assert(!source.includes('setInterval'));assert(!source.includes('localStorage'));assert(!source.includes('fetch('));
 assert(!/pet\.(?:style|remove|setAttribute)/.test(source));
 for(const s of ['cancelAnimationFrame','ro.disconnect()','petObserver.disconnect()','mounts.disconnect()','shell.disconnect()','removeEventListener'])assert(source.includes(s));
 const css=readFileSync(new URL('../ui-source/v2/style.css',import.meta.url),'utf8');
 assert(css.includes('--dsh-frame-top-clearance,48px'));assert(css.includes('[data-global-panel] .v2-workbench'));
 assert(!/\.dshwv-[^{}]+\{/.test(css));
});
