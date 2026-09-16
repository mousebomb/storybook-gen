import { getEnv, getEnvNumber } from '../config';
import { ApiError, apiErrorFromNetwork, apiErrorFromResponse } from '../errors';
import type { TTSProvider, VoiceOption, SynthesizeOptions } from './types';

const BASE_URL = 'https://api.xiaomimimo.com/v1/chat/completions';
const MODEL = 'mimo-v2.5-tts';

// mimo-v2.5-tts 精品音色库（platform.xiaomimimo.com 官方）
const VOICES: VoiceOption[] = [
  { id: '茉莉', label: '茉莉 · 温婉女声' },
  { id: '冰糖', label: '冰糖 · 清亮女声' },
  { id: '苏打', label: '苏打 · 清爽女声' },
  { id: '白桦', label: '白桦 · 沉稳' },
  { id: 'Mia', label: 'Mia · 英文女声' },
  { id: 'Chloe', label: 'Chloe · 英文女声' },
  { id: 'Milo', label: 'Milo · 英文男声' },
  { id: 'Dean', label: 'Dean · 英文男声' },
];

/** 默认朗读风格：温暖自然、节奏舒缓、注意对话语气 */
const DEFAULT_STYLE =
  '用一种温暖、自然、有感情的中文小说朗读语气讲述，节奏舒缓，注意人物对话的语气变化。';

export class MimoProvider implements TTSProvider {
  id = 'mimo';
  name = '小米 MiMo TTS';
  description = '小米 mimo-v2.5-tts，OpenAI 兼容接口，限时免费';

  isConfigured(): boolean {
    return !!getEnv('MIMO_API_KEY');
  }

  async listVoices(): Promise<VoiceOption[]> {
    return VOICES;
  }

  async synthesize(opts: SynthesizeOptions): Promise<Buffer> {
    const apiKey = getEnv('MIMO_API_KEY');
    if (!apiKey) throw new Error('未配置 MIMO_API_KEY，请先在 WebUI 设置中填写 API Key');

    const style = opts.style?.trim() || DEFAULT_STYLE;
    const res = await request(BASE_URL, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          // user 消息为风格指令（不会出现在语音里）
          { role: 'user', content: style },
          // 待合成文本必须放 assistant 消息
          { role: 'assistant', content: opts.text },
        ],
        audio: {
          format: 'mp3',
          voice: opts.voice ?? getEnv('MIMO_VOICE') ?? '茉莉',
          // TODO: 语速参数待确认 mimo 接口字段名后启用
          // speed: opts.speed,
        },
      }),
    });

    // 状态码分类交给 errors.ts：429/5xx 可重试，400/401 等重试无意义
    if (!res.ok) throw await apiErrorFromResponse('MiMo TTS 失败', res);

    let data: { choices?: Array<{ message?: { audio?: { data?: string } } }> };
    try {
      data = await res.json() as typeof data;
    } catch (err) {
      throw new ApiError('MiMo TTS 响应不是合法 JSON', { retryable: true, cause: err });
    }
    const b64 = data?.choices?.[0]?.message?.audio?.data;
    // 接口偶发返回 200 但不带音频（限流/排队被吞），属于可重试情况
    if (!b64) throw new ApiError('MiMo TTS 响应中没有音频数据', { retryable: true });
    return Buffer.from(b64, 'base64');
  }
}

/**
 * 带超时的请求：接口偶发挂死时不能把整个队列卡住，
 * 超时与网络层失败一并归为 API 侧可重试故障。
 */
async function request(url: string, init: RequestInit): Promise<Response> {
  const timeoutMs = getEnvNumber('MIMO_TIMEOUT_MS', 120_000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    throw apiErrorFromNetwork('MiMo TTS 请求失败', err);
  } finally {
    clearTimeout(timer);
  }
}