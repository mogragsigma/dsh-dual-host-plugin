// Optional coexistence with the installed whale widget. Read geometry only;
// never move, hide, configure or import another plugin. No polling.
export function widgetClearance(frame, widget, shellTop=0) {
 const zero={top:0,right:0,bottom:0,left:0};
 if(!widget||widget.width<=0||widget.height<=0)return zero;
 const x=Math.max(frame.left,widget.left-8),y=Math.max(frame.top+shellTop,widget.top-8);
 const right=Math.min(frame.right,widget.right+8),bottom=Math.min(frame.bottom,widget.bottom+8);
 if(right<=x||bottom<=y)return zero;
 const width=frame.width,height=Math.max(0,frame.height-shellTop);
 const options=[
  {inset:{...zero,right:frame.right-x},w:x-frame.left,h:height},
  {inset:{...zero,left:right-frame.left},w:frame.right-right,h:height},
  {inset:{...zero,bottom:frame.bottom-y},w:width,h:y-frame.top-shellTop},
  {inset:{...zero,top:bottom-frame.top-shellTop},w:width,h:frame.bottom-bottom},
 ];
 // Keep narrow windows readable: prefer a full-width area above/below the pet.
 const usable=options.filter(o=>o.w>=Math.min(320,width)&&o.h>=Math.min(240,height));
 const vertical=width<=580?usable.filter(o=>o.inset.left===0&&o.inset.right===0):[];
 const best=(vertical.length?vertical:usable.length?usable:options).sort((a,b)=>b.w*b.h-a.w*a.h)[0];
 return best.inset;
}

export function observeHostClearance(root) {
 if(!root)return()=>{};
 const doc=root.ownerDocument,win=doc.defaultView;let pet=null,raf=0,disposed=false;
 const properties=['top','right','bottom','left'].map(k=>'--v2-widget-'+k);
 const visible=node=>node&&win.getComputedStyle(node).display!=='none'&&win.getComputedStyle(node).visibility!=='hidden';
 const measure=()=>{
  raf=0;if(disposed)return;
  const image=pet?.querySelector('.dshwv-img');
  const rect=visible(pet)&&visible(image)?image.getBoundingClientRect():null;
  const inset=widgetClearance(root.getBoundingClientRect(),rect,parseFloat(win.getComputedStyle(root).getPropertyValue('--v2-shell-top'))||0);
  for(const [side,n]of Object.entries(inset)){
   const key='--v2-widget-'+side,value=Math.ceil(n)+'px';
   if(root.style.getPropertyValue(key)!==value)root.style.setProperty(key,value);
  }
 };
 const schedule=()=>{if(!disposed&&!raf)raf=win.requestAnimationFrame(measure);};
 const ro=new win.ResizeObserver(schedule),petObserver=new win.MutationObserver(schedule);
 const discover=()=>{
  const next=doc.querySelector('.dshwv-root');
  if(next!==pet){petObserver.disconnect();if(pet)ro.unobserve(pet);pet=next;
   if(pet){ro.observe(pet);petObserver.observe(pet,{subtree:true,childList:true,attributes:true,attributeFilter:['style','class','hidden']});}}
  schedule();
 };
 // The widget mounts directly under body. Observe insertion/removal there,
 // not every mutation in the application's task tree.
 const mounts=new win.MutationObserver(discover);mounts.observe(doc.body,{childList:true});
 const shell=new win.MutationObserver(schedule);
 for(let n=root.parentElement;n;n=n.parentElement)shell.observe(n,{attributes:true,attributeFilter:['data-platform','data-fullscreen','data-sidebar-collapsed','data-sidebar-drawer','style']});
 ro.observe(root);win.addEventListener('resize',schedule);doc.addEventListener('transitionend',schedule,true);doc.addEventListener('pointerup',schedule,true);discover();
 return()=>{disposed=true;win.cancelAnimationFrame(raf);ro.disconnect();petObserver.disconnect();mounts.disconnect();shell.disconnect();win.removeEventListener('resize',schedule);doc.removeEventListener('transitionend',schedule,true);doc.removeEventListener('pointerup',schedule,true);for(const key of properties)root.style.removeProperty(key);};
}
