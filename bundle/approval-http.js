// Retired URLs return a clear non-actionable response. No auth object is created,
// no input is consumed and no cookie, challenge, invitation or decision is issued.
export class ApprovalWindow {
 async handle(_req,res){
  res.writeHead(410,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'});
  res.end(JSON.stringify({error:'APPROVAL_PASSKEY_RETIRED',message:'此旧审批入口已停用。请回到大肥鱼bot的对应任务查看处理方式；不需要注册新身份。',approval_granted:false,execution_granted:false}));
 }
}
