/** provider 注册表：新增 TTS 引擎时在这里注册即可，实现见 providers/types.ts 接口 */
import { getEnv } from '../config';
import { MimoProvider } from './mimo';
import type { TTSProvider } from './types';

const registry = new Map<string, TTSProvider>();

export function registerProvider(provider: TTSProvider): void {
  registry.set(provider.id, provider);
}

/** 获取当前使用的 provider（按 id 或 .env 的 TTS_PROVIDER，默认 mimo） */
export function getProvider(id?: string): TTSProvider {
  const pid = id ?? getEnv('TTS_PROVIDER') ?? 'mimo';
  const provider = registry.get(pid);
  if (!provider) throw new Error(`未知的 TTS provider：${pid}`);
  return provider;
}

export function listProviders(): TTSProvider[] {
  return [...registry.values()];
}

registerProvider(new MimoProvider());