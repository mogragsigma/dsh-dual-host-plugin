// Presentation of a point-in-time observation, never a new authorization.
export function repairPresentation(s){
 const r=s.repairStatus?.repair,a=s.repairStatus?.activation;
 const observed=a?.contract===1&&Number.isSafeInteger(a.observedAt)&&a.observedAt>0;
 const matching=observed&&a.repairId===r?.id&&a.sameRecordedRepair===true&&a.sameRecordedHost===true;
 const passed=r?.activationSupported!==false&&matching&&r?.state==='committed'&&a.activationVerified===true&&a.cached===false&&s.repairFresh===true;
 const label=passed?'本次独立核验通过':observed?'已有历史核验记录':'尚未独立核验';
 let guidance=null;
 if(r?.state==='committed'){
  if(r.activationSupported===false)guidance='当前仅证明签名历史中的同版本文件已修复；该路径的独立加载回执尚未提供，不等于在线生效。重启仍需另行预览、确认。';
  else if(passed)guidance='本次新进程加载核验已通过，无需为这条回执重复重启。结果仅代表核验时刻，不保证持续在线；再次观察需手动操作。';
  else if(matching)guidance='已保留这次修复与已登记 Host 的历史核验，不代表当前在线。需要了解现在的状态，请手动刷新；不因历史记录自动重启或重复核验。';
  else if(observed)guidance='历史回执与当前已登记的修复或 Host 不一致，不能沿用。请先手动刷新并核对当前进程；需要重启时仍须另行预览、确认。';
  else guidance='文件修复成功不等于已经加载。请先手动刷新；只有本次修复之后独立确认的新启动才能进行生效核验，不沿用修复前的进程记录。';
 }
 return {label,guidance,observedAt:observed?a.observedAt:null,matching,passed};
}
