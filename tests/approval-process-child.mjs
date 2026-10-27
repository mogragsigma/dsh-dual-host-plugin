// Test-only process boundary; no HTTP listener and no production profile.
import {Coordinator} from '../bundle/store.js';
import {TaskCatalog} from '../bundle/task-catalog.js';
import {ApprovalLedger} from '../bundle/approval-ledger.js';
import {ApprovalAuth} from './fixtures/legacy-approval-auth.mjs';
const store=new Coordinator(process.argv[2]),ledger=new ApprovalLedger(store,new TaskCatalog(store),()=>1792210000000),auth=new ApprovalAuth(ledger,{origin:'http://localhost:19468',rpID:'localhost'});
process.on('message',async({id,op,args})=>{try{let value;if(op==='begin')value=await auth.begin('decision',args);else if(op==='finish')value=await auth.finish('decision',args);else if(op==='read')value=ledger.view(args.id);else throw Error('TEST_METHOD_DENIED');process.send({id,value});}catch(e){process.send({id,error:e.message});}});
process.send({ready:true});
