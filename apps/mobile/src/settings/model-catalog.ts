import { normalizeBaseUrl } from '../chat/compatible-transport.ts';

export class ModelCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelCatalogError';
  }
}

const malformed = () => new ModelCatalogError('服务返回的模型列表无法识别，请检查接口地址后重试。');
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Explicit discovery only: no chat text, retries, fallback destinations, or persistence. */
export async function fetchCompatibleModels(
  input: { baseUrl: string; apiKey: string },
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  if (signal.aborted) throw new ModelCatalogError('已取消获取模型。');
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const apiKey = input.apiKey.trim();
  if (baseUrl.length > 1000) throw new ModelCatalogError('接口地址过长，请检查。');
  if (!apiKey || apiKey.length > 512 || !/^[\x21-\x7e]+$/.test(apiKey)) {
    throw new ModelCatalogError('请先填写有效的 API 密钥。');
  }
  const controller = new AbortController();
  let timedOut = false;
  let rejectAbort: (reason: Error) => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => {
    controller.abort();
    rejectAbort(new ModelCatalogError(timedOut ? '获取模型超时，请重试。' : '已取消获取模型。'));
  };
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort(); }, 15_000);
  try {
    const request = async (): Promise<string[]> => {
      const response = await fetchImpl(`${baseUrl}/models`, {
        method: 'GET',
        redirect: 'error',
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw new ModelCatalogError('已取消获取模型。');
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 401 || response.status === 403) throw new ModelCatalogError('密钥无效或没有模型访问权限，请检查后重试。');
        if (response.status === 429) throw new ModelCatalogError('请求过于频繁或额度不足，请稍后重试。');
        throw new ModelCatalogError('无法获取模型列表，请检查服务是否支持模型列表接口。');
      }
      const packet: unknown = await response.json();
      if (!isRecord(packet) || packet.error || !Array.isArray(packet.data) || packet.data.length > 10_000) throw malformed();
      const models: string[] = [];
      for (const item of packet.data) {
        if (!isRecord(item) || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 200 || /[\x00-\x1f\x7f]/.test(item.id)) throw malformed();
        models.push(item.id.trim());
      }
      if (!models.length) throw new ModelCatalogError('服务未返回可用模型，请检查密钥权限后重试。');
      return [...new Set(models)];
    };
    return await Promise.race([request(), cancelled]);
  } catch (error) {
    if (signal.aborted) throw new ModelCatalogError('已取消获取模型。');
    if (timedOut) throw new ModelCatalogError('获取模型超时，请重试。');
    if (error instanceof ModelCatalogError) throw error;
    if (error instanceof SyntaxError) throw malformed();
    throw new ModelCatalogError('无法连接 AI 服务，请检查网络和接口地址后重试。');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    controller.abort();
  }
}
