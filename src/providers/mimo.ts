import { getEnv, getEnvNumber } from '../config';
import {
  ApiError,
  apiErrorFromNetwork,
  apiErrorFromResponse,
  truncateBody,
} from '../errors';
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
    const voice = opts.voice ?? getEnv('MIMO_VOICE') ?? '茉莉';
    const timeoutMs = getEnvNumber('MIMO_TIMEOUT_MS', 120_000);

    // 请求侧上下文：日志里能分清「整个接口挂了」还是「这一段文本有问题」。
    // 只记长度不记正文——正文是小说内容，按项目约定不进日志；
    // 只有请求本身有问题（4xx）时才在下面附一小段文本，便于定位是哪段触发的。
    const requestInfo: Record<string, string | number> = {
      model: MODEL,
      voice,
      format: 'mp3',
      textLen: opts.text.length,
      styleLen: style.length,
      styleSource: opts.style?.trim() ? '自定义' : '默认',
      timeoutMs,
    };

    const startedAt = Date.now();
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
          voice,
          // TODO: 语速参数待确认 mimo 接口字段名后启用
          // speed: opts.speed,
        },
      }),
    }, { request: requestInfo, startedAt });
    const elapsedMs = Date.now() - startedAt;

    // 状态码分类交给 errors.ts：429/5xx 可重试，400/401 等重试无意义；
    // 响应体原文、网关响应头都会带进 detail，日志里完整展开
    if (!res.ok) {
      const apiErr = await apiErrorFromResponse('MiMo TTS 失败', res, { request: requestInfo, elapsedMs });
      if (apiErr.status === 500) {
        // 官方文档明确提到：请求体缺 audio 参数时也会返回 500，先给个排查方向
        apiErr.detail.hint = `${apiErr.detail.hint ?? ''}（另：该接口缺 audio 参数同样会返回 500，若刚调整过请求体可先核对）`;
      }
      if (!apiErr.retryable) {
        // 4xx 多半是这段文本本身的问题（风控/格式），这时才把片段带上
        apiErr.detail.request = { ...requestInfo, textPreview: previewOf(opts.text) };
      }
      throw apiErr;
    }

    // 用 text() 再自己解析：接口返回非 JSON / 没有音频时，原始响应也能留进日志
    let raw: string;
    try {
      raw = await res.text();
    } catch (err) {
      throw apiErrorFromNetwork('MiMo TTS 读取响应失败', err, { request: requestInfo, elapsedMs });
    }

    let data: { choices?: Array<{ message?: { audio?: { data?: string } } }> };
    try {
      data = JSON.parse(raw) as typeof data;
    } catch (err) {
      throw new ApiError('MiMo TTS 响应不是合法 JSON', {
        retryable: true,
        cause: err,
        detail: {
          status: res.status,
          body: truncateBody(raw),
          request: requestInfo,
          elapsedMs,
          hint: '接口返回 200 但内容不是 JSON，通常是网关报错页或响应被截断；已按待重试处理',
        },
      });
    }

    const b64 = data?.choices?.[0]?.message?.audio?.data;
    // 接口偶发返回 200 但不带音频（限流/排队被吞），属于可重试情况
    if (!b64) {
      throw new ApiError('MiMo TTS 响应中没有音频数据', {
        retryable: true,
        detail: {
          status: res.status,
          body: truncateBody(raw),
          request: requestInfo,
          elapsedMs,
          hint: '返回 200 但 choices[0].message.audio.data 为空，通常是请求被丢弃或该模型不输出音频；已按待重试处理',
        },
      });
    }
    return Buffer.from(b64, 'base64');
  }
}

/** 文本片段预览：去换行后截一小段，只用于 4xx 这类「请求本身有问题」的定位 */
function previewOf(text: string, max = 20): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * 带超时的请求：接口偶发挂死时不能把整个队列卡住，
 * 超时与网络层失败一并归为 API 侧可重试故障，并带上耗时便于判断是「秒挂」还是「拖到超时」。
 */
async function request(
  url: string,
  init: RequestInit,
  ctx: { request: Record<string, string | number>; startedAt: number },
): Promise<Response> {
  const timeoutMs = Number(ctx.request.timeoutMs ?? 120_000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    throw apiErrorFromNetwork('MiMo TTS 请求失败', err, {
      request: ctx.request,
      elapsedMs: Date.now() - ctx.startedAt,
    });
  } finally {
    clearTimeout(timer);
  }
}