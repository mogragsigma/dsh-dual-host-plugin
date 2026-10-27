// Optional public client contract; independent from third-party internals and native navigation.
export function createImClientBridge(){
 let service=null,generation=0,snapshot=Object.freeze({available:false,generation:0});const listeners=new Set();
 const update=()=>{snapshot=Object.freeze({available:!!service,generation:++generation});for(const listener of listeners)listener();};
 return {
  subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
  getSnapshot:()=>snapshot,
  attach(candidate){
   if(candidate?.version!==1||typeof candidate.render!=='function')return()=>{};
   service=candidate;update();
   return()=>{if(service===candidate){service=null;update();}};
  },
  render(){return service?.render({preferredSectionId:'feishu'})??null;},
 };
}
