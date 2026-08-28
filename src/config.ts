import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const ENV_PATH = path.join(process.cwd(), '.env');

/** 读取 .env 文件内容（不覆盖 process.env） */
export function loadEnv(): Record<string, string> {
  if (!fs.existsSync(ENV_PATH)) return {};
  return dotenv.parse(fs.readFileSync(ENV_PATH, 'utf-8'));
}

/** 读取配置项：优先 process.env，其次 .env 文件 */
export function getEnv(key: string): string | undefined {
  return process.env[key] ?? loadEnv()[key];
}

/**
 * 写回 .env：保留原有注释与无关键，仅更新指定键的值；
 * 不存在的键追加到文件末尾。API Key 存这里而非硬编码到源码。
 */
export function saveEnv(patch: Record<string, string>): void {
  const keys = Object.keys(patch);
  const replaced = new Set<string>();
  const out: string[] = [];

  if (fs.existsSync(ENV_PATH)) {
    const raw = fs.readFileSync(ENV_PATH, 'utf-8');
    const kvRe = /^\s*([A-Za-z0-9_]+)\s*=/;
    for (const line of raw.split('\n')) {
      const m = kvRe.exec(line);
      if (m && keys.includes(m[1])) {
        replaced.add(m[1]);
        out.push(`${m[1]}=${quoteValue(patch[m[1]])}`);
      } else {
        out.push(line);
      }
    }
  }

  for (const k of keys) {
    if (!replaced.has(k)) out.push(`${k}=${quoteValue(patch[k])}`);
  }

  fs.writeFileSync(ENV_PATH, out.join('\n').replace(/\n{2,}/g, '\n').trimEnd() + '\n');
}

/** 只包含安全字符的值不加引号，否则用双引号包裹并转义 */
function quoteValue(v: string): string {
  if (/^[A-Za-z0-9_\-:.]+$/.test(v)) return v;
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}