export type CompatibleConfig = { baseUrl: string; model: string; apiKey: string };
export type CompatibleMessage = { role: 'user' | 'assistant' | 'system'; content: string };

/** Only fixed, client-owned messages may be displayed; provider bodies are untrusted. */
export class CompatibleChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompatibleChatError';
  }
}

export function normalizeBaseUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || /[?#]/.test(value)) {
      throw new Error();
    }
    return url.href.replace(/\/+$/, '');
  } catch {
    throw new CompatibleChatError('请输入有效的 HTTPS 接口地址，不包含账号、查询参数或片段。');
  }
}

const malformed = () => new CompatibleChatError('服务返回了无法识别的流式回复，请检查接口和模型配置。');
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readDelta(data: string): { content: string; finishReason?: unknown; hasToolCall?: boolean } {
  let packet: unknown;
  try { packet = JSON.parse(data); } catch { throw malformed(); }
  if (!isRecord(packet) || packet.error || !Array.isArray(packet.choices)) throw malformed();
  // Some providers send a final usage-only event with no choices.
  if (packet.choices.length === 0) return { content: '' };
  const choice = packet.choices.find((item: unknown) => isRecord(item) && (item.index === 0 || item.index === undefined));
  if (!isRecord(choice) || !isRecord(choice.delta)) throw malformed();
  const content = choice.delta.content;
  if (content !== undefined && content !== null && typeof content !== 'string') throw malformed();
  return {
    content: typeof content === 'string' ? content : '',
    finishReason: choice.finish_reason,
    hasToolCall: choice.delta.tool_calls !== undefined || choice.delta.function_call !== undefined,
  };
}

/** Sends only supplied messages. No retries, tools, fallback provider, or formal writes. */
export async function* streamCompatibleReply(
  config: CompatibleConfig,
  messages: readonly CompatibleMessage[],
  signal: AbortSignal,
  fetcher: typeof fetch,
): AsyncGenerator<string> {
  if (signal.aborted) return;
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!config.model.trim() || config.model.length > 200 || !config.apiKey.trim() || /[\r\n]/.test(config.apiKey)) {
    throw new CompatibleChatError('请先在设置中填写有效的模型名称和 API 密钥。');
  }
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timedOut = false;
  const abort = () => {
    controller.abort();
    void reader?.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort(); }, 90_000);
  try {
    const response = await fetcher(`${baseUrl}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${config.apiKey.trim()}` },
      body: JSON.stringify({ model: config.model.trim(), messages, stream: true, max_tokens: 2048 }),
      signal: controller.signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) throw new CompatibleChatError('密钥无效或没有模型访问权限，请检查 AI 设置。');
      if (response.status === 429) throw new CompatibleChatError('请求过于频繁或额度不足，请稍后重试并检查服务商额度。');
      throw new CompatibleChatError('AI 服务暂时无法完成请求，请检查接口和模型配置后重试。');
    }
    if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      void response.body?.cancel().catch(() => {});
      throw malformed();
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    let text = '';
    while (!controller.signal.aborted) {
      const chunk = await reader.read();
      if (controller.signal.aborted) break;
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 131_072) throw malformed();
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        if (data.trim() === '[DONE]') {
          if (!text) throw new CompatibleChatError('模型没有返回文字，请检查模型是否支持对话。');
          return;
        }
        const delta = readDelta(data);
        if (delta.content) {
          text += delta.content;
          if (text.length > 524_288) throw malformed();
          yield text;
          if (controller.signal.aborted) break;
        }
        if (delta.finishReason === 'length') {
          throw new CompatibleChatError('回复已达到长度上限，内容尚未完整，已收到的文字已保留。');
        }
        if (delta.finishReason === 'content_filter') {
          throw new CompatibleChatError('服务商中止了这次回复，内容可能不完整，请调整问题后重试。');
        }
        if (delta.hasToolCall || (delta.finishReason !== undefined && delta.finishReason !== null && delta.finishReason !== 'stop')) {
          throw new CompatibleChatError('模型请求了当前对话不支持的能力，回复尚未完成，请检查模型配置。');
        }
      }
      if (chunk.done) throw new CompatibleChatError('回复连接提前中断，已收到的文字已保留，请重试。');
    }
    if (timedOut) throw new CompatibleChatError('AI 回复超时，请稍后重试。');
  } catch (error) {
    if (signal.aborted) return;
    if (timedOut) throw new CompatibleChatError('AI 回复超时，请稍后重试。');
    if (error instanceof CompatibleChatError) throw error;
    throw new CompatibleChatError('无法连接 AI 服务，请检查网络和接口地址后重试。');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    controller.abort();
    if (reader) {
      try { await reader.cancel(); } catch { /* Never expose transport errors or secrets. */ }
      reader.releaseLock();
    }
  }
}
