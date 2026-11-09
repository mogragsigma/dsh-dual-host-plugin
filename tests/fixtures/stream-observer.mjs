// Acceptance-only metadata. A normally ended iterator can still contain a model error.
const code=x=>typeof x==='string'&&/^[A-Z][A-Z_]{1,63}$/.test(x)?x:'STREAM_FAILED';
export async function* observeStream(stream,record,save=()=>{}){
 Object.assign(record,{chunks:0,iterationEnded:false,modelSucceeded:false,finishKind:null});
 try{
  for await(const part of stream){
   record.chunks++;
   if(part?.type==='finish'){
    record.finishKind=['stop','tool-calls','max-tokens','error','aborted'].includes(part.reason?.kind)?part.reason.kind:'unknown';
    if(['error','aborted'].includes(record.finishKind)){
     record.error_code=code(part.reason?.failure?.code);
     const status=part.reason?.failure?.status;if(Number.isInteger(status)&&status>=100&&status<=599)record.http_status=status;
    }
   }
   yield part;
  }
  record.iterationEnded=true;record.modelSucceeded=['stop','tool-calls'].includes(record.finishKind);
 }catch(e){record.failed=true;record.error_code=code(e?.code);throw e;}finally{save();}
}
