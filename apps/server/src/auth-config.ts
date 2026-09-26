import {isAbsolute} from 'node:path';
import {importPKCS8} from 'jose';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { createAccessSigner, RecoveryCipher } from './adapters/crypto/auth-crypto.js';
import { parseMailConfig, smtpConfigOf } from './adapters/mail/transport.js';

const appleConfigSchema=z.object({teamId:z.string().regex(/^[A-Z0-9]{10}$/),keyId:z.string().regex(/^[A-Z0-9]{10}$/),clientId:z.string().regex(/^[A-Za-z0-9.-]{1,255}$/),namespace:z.string().regex(/^[A-Za-z0-9._-]{1,255}$/),privateKeyFile:z.string().refine(isAbsolute)}).strict();
const keyFileSchema = z.object({activeVersion:z.string().min(1).max(40),keys:z.record(z.string(),z.string().regex(/^[A-Za-z0-9+/]{43}=$/))}).strict();
async function readConfigFile(path: string | undefined, secret: boolean) {
  if (!path) throw new Error('auth_secret_missing');
  const info=await stat(path);
  if(!info.isFile() || info.size>65_536 || (secret && (info.mode & 0o077)!==0)) throw new Error('auth_secret_file_rejected');
  return readFile(path,'utf8');
}
export async function readAuthConfig(env:NodeJS.ProcessEnv) {
  try {
    const issuer=env.SIYUE_JWT_ISSUER;
    const audience=env.SIYUE_JWT_AUDIENCE;
    const kid=env.SIYUE_JWT_KEY_ID;
    if(!issuer || !audience || !kid) throw new Error('missing');
    const productionIssuer='https://api.qiugeapp.com/api/siyue';
    if(env.SIYUE_ENVIRONMENT==='production' ? issuer!==productionIssuer || audience!=='siyue-api' : issuer===productionIssuer) throw new Error('environment');
    if(env.SIYUE_EMAIL_ENABLED!==undefined && !['true','false'].includes(env.SIYUE_EMAIL_ENABLED) || env.SIYUE_APPLE_ENABLED!==undefined && !['true','false'].includes(env.SIYUE_APPLE_ENABLED)) throw new Error('provider_not_implemented');
    let apple;
    if(env.SIYUE_APPLE_ENABLED==='true'){
      const config=appleConfigSchema.parse(JSON.parse(await readConfigFile(env.SIYUE_APPLE_CONFIG_FILE,true)));
      const privateKey=await readConfigFile(config.privateKeyFile,true);
      await importPKCS8(privateKey,'ES256');
      apple={teamId:config.teamId,keyId:config.keyId,clientId:config.clientId,namespace:config.namespace,privateKey};
    }
    // One private file decides the mail provider. A file written before the Resend adapter has no
    // `provider` key and stays SMTP; `mail` is the normalised view, `smtp` keeps its old shape.
    const mail=env.SIYUE_EMAIL_ENABLED==='true' ? parseMailConfig(JSON.parse(await readConfigFile(env.SIYUE_MAIL_CONFIG_FILE,true))) : undefined;
    const smtp=mail?smtpConfigOf(mail):undefined;
    const privateKey=await readConfigFile(env.SIYUE_JWT_PRIVATE_KEY_FILE,true);
    const jwks=JSON.parse(await readConfigFile(env.SIYUE_JWT_VERIFY_KEYS_FILE,false));
    const keyConfig=keyFileSchema.parse(JSON.parse(await readConfigFile(env.SIYUE_SECRET_ENCRYPTION_KEY_FILE,true)));
    const keys=new Map(Object.entries(keyConfig.keys).map(([version,key])=>[version,Buffer.from(key,'base64')]));
    const pepper=(await readConfigFile(env.SIYUE_CHALLENGE_PEPPER_FILE,true)).trim();
    if(!/^[A-Za-z0-9+/]{43}=$/.test(pepper) || [...keys.values()].some(key=>key.equals(Buffer.from(pepper,'base64')))) throw new Error('invalid_pepper');
    return {signer:await createAccessSigner({privateKey,jwks,kid,issuer,audience}),cipher:new RecoveryCipher(keyConfig.activeVersion,keys),pepper:Buffer.from(pepper,'base64'),smtp,mail,apple};
  } catch { throw new Error('invalid_auth_configuration'); }
}
