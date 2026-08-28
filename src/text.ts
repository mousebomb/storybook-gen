/**
 * 文本预处理：清洗 markdown 标记 + 按段落/句子拆分为适合逐段合成的片段。
 * 注意保留对话引号（“”），便于 TTS 自动识别语气。
 */

/** 去除 markdown 标记，只保留可朗读的正文文字 */
export function cleanMarkdown(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, '')            // 代码块
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')       // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')    // 链接只留文字
    .replace(/^\s*#{1,6}\s*/gm, '')             // 标题标记（保留标题文字用于播报）
    .replace(/[*_>~`]/g, '')                    // 粗体/斜体/引用等符号
    .replace(/^\s*[-+]\s+/gm, '')               // 列表符号
    .replace(/\n{3,}/g, '\n\n')                 // 压缩多余空行
    .trim();
}

/**
 * 将正文拆分为 <= maxLen 字的片段：
 * 先按自然段切分，超长段落再按句子标点（。！？；……）切分。
 */
export function splitIntoSegments(text: string, maxLen = 300): string[] {
  const paragraphs = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const segments: string[] = [];

  for (const para of paragraphs) {
    if (para.length <= maxLen) {
      segments.push(para);
      continue;
    }
    // 超长段落：按句子标点累积切分（lookbehind 保留标点）
    const parts = para.split(/(?<=[。！？；!?…])/);
    let buf = '';
    for (const part of parts) {
      if (!part) continue;
      if (buf && buf.length + part.length > maxLen) {
        segments.push(buf);
        buf = part;
      } else {
        buf += part;
      }
    }
    if (buf) segments.push(buf);
  }

  return segments;
}