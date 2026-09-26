import {importPKCS8,SignJWT} from 'jose';
import {z} from 'zod';

/** The single allowed 'error' values of Apple's revoke ErrorResponse. Anything else is not a
 * classified rejection; it is an unavailable provider and therefore retryable by the outbox. */
export const appleRevokeErrorSchema=z.enum(['invalid_request','invalid_client','invalid_grant',
 'unauthorized_client','unsupported_grant_type','invalid_scope']);
export type AppleRevokeError=z.infer<typeof appleRevokeErrorSchema>;
/** Apple answers 200 with no body when the token was revoked now OR was already invalid (official
 * "Token revocation" reference). Both are terminal for this credential, so one 200 must never queue
 * a second attempt. A rejection stays separate because our own client authentication failing is a
 * different fact from the credential being dead. */
export type AppleRevocationOutcome=
 |{outcome:'revoked'}
 |{outcome:'rejected';error:AppleRevokeError}
 |{outcome:'unavailable'};
const errorResponse=z.object({error:appleRevokeErrorSchema});
const inputSchema=z.object({refreshToken:z.string().min(1).max(8192)}).strict();
type Config={teamId:string;keyId:string;clientId:string;privateKey:string};
type Options={fetcher?:typeof fetch;now?:()=>Date;timeoutMs?:number};
/** Server-only Apple token revocation against the documented fixed endpoint
 * POST https://appleid.apple.com/auth/revoke. Trusted configuration alone decides the endpoint, the
 * ES256 client secret and the refresh_token hint; a caller only supplies the token itself.
 *
 * The adapter performs exactly ONE attempt and never retries: a consumed or ambiguous outcome
 * belongs to the controlled outbox that owns backoff and expiry (design 13.3). The provider body is
 * read only to classify a documented error code, so no response text, token or client secret is
 * ever returned, logged or attached to an error.
 */
export async function createAppleTokenRevocation(config:Config,options:Options={}){
 const timeout=options.timeoutMs??10_000,now=options.now??(()=>new Date()),fetcher=options.fetcher??fetch;
 if(!/^[A-Z0-9]{10}$/.test(config.teamId)||!/^[A-Z0-9]{10}$/.test(config.keyId)||
   !/^[A-Za-z0-9.-]{1,255}$/.test(config.clientId)||
   !Number.isInteger(timeout)||timeout<1||timeout>30_000)throw new Error('invalid_apple_revocation_config');
 let key:CryptoKey;try{key=await importPKCS8(config.privateKey,'ES256');}catch{throw new Error('invalid_apple_revocation_config');}
 return async(input:{refreshToken:string}):Promise<AppleRevocationOutcome>=>{
  const parsed=inputSchema.safeParse(input);
  if(!parsed.success)throw new Error('invalid_apple_revocation_input');
  const issued=Math.floor(+now()/1000);
  if(!Number.isFinite(issued))throw new Error('invalid_apple_revocation_config');
  // Same ES256 client-secret shape the code exchange already uses; it never leaves this adapter.
  const secret=await new SignJWT({}).setProtectedHeader({alg:'ES256',kid:config.keyId}).setIssuer(config.teamId)
   .setSubject(config.clientId).setAudience('https://appleid.apple.com').setIssuedAt(issued).setExpirationTime(issued+300).sign(key);
  const controller=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  let timer:ReturnType<typeof setTimeout>;
  const deadline=new Promise<AppleRevocationOutcome>(resolve=>{timer=setTimeout(()=>{
   controller.abort();void reader?.cancel().catch(()=>{});resolve({outcome:'unavailable'});},timeout);});
  const aborted=():AppleRevocationOutcome|undefined=>controller.signal.aborted?{outcome:'unavailable'}:undefined;
  const work=(async():Promise<AppleRevocationOutcome>=>{
   try{
    const response=await fetcher('https://appleid.apple.com/auth/revoke',{method:'POST',redirect:'error',credentials:'omit',signal:controller.signal,
     headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},
     body:new URLSearchParams({client_id:config.clientId,client_secret:secret,token:parsed.data.refreshToken,token_type_hint:'refresh_token'})});
    const stopped=aborted();
    // A followed redirect means the request did not go where configuration says it goes.
    if(stopped||response.redirected||response.status===200){void response.body?.cancel().catch(()=>{});
     return stopped??(response.redirected?{outcome:'unavailable'}:{outcome:'revoked'});}
    // Only a bounded JSON 400 body from the fixed endpoint is classified. Every other status is an
    // unavailable provider and a candidate for a bounded outbox retry, never a silent success.
    if(response.status!==400||!response.body||!response.headers.get('content-type')?.toLowerCase().includes('application/json')||
      Number(response.headers.get('content-length'))>8*1024){void response.body?.cancel().catch(()=>{});return {outcome:'unavailable'};}
    reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
    while(true){const part=await reader.read();const halted=aborted();if(halted)return halted;if(part.done)break;
     size+=part.value.length;if(size>8*1024)return {outcome:'unavailable'};chunks.push(part.value);}
    const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
    const body=errorResponse.safeParse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
    return body.success?{outcome:'rejected',error:body.data.error}:{outcome:'unavailable'};
   }catch{return {outcome:'unavailable'};}
   finally{void reader?.cancel().catch(()=>{});}
  })();
  try{return await Promise.race([work,deadline]);}finally{clearTimeout(timer!);}
 };
}
