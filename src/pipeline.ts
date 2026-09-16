/** 转换管线：文本 → 清洗拆句 → 逐段合成 → 合并 mp3 */
import { cleanMarkdown, splitIntoSegments } from './text';
import { mergeSegments } from './audio';
import { annotateNovel, isLlmConfigured, type AnnotatedSegment } from './llm';
import { getEnvNumber } from './config';
import { withRetry } from './retry';
import type { TTSProvider } from './providers/types';

/** 段级重试信息：第 index 段（从 1 起）将在 delayMs 后做第 attempt 次尝试 */
export interface SegmentRetryInfo {
  index: number;
  total: number;
  attempt: number;
  delayMs: number;
  /** 失败原因一句话摘要（用于状态行与单行日志） */
  message: string;
  /** 原始错误对象：日志据此展开完整诊断（响应体、响应头、请求参数） */
  err: unknown;
}

/** 某一段用尽重试后彻底失败：整章会被抛给队列重排队，这里说明卡在哪、前面成了多少 */
export interface SegmentFailInfo {
  /** 失败段序号（从 1 起） */
  index: number;
  total: number;
  /** 该段之前已合成成功的段数 */
  done: number;
  err: unknown;
}

export interface PipelineOptions {
  voice?: string;
  speed?: number;
  /** 全局语气指令（手动兜底；自动语气模式下仅对无指令的段生效） */
  style?: string;
  gapMs?: number;
  /** 开启后且 LLM 已配置时，先用 LLM 自动拆解并逐段生成语气指令 */
  autoStyle?: boolean;
  /** 每合成一段回调一次 */
  onProgress?: (done: number, total: number) => void;
  /** 阶段性状态回调（如 LLM 拆解中），用于进度展示 */
  onStatus?: (msg: string) => void;
  /** 单段合成失败、就地重试前的回调（段级重试在管线内消化，不会牵连整章） */
  onSegmentRetry?: (info: SegmentRetryInfo) => void;
  /** 单段重试用尽、整章即将失败的回调；日志靠它说明卡在第几段 */
  onSegmentFail?: (info: SegmentFailInfo) => void;
}

export async function textToAudio(
  provider: TTSProvider,
  text: string,
  opts: PipelineOptions = {},
): Promise<Buffer> {
  const clean = cleanMarkdown(text);

  // 自动语气：LLM 已配置且开关开启时，逐段生成语气指令；否则纯规则拆句
  let segments: AnnotatedSegment[];
  if (opts.autoStyle && isLlmConfigured()) {
    opts.onStatus?.('LLM 拆解文本并生成语气指令中…');
    segments = await annotateNovel(clean, (done, total) => {
      if (total > 1) opts.onStatus?.(`LLM 拆解中 ${done}/${total} 块`);
    });
  } else {
    segments = splitIntoSegments(clean).map((t) => ({ text: t }));
  }
  if (segments.length === 0) throw new Error('没有可合成的文本');

  // 串行合成：更稳，避免免费接口限流；
  // 单段失败先就地退避重试，段级重试失败才把整章抛给队列重排队
  const retryOpts = segmentRetryOptions();
  const audios: Buffer[] = [];
  for (let i = 0; i < segments.length; i++) {
    let buf: Buffer;
    try {
      buf = await withRetry(
        () => provider.synthesize({
          text: segments[i].text,
          voice: opts.voice,
          speed: opts.speed,
          // 段级语气指令优先，全局 style 兜底
          style: segments[i].instruct ?? opts.style,
        }),
        {
          ...retryOpts,
          onRetry: (err, attempt, delayMs) => {
            opts.onSegmentRetry?.({
              index: i + 1,
              total: segments.length,
              attempt,
              delayMs,
              message: err.message,
              err,
            });
          },
        },
      );
    } catch (err) {
      // 段级重试用尽：把失败位置一并报上去，日志里能看出「前 i 段已成功、卡在第 i+1 段」
      opts.onSegmentFail?.({ index: i + 1, total: segments.length, done: i, err });
      throw err;
    }
    audios.push(buf);
    opts.onProgress?.(i + 1, segments.length);
  }

  return mergeSegments(audios, { gapMs: opts.gapMs });
}

/** 段级重试策略：偶发限流/超时/空响应就地重试，参数见 .env.example */
function segmentRetryOptions() {
  return {
    attempts: getEnvNumber('TTS_SEG_ATTEMPTS', 3),
    baseDelayMs: getEnvNumber('TTS_SEG_RETRY_BASE_MS', 1500),
    maxDelayMs: getEnvNumber('TTS_SEG_RETRY_MAX_MS', 15000),
  };
}
