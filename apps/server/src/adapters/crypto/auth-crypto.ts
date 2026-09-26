import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify, createLocalJWKSet, importPKCS8, type JSONWebKeySet } from 'jose';
import { z } from 'zod';

const claimsSchema = z.object({iss:z.string(), aud:z.string(), sub:z.uuid(), sid:z.uuid(), jti:z.uuid(),
  iat:z.number().int(), exp:z.number().int(), cv:z.number().int().positive(), token_use:z.literal('access')}).strict();
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function matchesDigest(secret: string, expected: string) {
  return /^[0-9a-f]{64}$/.test(expected) && timingSafeEqual(Buffer.from(digest(secret), 'hex'), Buffer.from(expected, 'hex'));
}
export function opaqueToken() {
  const id = randomUUID(); const secret = randomBytes(32).toString('base64url');
  return {id, value: `${id}.${secret}`, hash: digest(secret)};
}
export function parseOpaque(value: string) {
  const parsed = z.string().regex(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/).parse(value);
  const [id, secret] = parsed.split('.');
  return {id: z.uuid().parse(id), secret: secret!};
}
export class RecoveryCipher {
  constructor(private readonly activeVersion: string, private readonly keys: ReadonlyMap<string, Buffer>) {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(activeVersion) || !keys.has(activeVersion) || keys.size > 5 ||
        [...keys.values()].some(key => key.length !== 32)) throw new Error('invalid_encryption_keys');
  }
  seal(value: unknown, context: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.activeVersion)!, iv);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [this.activeVersion, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
  }
  open(value: string, context: string): unknown {
    if (value.length > 32_768) throw new Error('invalid_recovery_ciphertext');
    const [version, iv, tag, encrypted, extra] = value.split('.');
    const key = version && this.keys.get(version);
    if (!key || !iv || !tag || !encrypted || extra !== undefined) throw new Error('invalid_recovery_ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8'));
  }
}
export async function createAccessSigner(config: {privateKey: string; jwks: JSONWebKeySet; kid: string; issuer: string; audience: string}) {
  if (!config.kid || !config.issuer || !config.audience || !config.jwks.keys.length || config.jwks.keys.length > 5 ||
      config.jwks.keys.some(key => key.kty !== 'EC' || key.crv !== 'P-256' || key.d || !key.kid || key.alg !== 'ES256') ||
      new Set(config.jwks.keys.map(key => key.kid)).size !== config.jwks.keys.length) throw new Error('invalid_signing_config');
  const privateKey = await importPKCS8(config.privateKey, 'ES256');
  const keySet = createLocalJWKSet(config.jwks);
  const api = {
    async sign(subjectId: string, sessionId: string, version: number, now: Date, expires: Date) {
      return new SignJWT({sid:sessionId, cv:version, token_use:'access'})
        .setProtectedHeader({alg:'ES256', kid:config.kid, typ:'JWT'}).setIssuer(config.issuer).setAudience(config.audience)
        .setSubject(subjectId).setJti(randomUUID()).setIssuedAt(Math.floor(+now/1000)).setExpirationTime(Math.floor(+expires/1000)).sign(privateKey);
    },
    async verify(token: string, now: Date) {
      if (token.length > 4096) throw new Error('invalid_access');
      const {payload, protectedHeader} = await jwtVerify(token, keySet, {algorithms:['ES256'], issuer:config.issuer,
        audience:config.audience, currentDate:now, typ:'JWT', requiredClaims:['iat','exp','sub','jti','sid','cv','token_use'], maxTokenAge:'15m'});
      const claims = claimsSchema.parse(payload);
      if (!protectedHeader.kid || claims.iat > Math.floor(+now/1000) || claims.exp <= claims.iat || claims.exp-claims.iat > 900) throw new Error('invalid_access_time');
      return claims;
    },
  };
  // Detect mismatched private/public key configuration before serving requests.
  const now = new Date();
  await api.verify(await api.sign(randomUUID(), randomUUID(), 1, now, new Date(+now+60_000)), now);
  return api;
}
export type AccessSigner = Awaited<ReturnType<typeof createAccessSigner>>;
