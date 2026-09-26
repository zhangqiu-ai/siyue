import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as argon2 from 'argon2';
import { accountPasswordSchema, newAccountPasswordSchema } from '@siyue/contracts';
import { digest } from '../../adapters/crypto/auth-crypto.js';
import { AuthError } from './sessions.js';

const parameters = {type:argon2.argon2id,memoryCost:65_536,timeCost:3,parallelism:1,hashLength:32} as const;
/** Process-wide bound shared by all password operations, including dummy verification. */
let active = 0;
const waiting: Array<() => void> = [];
async function bounded<T>(work: () => Promise<T>): Promise<T> {
  if (active >= 2) {
    if (waiting.length >= 4) throw new AuthError('AUTH_BUSY',429);
    await new Promise<void>((resolve,reject) => {
      const enter = () => {clearTimeout(timer);resolve();};
      const timer = setTimeout(() => {const index=waiting.indexOf(enter);if(index>=0) waiting.splice(index,1);reject(new AuthError('AUTH_BUSY',429));},3000);
      waiting.push(enter);
    });
  } else active++;
  try {return await work();}
  finally {const next=waiting.shift();if(next) next();else active--;}
}
export async function createPasswordService() {
  const entries=(await readFile(new URL('../../../resources/common-password-sha256.txt',import.meta.url),'utf8')).trim().split('\n');
  if(entries.length<10_000 || entries.some(entry=>! /^[a-f0-9]{64}$/.test(entry))) throw new Error('password_denylist_invalid');
  const denied=new Set(entries);
  const dummy=await bounded(()=>argon2.hash(randomBytes(32).toString('base64url'),parameters));
  return {
    validateNew(password: string) {
      if(!newAccountPasswordSchema.safeParse(password).success) throw new AuthError('AUTH_PASSWORD_POLICY',400);
      if(denied.has(digest(password.toLowerCase()))) throw new AuthError('AUTH_PASSWORD_TOO_COMMON',400);
    },
    async hash(password: string) {
      this.validateNew(password);
      return bounded(()=>argon2.hash(password,parameters));
    },
    async rehashVerified(password: string) {
      accountPasswordSchema.parse(password);
      return bounded(()=>argon2.hash(password,parameters));
    },
    async verify(password: string, stored: string | undefined) {
      if(!accountPasswordSchema.safeParse(password).success) return false;
      const result=await bounded(()=>argon2.verify(stored ?? dummy,password));
      return stored!==undefined && result;
    },
    needsRehash(stored: string) {return argon2.needsRehash(stored,parameters);},
  };
}
export type PasswordService = Awaited<ReturnType<typeof createPasswordService>>;
