import {importPKCS8,SignJWT} from 'jose';
import {z} from 'zod';
import {AppleIdentityError,createAppleIdentityVerifier} from './identity.js';

export class AppleExchangeError extends Error {
  constructor(readonly reason:'rejected'|'unknown'|'invalid_identity'){super('apple_authorization_restart_required');}
}
const tokenResponse=z.object({id_token:z.string().min(1).max(16*1024),refresh_token:z.string().min(1).max(8192),
  access_token:z.string().min(1).max(8192),token_type:z.literal('Bearer'),expires_in:z.number().int().positive()});
type Config={teamId:string;keyId:string;clientId:string;privateKey:string};
type Options={fetcher?:typeof fetch;now?:()=>Date;timeoutMs?:number;verify?:ReturnType<typeof createAppleIdentityVerifier>};
/** Server-only native code exchange. Never retries a consumed/possibly consumed code.
 * The flow owner must durably claim its transaction BEFORE calling this, and durably
 * store the verified result before issuing a Siyue session. No database work occurs here.
 */
export async function createAppleCodeExchange(config:Config,options:Options={}){
  const timeout=options.timeoutMs??10_000,now=options.now??(()=>new Date()),fetcher=options.fetcher??fetch;
  if(!/^[A-Z0-9]{10}$/.test(config.teamId)||!/^[A-Z0-9]{10}$/.test(config.keyId)||!Number.isInteger(timeout)||timeout<1||timeout>30_000)throw new Error('invalid_apple_exchange_config');
  const verify=options.verify??createAppleIdentityVerifier(config.clientId);
  // Validate even when the verifier is injected by a trusted host/test.
  if(!/^[A-Za-z0-9.-]{1,255}$/.test(config.clientId))throw new Error('invalid_apple_exchange_config');
  let key:CryptoKey;try{key=await importPKCS8(config.privateKey,'ES256');}catch{throw new Error('invalid_apple_exchange_config');}
  return async(input:{authorizationCode:string;expectedNonceHash:string;expectedSubject:string})=>{
    if(typeof input.authorizationCode!=='string'||!input.authorizationCode.length||input.authorizationCode.length>2048||
      !/^[0-9a-f]{64}$/.test(input.expectedNonceHash)||typeof input.expectedSubject!=='string'||!input.expectedSubject.length||input.expectedSubject.length>255)throw new Error('invalid_apple_exchange_input');
    const issued=Math.floor(+now()/1000);if(!Number.isFinite(issued))throw new Error('invalid_apple_exchange_clock');
    const secret=await new SignJWT({}).setProtectedHeader({alg:'ES256',kid:config.keyId}).setIssuer(config.teamId).setSubject(config.clientId)
      .setAudience('https://appleid.apple.com').setIssuedAt(issued).setExpirationTime(issued+300).sign(key);
    const controller=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    let timer:ReturnType<typeof setTimeout>;
    const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();void reader?.cancel().catch(()=>{});reject(new AppleExchangeError('unknown'));},timeout);});
    const check=()=>{if(controller.signal.aborted)throw new AppleExchangeError('unknown');};
    const work=(async()=>{
      try{
        const response=await fetcher('https://appleid.apple.com/auth/token',{method:'POST',redirect:'error',credentials:'omit',signal:controller.signal,
          headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},
          body:new URLSearchParams({client_id:config.clientId,client_secret:secret,code:input.authorizationCode,grant_type:'authorization_code'})});
        check();
        if(response.redirected||!response.ok){void response.body?.cancel().catch(()=>{});throw new AppleExchangeError(!response.redirected&&[400,401].includes(response.status)?'rejected':'unknown');}
        if(!response.headers.get('content-type')?.toLowerCase().includes('application/json')||!response.body||Number(response.headers.get('content-length'))>32*1024){void response.body?.cancel().catch(()=>{});throw new AppleExchangeError('unknown');}
        reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
        while(true){const part=await reader.read();check();if(part.done)break;size+=part.value.length;if(size>32*1024)throw new AppleExchangeError('unknown');chunks.push(part.value);}
        const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
        const parsed=tokenResponse.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
        check();const identity=await verify(parsed.id_token,input.expectedNonceHash,now());check();
        if(identity.subject!==input.expectedSubject||identity.clientId!==config.clientId)throw new AppleExchangeError('invalid_identity');
        return {identity,refreshToken:parsed.refresh_token};
      }catch(error){
        if(error instanceof AppleExchangeError)throw error;
        if(error instanceof AppleIdentityError&&error.code==='invalid_identity')throw new AppleExchangeError('invalid_identity');
        throw new AppleExchangeError('unknown');
      }finally{void reader?.cancel().catch(()=>{});}
    })();
    try{return await Promise.race([work,deadline]);}finally{clearTimeout(timer!);}
  };
}
