import nodemailer from 'nodemailer';
import { z } from 'zod';
import type { MailPayload, MailTransport, MailResult } from './outbox.js';

export const smtpConfigSchema=z.object({host:z.string().min(1).max(253).regex(/^[a-zA-Z0-9.-]+$/),port:z.number().int().min(1).max(65535),secure:z.boolean().optional(),
  user:z.string().min(1).max(254),password:z.string().min(1).max(4096),from:z.email().max(254)}).strict();
export type SmtpConfig=z.infer<typeof smtpConfigSchema>;
export function renderMail(payload:MailPayload) {
  if(payload.template==='password-changed') return payload.locale==='zh-CN'
    ?{subject:'思玥：密码已更改',text:'你的思玥密码已更改，所有设备已退出登录。如非本人操作，请在思玥应用中找回密码。'}
    :{subject:'Siyue: password changed',text:'Your Siyue password was changed and all devices were signed out. If this was not you, reset your password in the Siyue app.'};
  // Sent to the removed address. Other login addresses may still exist, so describe only the
  // method we actually removed and the session/challenge state the transaction guarantees.
  if(payload.template==='email-unlinked') return payload.locale==='zh-CN'
    ?{subject:'思玥：登录邮箱已移除',text:'这个邮箱已不再是你的思玥账号登录方式，所有设备均已退出登录，相关未完成的邮箱验证已失效。你的账号仍可通过其余已绑定的登录方式使用。若非本人操作，请用仍可用的登录方式进入思玥并检查账号安全。'}
    :{subject:'Siyue: sign-in email removed',text:'This address is no longer a sign-in method for your Siyue account. All devices were signed out and related unfinished email verifications were cancelled. Your account remains accessible through its other linked sign-in methods. If this was not you, sign in with a remaining method and review your account security.'};
  const purpose=payload.purpose==='register'?(payload.locale==='zh-CN'?'注册':'registration')
   :payload.purpose==='link-email'?(payload.locale==='zh-CN'?'绑定邮箱':'email binding')
   :(payload.locale==='zh-CN'?'重置密码':'password reset');
  // Binding an address to an existing account is not a sign-up or a reset; it says what the
  // code actually authorises so a user who never requested it can recognise the message.
  if(payload.purpose==='link-email') return payload.locale==='zh-CN'
    ?{subject:'思玥绑定邮箱验证码',text:`你的思玥绑定邮箱验证码是 ${payload.code}，10 分钟内有效。验证后该邮箱与设置的新密码可登录你已有的思玥账号。请勿与他人分享；若非本人请求，请忽略。`}
    :{subject:'Siyue email binding code',text:`Your Siyue email binding code is ${payload.code}. It expires in 10 minutes. After confirmation this email and the new password you set can sign in to your existing Siyue account. Do not share it. Ignore this message if you did not request it.`};
  return payload.locale==='zh-CN'
    ?{subject:`思玥${purpose}验证码`,text:`你的思玥${purpose}验证码是 ${payload.code}，10 分钟内有效。请勿与他人分享。若非本人请求，请忽略。`}
    :{subject:`Siyue ${purpose} code`,text:`Your Siyue ${purpose} code is ${payload.code}. It expires in 10 minutes. Do not share it. Ignore this message if you did not request it.`};
}
export function createSmtpTransport(input:SmtpConfig):MailTransport {
  const config=smtpConfigSchema.parse(input);
  const transport=nodemailer.createTransport({host:config.host,port:config.port,secure:config.secure??config.port===465,requireTLS:true,
    auth:{user:config.user,pass:config.password},tls:{minVersion:'TLSv1.2',rejectUnauthorized:true},
    connectionTimeout:10_000,greetingTimeout:10_000,socketTimeout:20_000,disableFileAccess:true,disableUrlAccess:true,logger:false,debug:false});
  return {
    async send(id,payload):Promise<MailResult> {
      try {
        const result=await transport.sendMail({from:{name:'Siyue',address:config.from},to:payload.to,...renderMail(payload),
          messageId:`<siyue-${id}@${config.from.split('@')[1]}>`,disableFileAccess:true,disableUrlAccess:true});
        return result.accepted.length===1?'accepted':'rejected';
      } catch(error) {
        // Only failures known to precede submission may retry. No raw SMTP response is logged/stored.
        const failure=error as {code?:string;command?:string;responseCode?:number};
        if(failure.code==='EAUTH' || (failure.responseCode && failure.responseCode>=500)) return 'rejected';
        // Nodemailer may label a post-DATA disconnect as CONN too; command alone is not evidence
        // that submission did not occur. DNS failure and explicit negative SMTP replies are safe.
        if(failure.code==='EDNS') return 'retryable';
        if(failure.responseCode && failure.responseCode>=400 && failure.responseCode<500) return 'retryable';
        return 'uncertain';
      }
    },
    close(){transport.close();},
  };
}
