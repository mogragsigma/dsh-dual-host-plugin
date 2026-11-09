import React,{useEffect,useRef,useState} from 'react';
import {Icon,Button} from '../onboarding/components';
// Same blue-paper metaphor as the approved prototype, scoped to this mounted panel.
export function Deck({trail,back,render,guide,keyboard}){
 const refs=useRef({}),tabs=useRef(),[leaving,setLeaving]=useState(null);
 const trailKey=trail.map(x=>x.key).join('|'),returning=leaving?.trailKey===trailKey;
 const active=returning?leaving.index:trail.length-1;
 const reduced=()=>keyboard||matchMedia('(prefers-reduced-motion: reduce)').matches;
 useEffect(()=>{const el=refs.current[trail[active].key];el?.querySelector('h1')?.focus({preventScroll:true});const nav=tabs.current;const reveal=()=>{const tab=nav?.querySelector('[aria-current=page]');if(nav&&tab){const n=nav.getBoundingClientRect(),t=tab.getBoundingClientRect();if(t.right>n.right)nav.scrollLeft+=t.right-n.right+4;else if(t.left<n.left)nav.scrollLeft+=t.left-n.left-4;}};reveal();const ro=new ResizeObserver(reveal);if(nav)ro.observe(nav);return()=>ro.disconnect();},[trail[active].key]);
 useEffect(()=>{if(leaving===null)return;if(!returning){setLeaving(null);return;}const timer=setTimeout(()=>{back(leaving.index);setLeaving(null);},reduced()?0:260);return()=>clearTimeout(timer);},[leaving,trailKey]);
 const go=i=>{if(!returning&&i>=0&&i<active)setLeaving({index:i,trailKey});};
 return <div className="v2-deck" data-depth={active+1} data-returning={returning?'true':'false'} onKeyDown={e=>{if(e.key==='Escape'&&!e.target.closest('dialog')&&active>0){e.preventDefault();go(active-1);}}}>
  <div className="v2-toolbar">{active>0&&<Button kind="text" aria-label="上一层" onClick={()=>go(active-1)} icon="back">返回</Button>}<nav ref={tabs} aria-label="页面层级" data-guide="tabs">{trail.map((r,i)=><button key={r.key} type="button" className="v2-tab" aria-label={`${i+1} 层 ${r.label}${i===active?'，当前页':''}`} aria-current={i===active?'page':undefined} disabled={returning||i>active} style={{'--angle':i===active?'0deg':i%2?'3deg':'-3deg'}} onClick={()=>go(i)}><span>{String(i+1).padStart(2,'0')}</span>{r.label}</button>)}</nav><Button kind="text" icon="help" onClick={guide} disabled={returning}>操作指引</Button></div>
  <div className="v2-sheets">{trail.map((r,i)=><Sheet key={r.key} returning={returning} active={i===active} exiting={i>active} index={i} keyboard={keyboard} setRef={el=>refs.current[r.key]=el}>{render(r,i===active)}</Sheet>)}</div>
 </div>;
}
function Sheet({active,exiting,index,children,setRef,keyboard,returning}){const [entered,setEntered]=useState(false);useEffect(()=>{let b;const a=requestAnimationFrame(()=>{b=requestAnimationFrame(()=>setEntered(true));});return()=>{cancelAnimationFrame(a);cancelAnimationFrame(b);};},[]);return <article ref={setRef} data-current={active?'true':'false'} className={`v2-paper ${entered?'entered':''} ${active?'current':'ancestor'} ${exiting?'exiting':''}`} inert={!active||returning} aria-hidden={!active} style={{'--angle':index%2?'4deg':'-4deg',zIndex:index+1}}><div className="v2-scroll">{children}</div></article>;}
export function Guide({root,onClose}){
 const [step,setStep]=useState(0),[rect,setRect]=useState(null),[height,setHeight]=useState(220),box=useRef(),card=useRef(),trigger=useRef(document.activeElement);
 const targets=useRef(null);
 if(!targets.current){const current=root.current?.querySelector('[data-current=true]');const nodes=[...current?.querySelectorAll('[data-guide]')??[]].filter(x=>x.getBoundingClientRect().width>0).slice(0,4);const tabs=root.current?.querySelector('[data-guide=tabs]');if(tabs)nodes.push(tabs);targets.current=nodes.map(node=>({guide:node.dataset.guide,title:node.dataset.guideTitle??'便签返回',text:node.dataset.guideText??'点击任意上层便签直接返回；当前纸页标明你的位置。'}));}
 const target=targets.current[step];
 const locate=()=>{const area=target?.guide==='tabs'?root.current:root.current?.querySelector('[data-current=true]');const node=[...area?.querySelectorAll('[data-guide]')??[]].find(n=>n.dataset.guide===target?.guide);return node&&node.getBoundingClientRect().height>220?(node.querySelector('button,label,h2,input')||node):node;};
 useEffect(()=>{box.current.showModal();const ro=new ResizeObserver(()=>setHeight(card.current?.getBoundingClientRect().height??220));if(card.current)ro.observe(card.current);return()=>{ro.disconnect();box.current?.close();trigger.current?.isConnected&&trigger.current.focus();};},[]);
 useEffect(()=>{
  const el=locate();if(!el)return;
  const scroller=el.closest('.v2-scroll');if(scroller){const er=el.getBoundingClientRect(),sr=scroller.getBoundingClientRect();scroller.scrollTop+=er.top-sr.top-Math.max(24,(sr.height-er.height)/2-80);}if(root.current)root.current.scrollTop=0;
  // Host transitions can finish after the first effect; resolve the live node,
  // not a DOM reference captured before React commits the new paper.
  const measure=()=>{const node=locate();if(!node?.isConnected)return;const r=node.getBoundingClientRect(),x=Math.min(innerWidth-8,Math.max(8,r.x-5)),y=Math.min(innerHeight-8,Math.max(8,r.y-5));const next={x,y,w:Math.max(0,Math.min(r.right+5,innerWidth-8)-x),h:Math.max(0,Math.min(r.bottom+5,innerHeight-8)-y)};setRect(old=>old&&Object.keys(next).every(k=>Math.abs(old[k]-next[k])<.25)?old:next);};
  measure();let frame;const end=performance.now()+360;const follow=()=>{measure();if(performance.now()<end)frame=requestAnimationFrame(follow);};frame=requestAnimationFrame(follow);
  const ro=new ResizeObserver(measure);ro.observe(el);if(root.current)ro.observe(root.current);
  const area=root.current,mo=new MutationObserver(measure);if(area)mo.observe(area,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style','data-current']});
  area?.addEventListener('transitionend',measure,true);window.addEventListener('resize',measure);window.addEventListener('scroll',measure,true);
  return()=>{cancelAnimationFrame(frame);ro.disconnect();mo.disconnect();area?.removeEventListener('transitionend',measure,true);window.removeEventListener('resize',measure);window.removeEventListener('scroll',measure,true);};
 },[step]);

 const width=Math.min(340,innerWidth-24),above=rect&&rect.y+rect.h+height+20>innerHeight;
 const top=rect?(above?Math.max(12,rect.y-height-18):Math.min(innerHeight-height-12,rect.y+rect.h+18)):80;
 const left=rect?Math.max(12,Math.min(rect.x,innerWidth-width-12)):12;
 return <dialog ref={box} className="v2-guide" aria-label="操作指引" onCancel={e=>{e.preventDefault();onClose();}}>{rect&&<div className="v2-highlight" style={{left:rect.x,top:rect.y,width:rect.w,height:rect.h}}/>}<section ref={card} className="v2-guide-card" style={{left,top,width}}><span className={'v2-guide-arrow '+(above?'below':'above')} style={{left:Math.max(20,Math.min(width-32,(rect?.x??left)+Math.min((rect?.w??60)/2,80)-left))}}><Icon name={above?'down':'back'}/></span><header><span>操作指引 · {step+1}/{targets.current.length}</span><button onClick={onClose}>退出</button></header><h2>{target?.title??'本页操作'}</h2><p>{target?.text??'当前页面尚未加载可操作内容，请关闭后重新核对。'}</p><footer><Button disabled={!step} onClick={()=>setStep(step-1)}>上一步</Button><Button kind="primary" onClick={()=>step+1>=targets.current.length?onClose():setStep(step+1)}>{step+1>=targets.current.length?'我知道了':'下一步'}</Button></footer></section></dialog>;
}
