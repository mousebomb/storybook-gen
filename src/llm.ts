/**
 * LLM 客户端（OpenAI 兼容）：自动拆解小说文本，逐段生成语气指令。
 * 输出格式沿用旧项目约定：每行 `语气指令 <|endofprompt|> 待合成文本`。
 */
import { getEnv } from './config';
import { splitIntoSegments } from './text';

/** 每个分段交给 TTS 的最大长度（与 splitIntoSegments 默认值一致） */
const SEGMENT_MAX = 300;
/** 每次调用 LLM 的文本块大小（字符） */
const CHUNK_SIZE = 4000;
/** 分隔符：语气指令与待合成文本的分界 */
const SEP = '<|endofprompt|>';

/** LLM 三项配置（key/baseUrl/model）齐备才可用 */
export function isLlmConfigured(): boolean {
  return !!(getEnv('LLM_API_KEY') && getEnv('LLM_BASE_URL') && getEnv('LLM_MODEL'));
}

/** 带 inbuild 语气指令的分段 */
export interface AnnotatedSegment {
  text: string;
  /** 语气指令（自然语言），为空则走全局兜底 style */
  instruct?: string;
}

/**
 * 对整篇文本做 LLM 自动拆解：按段落边界分块，逐块调用 LLM，
 * 返回逐段 {原文, 语气指令} 列表。某块解析覆盖率过低时，
 * 该块回退为纯规则拆句（无语气指令），保证不丢字。
 */
export async function annotateNovel(
  text: string,
  onChunk?: (done: number, total: number) => void,
): Promise<AnnotatedSegment[]> {
  const chunks = chunkByParagraph(text, CHUNK_SIZE);
  const result: AnnotatedSegment[] = [];

  for (let i = 0; i < chunks.length; i++) {
    onChunk?.(i, chunks.length);
    let annotated: AnnotatedSegment[];
    try {
      annotated = parseAnnotation(await chatCompletion(buildPrompt(chunks[i])));
    } catch {
      // 单块 LLM 调用失败：该块降级为规则拆句，不中断整体转换
      annotated = [];
    }
    // 覆盖率校验：LLM 丢字超过 10% 时整块回退，宁可没语气也不丢原文
    const covered = annotated.reduce((n, s) => n + s.text.length, 0);
    if (annotated.length === 0 || covered < chunks[i].replace(/\s/g, '').length * 0.9) {
      result.push(...splitIntoSegments(chunks[i]).map((t) => ({ text: t })));
    } else {
      // 超长分段再按句子切细，沿用同一条语气指令
      for (const seg of annotated) {
        if (seg.text.length > SEGMENT_MAX) {
          result.push(...splitIntoSegments(seg.text).map((t) => ({ text: t, instruct: seg.instruct })));
        } else {
          result.push(seg);
        }
      }
    }
    onChunk?.(i + 1, chunks.length);
  }
  return result;
}

/** 按段落边界累积分块，块内保留原始换行 */
function chunkByParagraph(text: string, maxLen: number): string[] {
  const paragraphs = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buf = '';
  for (const p of paragraphs) {
    if (buf && buf.length + p.length + 1 > maxLen) {
      chunks.push(buf);
      buf = p;
    } else {
      buf = buf ? buf + '\n' + p : p;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/** 构造拆解提示词：要求 100% 保留原文，每行输出 `指令 <|endofprompt|> 原文段` */
function buildPrompt(chunk: string): string {
  return [
    '你是 audiobook 朗读导演。把下面的小说文本拆分成适合逐段朗读的片段，并为每段写一条语气指令。',
    '要求：',
    `1. 每行输出格式：语气指令${SEP}该段原文。语气指令用中文，简洁描述情绪/语速/角色状态（如：紧张急促，语速稍快 / 温柔低语 / 沉稳旁白）。`,
    '2. 100% 保留原文：不得改写、增删任何字词和标点，只做拆分。',
    '3. 拆分粒度：按自然段或对话轮次拆，每段不超过 300 字。',
    '4. 只输出拆解结果，不要任何解释或多余内容。',
    '',
    '文本：',
    chunk,
  ].join('\n');
}

/** 调用 OpenAI 兼容 chat/completions，返回模型文本输出 */
async function chatCompletion(prompt: string): Promise<string> {
  const apiKey = getEnv('LLM_API_KEY')!;
  const baseUrl = getEnv('LLM_BASE_URL')!.replace(/\/+$/, '');
  const model = getEnv('LLM_MODEL')!;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const err = await res.json() as { error?: { message?: string } };
      if (err?.error?.message) msg = err.error.message;
    } catch { /* 忽略解析失败 */ }
    throw new Error(`LLM 调用失败：${msg}`);
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM 响应为空');
  return content;
}

/** 解析模型输出为分段列表；缺分隔符的行兜底为「无指令原文」 */
function parseAnnotation(content: string): AnnotatedSegment[] {
  const segs: AnnotatedSegment[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine
      .replace(/^\s*```.*$/gm, '')   // 去掉代码围栏行
      .trim();
    if (!line) continue;
    const idx = line.indexOf(SEP);
    if (idx === -1) {
      // 兜底：整行视为原文，无语气指令
      segs.push({ text: line });
    } else {
      const instruct = line.slice(0, idx).trim();
      const text = line.slice(idx + SEP.length).trim();
      if (text) segs.push({ text, instruct: instruct || undefined });
    }
  }
  return segs;
}
