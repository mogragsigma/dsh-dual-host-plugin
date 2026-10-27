import {parse} from 'acorn';
// A tiny pure expression/function subset for this one acceptance adapter.
// Node's permission model is defence-in-depth, NOT the boundary for untrusted JS.
export function validateDevelopmentSource(source){
 let ast;try{ast=parse(source,{ecmaVersion:2022,sourceType:'module'});}catch{throw Error('DEVELOPMENT_SOURCE_SYNTAX');}
 const fn=ast.body[0]?.declaration;
 if(ast.body.length!==1||ast.body[0].type!=='ExportNamedDeclaration'||fn?.type!=='FunctionDeclaration'||fn.id?.name!=='summarize'||fn.async||fn.generator||fn.params.length!==1)throw Error('DEVELOPMENT_SOURCE_SUBSET');
 const fields=new Set(['completed','queued','review','total','completionRate']);
 const builtins=new Set(['Number','Math','TypeError','RangeError','Error']);
 const methods={Number:new Set(['isSafeInteger','isInteger','isFinite']),Math:new Set(['round','floor','ceil'])};
 const reserved=new Set(['process','globalThis','global','fetch','Function','eval','require','module']);
 const names=new Set(),arrays=new Set(),params=new Set();let count=0;
 const fail=()=>{throw Error('DEVELOPMENT_SOURCE_SUBSET');};
 const bind=(n,set=names)=>{if(n?.type!=='Identifier'||!/^[_a-zA-Z][_a-zA-Z0-9]{0,31}$/.test(n.name)||(builtins.has(n.name)||reserved.has(n.name))||n.name==='summarize'||n.name==='undefined')fail();set.add(n.name);names.add(n.name);};
 if(fn.params[0].type==='Identifier')bind(fn.params[0],params);
 else if(fn.params[0].type==='ObjectPattern'){
  for(const p of fn.params[0].properties){if(p.type!=='Property'||p.computed||p.method||!fields.has(p.key.name))fail();bind(p.value);}
 }else fail();
 const collect=n=>{if(!n||typeof n!=='object')return;if(n.type==='VariableDeclarator'){bind(n.id);if(n.init?.type==='ArrayExpression')arrays.add(n.id.name);}if(n.type==='ArrowFunctionExpression')for(const p of n.params)bind(p);for(const v of Object.values(n))if(Array.isArray(v))v.forEach(collect);else if(v&&typeof v==='object')collect(v);};collect(fn.body);
 function visit(n,depth=0){
  if(!n||++count>500||depth>40)fail();const v=x=>visit(x,depth+1);
  switch(n.type){
   case 'BlockStatement':n.body.forEach(v);break;
   case 'VariableDeclaration':if(n.kind!=='const')fail();n.declarations.forEach(v);break;
   case 'VariableDeclarator':v(n.init);break;
   case 'ReturnStatement':case 'ThrowStatement':v(n.argument);break;
   case 'IfStatement':v(n.test);v(n.consequent);if(n.alternate)v(n.alternate);break;
   case 'Identifier':if(!names.has(n.name))fail();break;
   case 'Literal':if(n.regex||n.bigint||!['string','number','boolean'].includes(typeof n.value)||typeof n.value==='string'&&n.value.length>1000||typeof n.value==='number'&&!Number.isFinite(n.value))fail();break;
   case 'ArrayExpression':if(n.elements.length>6)fail();n.elements.forEach(v);break;
   case 'ObjectExpression':for(const p of n.properties){if(p.type!=='Property'||p.computed||p.method||p.kind!=='init'||!fields.has(p.key.name))fail();v(p.value);}break;
   case 'UnaryExpression':if(!['!','-','+','typeof'].includes(n.operator))fail();v(n.argument);break;
   case 'BinaryExpression':case 'LogicalExpression':if(!['+','-','*','/','%','===','!==','==','!=','<','<=','>','>=','&&','||'].includes(n.operator))fail();v(n.left);v(n.right);break;
   case 'ConditionalExpression':v(n.test);v(n.consequent);v(n.alternate);break;
   case 'MemberExpression':if(n.computed||n.optional||n.object.type!=='Identifier'||!params.has(n.object.name)||!fields.has(n.property.name))fail();break;
   case 'CallExpression':{
    const m=n.callee;if(n.optional||m.type!=='MemberExpression'||m.computed||m.optional||m.object.type!=='Identifier')fail();
    const obj=m.object.name,key=m.property.name;
    if(methods[obj]?.has(key)){if(n.arguments.length!==1)fail();n.arguments.forEach(v);}
    else if(arrays.has(obj)&&['some','every'].includes(key)&&n.arguments.length===1&&n.arguments[0].type==='ArrowFunctionExpression')v(n.arguments[0]);else fail();break;
   }
   case 'ArrowFunctionExpression':if(n.async||n.params.length!==1)fail();v(n.body);break;
   case 'NewExpression':if(n.callee.type!=='Identifier'||!['Error','TypeError','RangeError'].includes(n.callee.name)||n.arguments.length!==1||n.arguments[0].type!=='Literal'||typeof n.arguments[0].value!=='string')fail();v(n.arguments[0]);break;
   default:fail();
  }
 }
 visit(fn.body);return source;
}
