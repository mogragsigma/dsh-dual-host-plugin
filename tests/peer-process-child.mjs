import {Gateway} from '../bundle/index.js';
const root=process.argv[2];
const ctx={on(){},effect(){},agents:{list:()=>[]},agentPresets:{composedPreset:()=>undefined}};
const g=new Gateway(ctx,{role:'cloud',namespace:'process-test',port:0,stateDir:root+'/cloud',tokenFile:root+'/tokens.json'});
await g.start();process.send({url:'http://127.0.0.1:'+g.server.address().port});
process.on('SIGTERM',async()=>{await g.close();process.exit(0);});
