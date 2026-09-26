import {readFile,stat} from 'node:fs/promises';
import {registrationPolicySchema,type RegistrationPolicy} from '@siyue/contracts';
export type {RegistrationPolicy} from '@siyue/contracts';

export const publishedRegistrationPolicySchema=registrationPolicySchema.refine(policy=>policy.enabled);
export const disabledRegistrationPolicy:RegistrationPolicy=Object.freeze({enabled:false,terms:null,privacy:null});
/** Missing publication configuration closes sign-up, while existing account login stays available. */
export async function readRegistrationPolicy(env:NodeJS.ProcessEnv):Promise<RegistrationPolicy>{
  const path=env.SIYUE_REGISTRATION_POLICY_FILE;
  if(!path)return disabledRegistrationPolicy;
  try{
    const file=await stat(path);if(!file.isFile()||file.size>8192)throw Error('invalid');
    const policy=publishedRegistrationPolicySchema.parse(JSON.parse(await readFile(path,'utf8')));
    if(!policy.enabled||!policy.terms||!policy.privacy)throw Error('invalid');
    return Object.freeze({...policy,terms:Object.freeze(policy.terms),privacy:Object.freeze(policy.privacy)});
  }catch{throw Error('invalid_registration_policy_configuration');}
}
