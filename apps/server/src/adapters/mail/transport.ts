import { z } from 'zod';
import type { MailTransport } from './outbox.js';
import { createSmtpTransport, smtpConfigSchema, type SmtpConfig } from './smtp.js';
import { createResendTransport, resendConfigSchema, type ResendConfig, type ResendTransportOptions } from './resend.js';

/** `provider` is optional so a private file written before this adapter keeps working unchanged. */
export type MailConfig=({provider:'smtp'}&SmtpConfig)|ResendConfig;

const rawSchema=z.record(z.string(),z.unknown());

export function parseMailConfig(input:unknown):MailConfig {
  const raw=rawSchema.safeParse(input);
  if(!raw.success) throw new Error('invalid_mail_config');
  const {provider,...rest}=raw.data;
  if(provider===undefined||provider==='smtp') return {provider:'smtp',...smtpConfigSchema.parse(rest)};
  if(provider==='resend') return resendConfigSchema.parse(raw.data);
  // An unrecognised provider must not fall back to another transport that would then read the same keys.
  throw new Error('invalid_mail_config');
}

/** The SMTP portion as its own object, so callers that only need SMTP never see the transport tag. */
export function smtpConfigOf(config:MailConfig):SmtpConfig|undefined {
  if(config.provider==='resend') return undefined;
  const {provider:_provider,...smtp}=config;
  return smtp;
}

export function createMailTransport(config:MailConfig,options:ResendTransportOptions={}):MailTransport {
  if(config.provider==='resend') return createResendTransport(config,options);
  const {provider:_provider,...smtp}=config;
  return createSmtpTransport(smtp);
}
