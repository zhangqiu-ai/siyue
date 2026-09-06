import type { ChatModelAdapter } from '@assistant-ui/react-native';

// A local async source: no provider, network request, tool execution or business write.
export async function* streamMockReply(input: string, signal: AbortSignal) {
  const topic = input.trim().slice(0, 80);
  const reply = `我们可以从一个小步骤开始。\n\n你提到了「${topic}」。先想一想：做完哪一件小事，会让你觉得今天向前走了一点？\n\n可以这样整理：\n1. 写下你希望发生的变化。\n2. 选一个今天能完成的小行动。\n3. 留一点时间，看看什么适合自己。\n\n这是本地演示回复。你可以到「行动」页创建并确认计划；这段对话不会自动保存目标或任务。`;
  let text = '';
  for (let index = 0; index < reply.length; index += 3) {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, 90);
      signal.addEventListener('abort', done, { once: true });
    });
    if (signal.aborted) return;
    text += reply.slice(index, index + 3);
    yield { content: [{ type: 'text' as const, text }] };
  }
}

export const mockChatAdapter: ChatModelAdapter = {
  async *run({ messages, abortSignal }) {
    const message = [...messages].reverse().find((item) => item.role === 'user');
    const input = message?.content.filter((part) => part.type === 'text').map((part) => part.text).join('') ?? '';
    yield* streamMockReply(input, abortSignal);
  },
};
