// Presentation only. Neither the legacy IM flag nor a draft grants directory access.
export function fileScopeObservation(files,{uncertain=false,cloud=false,freshness}={}){
 if(!files?.available||!Array.isArray(files.sendRoots))return null;
 const registered=typeof files.scopeHash==='string'&&files.scopeHash.length>0;
 return {
  roots:[...files.sendRoots],
  title:registered?'上次核对的已登记范围':'默认候选范围 · 尚未授权',
  note:uncertain||cloud&&freshness!=='remote_checked'
   ?'当前结果未核对；下列历史目录不能证明现在可发送。'
   :registered?'仅表示本次查询的目录记录；实际可发送性仍由启用状态、文件和目标端校验决定。':'这些默认路径尚未获得发送授权。',
 };
}
