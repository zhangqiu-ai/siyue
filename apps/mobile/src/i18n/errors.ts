import type { Locale } from './core.ts';
// Compatibility map for safe errors emitted by the existing transport and secure store.
// Unknown provider errors are never displayed verbatim (they may contain credentials).
export const errorMessages: Record<string, string> = {
  '无法读取 AI 安全配置，请在设置中重新保存或移除。': 'Could not read secure AI settings. Save them again or remove them in Settings.',
  '请先在设置中配置 AI 服务和密钥。': 'Configure an AI service and API key in Settings first.',
  '连接测试已取消。': 'Connection test cancelled.',
  '请填写有效的模型名称。': 'Enter a valid model name.',
  '请填写有效的 API 密钥。': 'Enter a valid API key.',
  '接口地址过长，请检查。': 'The endpoint is too long. Check the address.',
  '无法读取手机安全存储，请解锁设备后重试。': 'Could not read secure storage. Unlock your device and try again.',
  '保存的 AI 配置无法读取，请移除本机配置后重新设置。': 'Saved AI settings could not be read. Remove the device settings and configure them again.',
  '配置正在保存，请稍后重试。': 'Settings are being saved. Try again shortly.',
  '首次配置或修改服务地址时，请重新输入该服务的密钥。': 'Enter the service API key when configuring it for the first time or changing its endpoint.',
  'AI 配置未保存：手机安全存储不可用，请稍后重试。': 'AI settings were not saved: secure storage is unavailable. Try again later.',
  '无法移除本机密钥，请稍后重试。': 'Could not remove the device API key. Try again later.',
  '服务返回的模型列表无法识别，请检查接口地址后重试。': 'The model list could not be read. Check the endpoint and try again.',
  '已取消获取模型。': 'Model fetch cancelled.',
  '请先填写有效的 API 密钥。': 'Enter a valid API key first.',
  '获取模型超时，请重试。': 'Fetching models timed out. Try again.',
  '密钥无效或没有模型访问权限，请检查后重试。': 'The API key is invalid or lacks model access. Check it and try again.',
  '请求过于频繁或额度不足，请稍后重试。': 'Too many requests or insufficient quota. Try again later.',
  '无法获取模型列表，请检查服务是否支持模型列表接口。': 'Could not fetch models. Check whether the service supports the model list endpoint.',
  '服务未返回可用模型，请检查密钥权限后重试。': 'No available models were returned. Check API key permissions and try again.',
  '无法连接 AI 服务，请检查网络和接口地址后重试。': 'Could not connect to the AI service. Check your network and endpoint, then try again.',
  '请输入有效的 HTTPS 接口地址，不包含账号、查询参数或片段。': 'Enter a valid HTTPS endpoint without credentials, query parameters or fragments.',
  '服务返回了无法识别的流式回复，请检查接口和模型配置。': 'The streamed reply could not be read. Check the endpoint and model settings.',
  '请先在设置中填写有效的模型名称和 API 密钥。': 'Enter a valid model name and API key in Settings first.',
  '密钥无效或没有模型访问权限，请检查 AI 设置。': 'The API key is invalid or lacks model access. Check AI settings.',
  '请求过于频繁或额度不足，请稍后重试并检查服务商额度。': 'Too many requests or insufficient quota. Check your provider quota and try again later.',
  'AI 服务暂时无法完成请求，请检查接口和模型配置后重试。': 'The AI service could not complete the request. Check the endpoint and model settings, then try again.',
  '模型没有返回文字，请检查模型是否支持对话。': 'The model returned no text. Check whether it supports chat.',
  '回复已达到长度上限，内容尚未完整，已收到的文字已保留。': 'The reply reached its length limit and is incomplete. Received text has been kept.',
  '服务商中止了这次回复，内容可能不完整，请调整问题后重试。': 'The provider stopped this reply; it may be incomplete. Adjust your prompt and try again.',
  '模型请求了当前对话不支持的能力，回复尚未完成，请检查模型配置。': 'The model requested an unsupported capability. The reply is incomplete; check the model settings.',
  '回复连接提前中断，已收到的文字已保留，请重试。': 'The reply connection ended early. Received text has been kept. Try again.',
  'AI 回复超时，请稍后重试。': 'The AI reply timed out. Try again later.',
  '当前对话过长，请新建对话后继续。': 'This conversation is too long. Start a new chat to continue.',
  '应用已进入后台或 AI 配置已变更，回复已停止。': 'The reply stopped because the app entered the background or AI settings changed.',
  '回复中断，请检查 AI 设置后重试。': 'The reply was interrupted. Check AI settings and try again.'
};
export function localizedError(locale: Locale, raw: unknown, fallback?: string): string {
  const message = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : raw && typeof raw === 'object' && 'message' in raw && typeof raw.message === 'string' ? raw.message : '';
  if (Object.hasOwn(errorMessages, message)) return locale === 'en' ? errorMessages[message]! : message;
  return fallback ?? (locale === 'en' ? 'Something went wrong. Try again.' : '操作失败，请重试。');
}
