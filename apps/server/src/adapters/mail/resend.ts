import { z } from 'zod';
import { renderMail } from './smtp.js';
import type { MailResult, MailTransport } from './outbox.js';

// One fixed HTTPS endpoint. A provider is chosen by private configuration, never by a queued job,
// so no job payload or response can point a send at another host.
const endpoint='https://api.resend.com/emails';
const defaultTimeoutMs=10_000;

// Strict on purpose: the file may carry an API key and a From address and nothing else, so a stray
// `endpoint`/`host`/`to` key is rejected rather than quietly ignored.
export const resendConfigSchema=z.object({provider:z.literal('resend'),apiKey:z.string().min(1).max(512).regex(/^\S+$/),from:z.email().max(254)}).strict();
export type ResendConfig=z.infer<typeof resendConfigSchema>;
/** Bounded wait for one attempt. Only tests pass a value; deployments use the default. */
export type ResendTransportOptions={timeoutMs?:number};

export function createResendTransport(input:ResendConfig,options:ResendTransportOptions={}):MailTransport {
  const config=resendConfigSchema.parse(input);
  const timeoutMs=options.timeoutMs??defaultTimeoutMs;
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60_000) throw new Error('invalid_timeout');
  return {
    async send(id,payload):Promise<MailResult> {
      const rendered=renderMail(payload);
      let response:Response;
      try {
        response=await fetch(endpoint,{method:'POST',redirect:'error',cache:'no-store',credentials:'omit',
          headers:{authorization:`Bearer ${config.apiKey}`,'content-type':'application/json',
            // Stable per job and inside Resend's 256-character limit: a retried job presents the same
            // 24-hour key, so an already accepted request returns its original response instead of a
            // second message.
            'idempotency-key':`siyue/${id}`},
          body:JSON.stringify({from:`Siyue <${config.from}>`,to:[payload.to],subject:rendered.subject,text:rendered.text}),
          signal:AbortSignal.timeout(timeoutMs)});
      } catch {
        // Timeout, DNS/TLS failure or a dropped connection: the request may or may not have been
        // accepted, so the outcome stays unknown. Nothing about the failure or the response is logged.
        return 'uncertain';
      }
      // Only the status is used. The body is released unread so no provider text, address or id is kept.
      await response.body?.cancel().catch(()=>{});
      if(response.status>=200&&response.status<300) return 'accepted';
      // 429 is Resend's explicit rate/quota reply and the only documented retryable outcome.
      if(response.status===429) return 'retryable';
      // A refused request (validation, authentication, authorisation, routing) was never submitted and
      // will not succeed on a later attempt with the same payload.
      if(response.status>=400&&response.status<500&&response.status!==409) return 'rejected';
      // 409 says another request with this key is still in progress; 5xx and anything else leave the
      // outcome unknown. An unknown outcome is terminal rather than blindly resent.
      return 'uncertain';
    },
    // Native fetch keeps no connection pool of ours, so there is nothing to close.
    close(){},
  };
}
