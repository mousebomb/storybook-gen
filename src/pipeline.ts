/** 转换管线：文本 → 清洗拆句 → 逐段合成 → 合并 mp3 */
import { cleanMarkdown, splitIntoSegments } from './text';
import { mergeSegments } from './audio';
import type { TTSProvider } from './providers/types';

export interface PipelineOptions {
  voice?: string;
  speed?: number;
  style?: string;
  gapMs?: number;
  /** 每合成一段回调一次 */
  onProgress?: (done: number, total: number) => void;
}

export async function textToAudio(
  provider: TTSProvider,
  text: string,
  opts: PipelineOptions = {},
): Promise<Buffer> {
  const segments = splitIntoSegments(cleanMarkdown(text));
  if (segments.length === 0) throw new Error('没有可合成的文本');

  // 串行合成：更稳，避免免费接口限流
  const audios: Buffer[] = [];
  for (let i = 0; i < segments.length; i++) {
    const buf = await provider.synthesize({
      text: segments[i],
      voice: opts.voice,
      speed: opts.speed,
      style: opts.style,
    });
    audios.push(buf);
    opts.onProgress?.(i + 1, segments.length);
  }

  return mergeSegments(audios, { gapMs: opts.gapMs });
}