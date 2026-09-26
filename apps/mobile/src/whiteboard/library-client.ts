import type { BoardStart, BoardSummary, Transport } from '@siyue/whiteboard';

export function boardLibraryClient(session: string, request: Transport, newId: () => string) {
  async function call<T>(op: 'list' | 'create' | 'rename' | 'delete', payload: unknown): Promise<T> {
    const requestId = newId();
    const reply = JSON.parse(await request(JSON.stringify({ version: 1, session, requestId, op, payload })));
    if (reply.version !== 1 || reply.requestId !== requestId || !reply.ok) throw new Error(reply.error ?? 'bridge_error');
    return reply.value as T;
  }
  return {
    list: async (defaultTitle: string) => (await call<{ boards: BoardSummary[] }>('list', { defaultTitle })).boards,
    create: async (title: string, start: BoardStart) => (await call<{ summary: BoardSummary }>('create', { title, start })).summary,
    rename: async (boardId: string, title: string) => (await call<{ summary: BoardSummary }>('rename', { boardId, title })).summary,
    delete: async (boardId: string) => { await call('delete', { boardId }); },
  };
}

export function boardAge(updatedAt: string, now: number, locale: 'zh-CN' | 'en-US') {
  const age = Math.max(0, now - Date.parse(updatedAt));
  if (!Number.isFinite(age)) return '';
  if (age < 60_000) return locale === 'zh-CN' ? '刚刚' : 'just now';
  if (age < 3_600_000) { const n = Math.floor(age / 60_000); return locale === 'zh-CN' ? `${n} 分钟前` : `${n} min ago`; }
  if (age < 86_400_000) { const n = Math.floor(age / 3_600_000); return locale === 'zh-CN' ? `${n} 小时前` : `${n} hr ago`; }
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(updatedAt));
}
