import {randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../package.json',import.meta.url));
const {generateRegistrationOptions,verifyRegistrationResponse,generateAuthenticationOptions,verifyAuthenticationResponse}=await import(require.resolve('@simplewebauthn/server'));
// Historical ledger test fixture only. Never imported by the product.
import {canonical,digest} from '../../bundle/approval-ledger.js';
export class ApprovalAuth {
 constructor(ledger,{origin,rpID}){
  this.l=ledger;this.db=ledger.db;
  const u=new URL(origin);if(u.origin!==origin||u.username||u.password||u.hostname!==rpID||!(u.protocol==='https:'||(u.protocol==='http:'&&rpID==='localhost')))throw Error('INVALID_APPROVAL_ORIGIN');
  this.origin=origin;this.rpID=rpID;
 }
 credentials(){return this.db.prepare('SELECT * FROM approval_credentials WHERE disabled=0').all();}
 // Administrative enrollment preparation only. NOT registered as an RPC/model/browser method.
 issueEnrollment(principal){
  if(typeof principal!=='string'||!principal.trim()||principal.length>120)throw Error('INVALID_APPROVER');
  if(this.db.prepare('SELECT count(*) AS n FROM approval_credentials').get().n)throw Error('APPROVER_ALREADY_ENROLLED');
  const ticket=randomBytes(32).toString('base64url');
  this.l.store.tx(()=>{this.db.prepare('UPDATE approval_enrollment SET used=1').run();this.db.prepare('INSERT INTO approval_enrollment VALUES (?,?,?,0)').run(digest(ticket),principal,this.l.now()+600000);});return ticket;
 }
 enrollment(ticket){
  if(typeof ticket!=='string'||ticket.length>128)throw Error('ENROLLMENT_DENIED');
  const r=this.db.prepare('SELECT * FROM approval_enrollment WHERE ticket_hash=?').get(digest(ticket));
  if(!r||r.used||r.expires<=this.l.now()||this.db.prepare('SELECT count(*) AS n FROM approval_credentials').get().n)throw Error('ENROLLMENT_DENIED');return r;
 }
 async begin(kind,args={}){
  if(!['enroll','login','decision','workbench'].includes(kind))throw Error('INVALID_APPROVAL_ACTION');
  if(this.db.prepare('SELECT count(*) AS n FROM approval_challenges WHERE used=0 AND expires>?').get(this.l.now()).n>=100)throw Error('APPROVAL_RATE_LIMIT');
  let options,binding;
  if(kind==='enroll'){
   const e=this.enrollment(args.ticket);binding={ticket_hash:e.ticket_hash,principal:e.principal};
   options=await generateRegistrationOptions({rpName:'DSH 自有任务审批',rpID:this.rpID,userName:e.principal,userID:randomBytes(32),attestationType:'none',authenticatorSelection:{residentKey:'preferred',userVerification:'required'},timeout:120000});
  }else{
   const cs=this.credentials();if(!cs.length)throw Error('APPROVER_NOT_ENROLLED');
   binding={};if(kind==='workbench'){if(!this.workbench)throw Error('APPROVAL_WORKBENCH_DISABLED');binding=this.workbench.binding(args.operation_id,args.origin);}
   if(kind==='decision'){
    const r=this.l.assertDecision(args.request_id,args.action);binding={request_id:r.id,action:args.action,proposal_hash:r.proposal_hash};
   }
   options=await generateAuthenticationOptions({rpID:this.rpID,allowCredentials:cs.map(c=>({id:c.id})),userVerification:'required',timeout:120000});
  }
  const id=randomUUID();this.l.store.tx(()=>{
   // Recheck after asynchronous option generation so concurrent requests cannot bypass the cap.
   if(this.db.prepare('SELECT count(*) AS n FROM approval_challenges WHERE used=0 AND expires>?').get(this.l.now()).n>=100)throw Error('APPROVAL_RATE_LIMIT');
   this.db.prepare("DELETE FROM approval_challenges WHERE kind NOT IN ('decision','workbench') AND expires<?").run(this.l.now()-600000);
   this.db.prepare('INSERT INTO approval_challenges VALUES (?,?,?,?,?,0,NULL)').run(id,kind,options.challenge,canonical(binding),this.l.now()+120000);
  });
  return {challenge_id:id,options};
 }
 challenge(id,kind){const c=this.db.prepare('SELECT * FROM approval_challenges WHERE id=?').get(id);if(!c||c.kind!==kind)throw Error('APPROVAL_CHALLENGE_DENIED');return c;}
 async finish(kind,{challenge_id,response}){
  const c=this.challenge(challenge_id,kind),proof_hash=digest(response),binding=JSON.parse(c.binding);
  if(c.used){
   const result=JSON.parse(c.result??'null');if(kind==='workbench'&&result?.proof_hash===proof_hash)return {...this.workbench.receipt(binding.intent_id),idempotent:true};
   if(kind==='decision'&&result?.proof_hash===proof_hash)return {...this.l.view(binding.request_id),idempotent:true};
   throw Error('APPROVAL_CHALLENGE_USED');
  }
  if(c.expires<=this.l.now())throw Error('APPROVAL_CHALLENGE_EXPIRED');
  try{
   const data=JSON.parse(Buffer.from(response.response.clientDataJSON,'base64url'));
   if(data.crossOrigin===true||data.topOrigin!==undefined)throw Error();
  }catch{throw Error('PASSKEY_CROSS_ORIGIN_DENIED');}
  let verification,credential;
  try{
   if(kind==='enroll')verification=await verifyRegistrationResponse({response,expectedChallenge:c.challenge,expectedOrigin:this.origin,expectedRPID:this.rpID,requireUserPresence:true,requireUserVerification:true});
   else{
    credential=this.db.prepare('SELECT * FROM approval_credentials WHERE id=? AND disabled=0').get(response.id);
    if(!credential)throw Error();
    verification=await verifyAuthenticationResponse({response,expectedChallenge:c.challenge,expectedOrigin:kind==='workbench'?binding.origin:this.origin,expectedRPID:this.rpID,credential:{id:credential.id,publicKey:new Uint8Array(credential.public_key),counter:credential.counter},requireUserVerification:true});
   }
  }catch{throw Error('PASSKEY_VERIFICATION_FAILED');}
  if(!verification.verified)throw Error('PASSKEY_VERIFICATION_FAILED');
  return this.l.store.tx(()=>{
   const current=this.challenge(challenge_id,kind);if(current.used)throw Error('APPROVAL_CHALLENGE_USED');if(current.expires<=this.l.now())throw Error('APPROVAL_CHALLENGE_EXPIRED');
   let result;
   if(kind==='enroll'){
    const e=this.db.prepare('SELECT * FROM approval_enrollment WHERE ticket_hash=?').get(binding.ticket_hash);
    if(!e||e.used||e.expires<=this.l.now()||this.db.prepare('SELECT count(*) AS n FROM approval_credentials').get().n)throw Error('ENROLLMENT_DENIED');
    const k=verification.registrationInfo.credential;
    this.db.prepare('INSERT INTO approval_credentials VALUES (?,?,?,?,0,?)').run(k.id,binding.principal,Buffer.from(k.publicKey),k.counter,this.l.now());
    this.db.prepare('UPDATE approval_enrollment SET used=1 WHERE ticket_hash=?').run(binding.ticket_hash);
    result={principal:binding.principal,enrolled:true,approval_granted:false};
   }else{
    const k=this.db.prepare('SELECT * FROM approval_credentials WHERE id=? AND disabled=0').get(credential.id);
    if(!k||k.counter!==credential.counter)throw Error('PASSKEY_STATE_CHANGED');
    if(kind==='workbench')result=this.workbench.record(binding,k,proof_hash,challenge_id);
    else if(kind==='decision'){
     const r=this.l.assertDecision(binding.request_id,binding.action);if(r.proposal_hash!==binding.proposal_hash)throw Error('APPROVAL_PROPOSAL_CHANGED');
     result=this.l.recordDecision({...binding,principal:k.principal,credential_id:k.id,proof_hash,challenge_id});
    }else result={principal:k.principal,credential_id:k.id,authenticated:true};
    this.db.prepare('UPDATE approval_credentials SET counter=? WHERE id=?').run(verification.authenticationInfo.newCounter,k.id);
   }
   this.db.prepare('UPDATE approval_challenges SET used=1,result=? WHERE id=?').run(canonical({proof_hash}),challenge_id);return result;
  });
 }
}
