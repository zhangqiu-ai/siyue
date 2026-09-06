export type ProviderPreset = {
  id: string;
  name: string;
  subtitle: string;
  baseUrl: string;
  model: string;
  helpUrl: string;
};

// Checked against each provider's official documentation on 2026-09-06.
// Presets do not imply that the user's account has enabled or funded a model.
export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    subtitle: 'DeepSeek 官方服务',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    helpUrl: 'https://api-docs.deepseek.com/',
  },
  {
    id: 'qwen',
    name: '通义千问',
    subtitle: '阿里云百炼 · 北京地域',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    helpUrl: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    subtitle: '智谱开放平台',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.7',
    helpUrl: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-4.7',
  },
  {
    id: 'kimi',
    name: 'Kimi',
    subtitle: '月之暗面 · 国内 API',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k3',
    helpUrl: 'https://platform.kimi.com/docs/api/chat',
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    subtitle: '多模型服务平台',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V4-Flash',
    helpUrl: 'https://docs.siliconflow.cn/docs/api/chat-completions-post',
  },
  {
    id: 'volcengine',
    name: '火山方舟',
    subtitle: '北京地域 · 填写已开通模型或接入点',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: '',
    helpUrl: 'https://www.volcengine.com/docs/82379/1494384',
  },
  {
    id: 'custom',
    name: '自定义服务',
    subtitle: '其他 OpenAI 兼容接口',
    baseUrl: '',
    model: '',
    helpUrl: '',
  },
];

export function findProvider(baseUrl: string): ProviderPreset | undefined {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) return undefined;
  return PROVIDERS.find((provider) => provider.baseUrl === normalized);
}
