// Software authenticator for cryptographic regression ONLY. It is not human acceptance evidence.
import {createHash,generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {encodeCBOR} from '../../bundle/node_modules/@levischuck/tiny-cbor/esm/index.js';
const h=x=>createHash('sha256').update(x).digest(),b=x=>Buffer.from(x).toString('base64url');
export function softwareAuthenticator(){
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=publicKey.export({format:'jwk'}),id=randomBytes(32);
 const cose=Buffer.from(encodeCBOR(new Map([[1,2],[3,-7],[-1,1],[-2,new Uint8Array(Buffer.from(jwk.x,'base64url'))],[-3,new Uint8Array(Buffer.from(jwk.y,'base64url'))]])));
 let counter=0;
 function response(options,{origin='http://localhost:19468',rpID='localhost',flags,register=false,crossOrigin=false,topOrigin,challenge=options.challenge}={}){
  const client=Buffer.from(JSON.stringify({type:register?'webauthn.create':'webauthn.get',challenge,origin,crossOrigin,...(topOrigin?{topOrigin}:{})}));
  const count=Buffer.alloc(4);count.writeUInt32BE(++counter);let auth=Buffer.concat([h(rpID),Buffer.from([flags??(register?0x45:0x05)]),count]);
  if(register){const len=Buffer.alloc(2);len.writeUInt16BE(id.length);auth=Buffer.concat([auth,Buffer.alloc(16),len,id,cose]);}
  const data=register?{clientDataJSON:b(client),attestationObject:b(encodeCBOR(new Map([['fmt','none'],['authData',new Uint8Array(auth)],['attStmt',new Map()]]))),transports:['internal']}:{clientDataJSON:b(client),authenticatorData:b(auth),signature:b(sign('sha256',Buffer.concat([auth,h(client)]),privateKey)),userHandle:null};
  return {id:b(id),rawId:b(id),type:'public-key',clientExtensionResults:{},response:data};
 }
 return {id:b(id),response};
}
