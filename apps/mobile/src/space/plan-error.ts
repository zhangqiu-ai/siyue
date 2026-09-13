import { CompatibleChatError } from '../chat/compatible-transport.ts';
import { SettingsError } from '../settings/credential-store.ts';
import type { MessageKey } from '../i18n/core.ts';

/** Never display provider bodies, credential errors, or incomplete model output. */
export function planErrorKey(error: unknown): MessageKey {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'configuration_required') return 'plan.configRequired';
  if (code === 'cancelled' || error instanceof Error && error.name === 'AbortError') return 'plan.cancelled';
  if (code === 'invalid_input') return 'plan.invalidInput';
  if (code === 'invalid_output') {
    const reason = error && typeof error === 'object' && 'reason' in error ? error.reason : undefined;
    if (reason === 'json') return 'plan.invalidJson';
    if (reason === 'schema') return 'plan.invalidSchema';
    return 'plan.invalidOutput';
  }
  if (error instanceof SettingsError) return 'plan.configError';
  if (error instanceof CompatibleChatError) {
    if (error.message === '请求过于频繁或额度不足，请稍后重试并检查服务商额度。') return 'plan.rateLimit';
    if (error.message === 'AI 回复超时，请稍后重试。') return 'plan.timeout';
    if (error.message === '密钥无效或没有模型访问权限，请检查 AI 设置。') return 'plan.configError';
    if (['回复已达到长度上限，内容尚未完整，已收到的文字已保留。', '回复连接提前中断，已收到的文字已保留，请重试。', '服务商中止了这次回复，内容可能不完整，请调整问题后重试。'].includes(error.message)) return 'plan.incomplete';
  }
  return 'plan.failed';
}
