import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface MergeOptions {
  /** 段落之间的静音间隔（毫秒） */
  gapMs?: number;
  /** 输出码率 */
  bitrate?: string;
}

/**
 * 用 ffmpeg 将多段 mp3 合并为单个 mp3，段落间插入静音。
 * 统一重采样为 24kHz 单声道，避免各段采样率不一致导致拼接爆音。
 */
export async function mergeSegments(segments: Buffer[], opts: MergeOptions = {}): Promise<Buffer> {
  const gapMs = opts.gapMs ?? 250;
  const bitrate = opts.bitrate ?? '64k';
  if (segments.length === 0) throw new Error('没有可合并的音频片段');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storybook-'));
  try {
    const files = segments.map((buf, i) => {
      const p = path.join(dir, `seg${String(i).padStart(4, '0')}.mp3`);
      fs.writeFileSync(p, buf);
      return p;
    });

    // filter 脚本：每段末尾 pad 静音，再逐段 concat
    const inputs = files.map((_, i) => `[${i}:a]apad=pad_dur=${gapMs / 1000}[a${i}]`);
    const refs = files.map((_, i) => `[a${i}]`).join('');
    const concat = `${refs}concat=n=${files.length}:v=0:a=1[aout]`;
    const filter = `${inputs.join(';')};${concat}`;

    const args = ['-y'];
    files.forEach((f) => args.push('-i', f));
    args.push(
      '-filter_complex', filter,
      '-map', '[aout]',
      '-ar', '24000', '-ac', '1',
      '-c:a', 'libmp3lame', '-b:a', bitrate,
      path.join(dir, 'out.mp3'),
    );

    await runFfmpeg(args);
    return fs.readFileSync(path.join(dir, 'out.mp3'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args);
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 失败（退出码 ${code}）：${err.slice(-500)}`));
    });
  });
}