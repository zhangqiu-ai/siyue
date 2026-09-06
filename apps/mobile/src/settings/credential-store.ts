import { normalizeBaseUrl, type CompatibleConfig } from '../chat/compatible-transport.ts';

export class SettingsError extends Error {}
export type SecretStorage = {
  read: () => Promise<string | null>;
  write: (value: string) => Promise<void>;
  remove: () => Promise<void>;
};

function validate(input: CompatibleConfig): CompatibleConfig {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const model = input.model.trim();
  const apiKey = input.apiKey.trim();
  if (!model || model.length > 200 || /[\x00-\x1f]/.test(model)) throw new SettingsError('请填写有效的模型名称。');
  if (!apiKey || apiKey.length > 512 || !/^[\x21-\x7e]+$/.test(apiKey)) throw new SettingsError('请填写有效的 API 密钥。');
  if (baseUrl.length > 1000) throw new SettingsError('接口地址过长，请检查。');
  return { baseUrl, model, apiKey };
}

/** One secure record binds the key to its destination; there is no plaintext fallback. */
export function createCredentialStore(storage: SecretStorage) {
  let writing = false;
  async function load(): Promise<CompatibleConfig | null> {
    let raw: string | null;
    try { raw = await storage.read(); } catch { throw new SettingsError('无法读取手机安全存储，请解锁设备后重试。'); }
    if (raw === null) return null;
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1 ||
        !('baseUrl' in value) || typeof value.baseUrl !== 'string' ||
        !('model' in value) || typeof value.model !== 'string' ||
        !('apiKey' in value) || typeof value.apiKey !== 'string') throw new Error();
      return validate({ baseUrl: value.baseUrl, model: value.model, apiKey: value.apiKey });
    } catch { throw new SettingsError('保存的 AI 配置无法读取，请移除本机配置后重新设置。'); }
  }
  return {
    load,
    async save(input: CompatibleConfig) {
      if (writing) throw new SettingsError('配置正在保存，请稍后重试。');
      writing = true;
      try {
        let apiKey = input.apiKey.trim();
        if (!apiKey) {
          const existing = await load();
          if (!existing || normalizeBaseUrl(input.baseUrl) !== existing.baseUrl) {
            throw new SettingsError('首次配置或修改服务地址时，请重新输入该服务的密钥。');
          }
          apiKey = existing.apiKey;
        }
        const config = validate({ ...input, apiKey });
        try { await storage.write(JSON.stringify({ schemaVersion: 1, ...config })); }
        catch { throw new SettingsError('AI 配置未保存：手机安全存储不可用，请稍后重试。'); }
        return config;
      } finally { writing = false; }
    },
    async remove() {
      if (writing) throw new SettingsError('配置正在保存，请稍后重试。');
      writing = true;
      try {
        await storage.remove();
      } catch { throw new SettingsError('无法移除本机密钥，请稍后重试。'); }
      finally { writing = false; }
    },
  };
}
