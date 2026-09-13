export type AIProviderStatusTone = 'info' | 'success' | 'error';

const successNotices = new Set(['ai.saved', 'ai.removed', 'ai.connected']);
const infoNotices = new Set(['ai.testing', 'ai.cancelledTest', 'ai.cancelledModels']);

export function aiProviderStatusTone(notice: string): AIProviderStatusTone {
  if (successNotices.has(notice)) return 'success';
  if (infoNotices.has(notice)) return 'info';
  return 'error';
}
