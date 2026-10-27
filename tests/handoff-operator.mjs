// Isolated regression worker. Never loads production configuration or credentials.
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=resolve(process.argv[2]);
if(!existsSync(root+'/ISOLATED_DSH_TEST'))throw Error('TEST_MARKER_REQUIRED');
const moduleRoot=process.env.DSH_TEST_BUNDLE??fileURLToPath(new URL('../bundle/',import.meta.url));
const {Coordinator}=await import(pathToFileURL(resolve(moduleRoot,'store.js')));
const {RepositoryWriter}=await import(pathToFileURL(resolve(moduleRoot,'repository-writer.js')));
const writer=new RepositoryWriter(JSON.parse(readFileSync(root+'/bindings.json')));
const store=new Coordinator(root+'/state',writer);
const command=JSON.parse(readFileSync(0,'utf8'));
try{
 if(command.crashAfterGit){const write=writer.write.bind(writer);writer.write=q=>{write(q);process.exit(91);};}
 if(!['accept','begin','request','apply','safe','status','snapshot'].includes(command.method))throw Error('TEST_METHOD_DENIED');
 const result=store[command.method](...command.args);console.log(JSON.stringify({ok:true,result}));
}catch(e){console.log(JSON.stringify({ok:false,error:e.message}));}finally{store.close();}
