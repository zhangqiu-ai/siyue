import {createRemoteJWKSet,decodeProtectedHeader,jwtVerify,errors,type JWTVerifyGetKey} from 'jose';
import {matchesDigest} from '../../adapters/crypto/auth-crypto.js';

export class AppleIdentityError extends Error {
  constructor(readonly code:'invalid_identity'|'provider_unavailable'){super(code);}
}
const invalid=()=>new AppleIdentityError('invalid_identity');
/** Trusted server configuration only. A token never selects the key URL or expected audience.
 * State, transaction expiry and one-time consumption belong to the flow service, not this verifier.
 */
export function createAppleIdentityVerifier(clientId:string,resolveKey:JWTVerifyGetKey=createRemoteJWKSet(
  new URL('https://appleid.apple.com/auth/keys'),{timeoutDuration:5000,cooldownDuration:30_000,cacheMaxAge:600_000},
)) {
  if(!/^[A-Za-z0-9.-]{1,255}$/.test(clientId))throw new Error('invalid_apple_client');
  return async(token:string,expectedNonceHash:string,now:Date)=>{
    if(typeof token!=='string'||token.length>16*1024||!Number.isFinite(+now)||!/^[0-9a-f]{64}$/.test(expectedNonceHash))throw invalid();
    try{
      const header=decodeProtectedHeader(token);
      if(header.alg!=='RS256'||typeof header.kid!=='string'||!header.kid.length||header.kid.length>200||header.jku!==undefined||header.x5u!==undefined||header.jwk!==undefined)throw invalid();
    }catch{throw invalid();}
    let payload;
    try{
      ({payload}=await jwtVerify(token,resolveKey,{algorithms:['RS256'],issuer:'https://appleid.apple.com',audience:clientId,
        requiredClaims:['iss','aud','sub','exp','iat','nonce'],currentDate:now,clockTolerance:60,maxTokenAge:600}));
    }catch(error){
      if(error instanceof errors.JWTClaimValidationFailed||error instanceof errors.JWTExpired||error instanceof errors.JWTInvalid||
        error instanceof errors.JWSInvalid||error instanceof errors.JWSSignatureVerificationFailed||error instanceof errors.JOSEAlgNotAllowed||
        error instanceof errors.JWKSNoMatchingKey||error instanceof errors.JOSENotSupported)throw invalid();
      throw new AppleIdentityError('provider_unavailable');
    }
    if(typeof payload.sub!=='string'||payload.sub.length<1||payload.sub.length>255||/[\x00-\x20\x7f]/.test(payload.sub)||
      payload.aud!==clientId||typeof payload.nonce!=='string'||!matchesDigest(payload.nonce,expectedNonceHash)||
      typeof payload.iat!=='number'||typeof payload.exp!=='number'||!Number.isSafeInteger(payload.iat)||!Number.isSafeInteger(payload.exp)||payload.exp<=payload.iat)throw invalid();
    // Email, real-user status and first-login profile fields are not account identity.
    return {provider:'apple' as const,subject:payload.sub,clientId};
  };
}
