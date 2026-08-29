/** storybook-gen 服务入口：Fastify + WebUI + 批量转换队列 API */
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProvider, listProviders } from './providers';
import { getEnv, saveEnv } from './config';
import { textToAudio } from './pipeline';
import { isLlmConfigured } from './llm';

const PORT = Number(getEnv('PORT') ?? '5666');
const PUBLIC_DIR = path.join(process.cwd(), 'public');
/** 产物目录 */
const OUTPUT_DIR = path.join(process.cwd(), 'output');
/** 上传文件暂存目录（挂在 output/ 下，天然被 .gitignore 覆盖） */
const STAGING_DIR = path.join(OUTPUT_DIR, '.tmp');

// bodyLimit 调大到 100MB：单本小说 txt 可能超过默认 20MB
const app = Fastify({ bodyLimit: 100 * 1024 * 1024 });
await app.register(multipart);

// 启动时清空暂存目录：队列仅存内存，重启后残留的上传文件已无对应任务
fs.rmSync(STAGING_DIR, { recursive: true, force: true });
fs.mkdirSync(STAGING_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

/** 批量转换任务（内存态队列）：按入队顺序串行执行，单个失败不中断后续 */
interface ConvertTask {
  id: string;
  /** 原始文件名（决定输出 mp3 命名 + 队列展示） */
  filename: string;
  /** 暂存文件路径，转换时读入内存后立即删除，避免上百文件占内存 */
  filePath: string;
  voice?: string;
  style?: string;
  autoStyle?: boolean;
  status: 'pending' | 'running' | 'done' | 'failed';
  error?: string;
}

const queue: ConvertTask[] = [];
/** worker 是否在跑（保证只有一个消费循环） */
let workerRunning = false;
// 当前任务的段级进度（内存态，供前端轮询）
const progress = { done: 0, total: 0, status: '空闲' };

// 状态查询：返回所有 provider、当前选中项、key 是否已配置、LLM 配置状态
app.get('/api/status', async () => ({
  providers: listProviders().map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    configured: p.isConfigured(),
  })),
  current: getEnv('TTS_PROVIDER') ?? 'mimo',
  defaultVoice: getEnv('MIMO_VOICE') ?? '茉莉',
  llm: {
    configured: isLlmConfigured(),
    // 脱敏展示：只回传 baseUrl 与 model，不回传 key
    baseUrl: getEnv('LLM_BASE_URL') ?? '',
    model: getEnv('LLM_MODEL') ?? '',
    autoStyleEnabled: getEnv('AUTO_STYLE_ENABLED') === 'true',
  },
}));

// 保存 API Key 到 .env（不硬编码到源码），同时刷新进程内变量
app.post('/api/config/apikey', async (req, reply) => {
  const body = req.body as { provider?: string; apiKey?: string } | null;
  const provider = body?.provider ?? 'mimo';
  const apiKey = body?.apiKey?.trim() ?? '';

  if (provider !== 'mimo') {
    return reply.code(400).send({ error: `暂不支持配置 provider：${provider}` });
  }
  saveEnv({ MIMO_API_KEY: apiKey, TTS_PROVIDER: 'mimo' });
  process.env.MIMO_API_KEY = apiKey;
  return { ok: true };
});

// 保存 LLM（OpenAI 兼容）配置：key 为空表示保留旧值，baseUrl/model 必填
app.post('/api/config/llm', async (req, reply) => {
  const body = req.body as { apiKey?: string; baseUrl?: string; model?: string } | null;
  const apiKey = body?.apiKey?.trim() ?? '';
  const baseUrl = body?.baseUrl?.trim() ?? '';
  const model = body?.model?.trim() ?? '';

  if (!baseUrl) return reply.code(400).send({ error: 'Base URL 不能为空' });
  if (!model) return reply.code(400).send({ error: 'Model 不能为空' });

  const patch: Record<string, string> = { LLM_BASE_URL: baseUrl, LLM_MODEL: model };
  if (apiKey) patch.LLM_API_KEY = apiKey; // key 留空则沿用 .env 里的旧值
  saveEnv(patch);
  if (apiKey) process.env.LLM_API_KEY = apiKey;
  process.env.LLM_BASE_URL = baseUrl;
  process.env.LLM_MODEL = model;
  return { ok: true };
});

// 切换自动语气开关（该功能依赖 LLM 已配置）
app.post('/api/config/autostyle', async (req, reply) => {
  const body = req.body as { enabled?: boolean } | null;
  const enabled = !!body?.enabled;
  if (enabled && !isLlmConfigured()) {
    return reply.code(400).send({ error: '请先配置 LLM（Base URL / API Key / Model）' });
  }
  saveEnv({ AUTO_STYLE_ENABLED: enabled ? 'true' : 'false' });
  process.env.AUTO_STYLE_ENABLED = enabled ? 'true' : 'false';
  return { ok: true, enabled };
});

// 进度与队列状态查询：前端轮询渲染（done/failed/pending 为任务级统计）
app.get('/api/progress', async () => {
  const tasks = queue.map(({ id, filename, status, error }) => ({ id, filename, status, error }));
  return {
    status: progress.status,
    segDone: progress.done,
    segTotal: progress.total,
    pending: tasks.filter((t) => t.status === 'pending').length,
    done: tasks.filter((t) => t.status === 'done').length,
    failed: tasks.filter((t) => t.status === 'failed').length,
    tasks,
  };
});

// JSON 文本转换：正文写入暂存后入队（与文件上传走同一条队列，不回传 mp3）
app.post('/api/convert', async (req, reply) => {
  const body = req.body as {
    text?: string; voice?: string; style?: string; autoStyle?: boolean;
  } | null;
  const text = body?.text?.trim();
  if (!text) return reply.code(400).send({ error: '缺少待转换文本' });

  enqueueTask({
    filename: `pasted-${stamp()}.txt`,
    filePath: stageText(text),
    voice: body?.voice,
    style: body?.style,
    autoStyle: body?.autoStyle,
  });
  return { ok: true };
});

// 文件上传转换：单请求支持多文件，全部入队后立即返回（不阻塞、不触发下载）
app.post('/api/convert/file', async (req, reply) => {
  const files: { filename: string; text: string }[] = [];
  let voice: string | undefined;
  let style: string | undefined;
  let autoStyle = false;

  for await (const part of req.parts()) {
    if (part.type === 'file') {
      const buf = await part.toBuffer();
      const text = buf.toString('utf-8');
      // 空文件直接跳过，不阻塞整批
      if (text.trim()) files.push({ filename: part.filename, text });
    } else if (part.fieldname === 'voice') {
      voice = String(part.value);
    } else if (part.fieldname === 'style') {
      style = String(part.value);
    } else if (part.fieldname === 'autoStyle') {
      autoStyle = String(part.value) === 'true';
    }
  }

  if (!files.length) return reply.code(400).send({ error: '上传文件为空或无法读取' });
  for (const f of files) {
    enqueueTask({
      filename: f.filename,
      filePath: stageText(f.text),
      voice, style, autoStyle,
    });
  }
  return { ok: true, enqueued: files.length };
});

// 产物列表：读取 output/ 下的 mp3，按修改时间倒序（最新产出在前）
app.get('/api/output', async () => {
  const files = fs.readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith('.mp3'))
    .map((f) => {
      const st = fs.statSync(path.join(OUTPUT_DIR, f));
      return { name: f, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return { files };
});

// 产物下载：中文文件名需 RFC 5987 编码，否则 Fastify 拒绝非 ASCII header
app.get('/api/output/:name', async (req, reply) => {
  const { name } = req.params as { name: string };
  // path.basename 防目录穿越；只允许下载 mp3
  const safeName = path.basename(name);
  const file = path.join(OUTPUT_DIR, safeName);
  if (!safeName.endsWith('.mp3') || !fs.existsSync(file)) {
    return reply.code(404).send({ error: '文件不存在' });
  }
  return reply
    .header('Content-Type', 'audio/mpeg')
    .header('Content-Disposition', `attachment; filename="audio.mp3"; filename*=UTF-8''${encodeURIComponent(safeName)}`)
    .send(fs.readFileSync(file));
});

/** 入队一个转换任务并确保 worker 在跑 */
function enqueueTask(t: Pick<ConvertTask, 'filename' | 'filePath' | 'voice' | 'style' | 'autoStyle'>) {
  const task: ConvertTask = { ...t, id: randomUUID().slice(0, 8), status: 'pending' };
  queue.push(task);
  void processQueue();
  return task;
}

/** 队列消费循环：串行处理所有 pending 任务，全部处理完后退出 */
async function processQueue() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (true) {
      // 取最早的 pending 任务（入队顺序即执行顺序）
      const task = queue.find((t) => t.status === 'pending');
      if (!task) break;
      task.status = 'running';
      progress.done = 0;
      progress.total = 0;
      progress.status = `转换中 · ${task.filename}`;
      console.log(`[转换] 开始：${task.filename}`);
      try {
        // 暂存文件读入内存后立即删除，控制暂存目录大小
        const text = fs.readFileSync(task.filePath, 'utf-8');
        fs.rmSync(task.filePath, { force: true });
        const mp3 = await textToAudio(getProvider(), text, {
          voice: task.voice,
          style: task.style,
          autoStyle: task.autoStyle,
          onProgress: (done, total) => {
            progress.done = done;
            progress.total = total;
            progress.status = `合成中 ${done}/${total} · ${task.filename}`;
            logProgress(task.filename, done, total);
          },
          // LLM 拆解等阶段性状态（此时段级进度还没产生）
          onStatus: (msg) => {
            if (!progress.done) progress.status = `${msg} · ${task.filename}`;
            console.log(`[状态] ${task.filename}：${msg}`);
          },
        });
        // 产物落盘 output/：挂机批量生成，客户端断开不丢
        const outName = toMp3Name(task.filename);
        fs.writeFileSync(path.join(OUTPUT_DIR, outName), mp3);
        task.status = 'done';
        console.log(`[完成] ${task.filename} → output/${outName}（${(mp3.length / 1024 / 1024).toFixed(1)} MB）`);
      } catch (err) {
        // 单任务失败不中断队列，挂机模式继续下一个
        task.status = 'failed';
        task.error = (err as Error).message;
        console.error(`[失败] ${task.filename}：${task.error}`);
      }
    }
    progress.done = 0;
    progress.total = 0;
    const failed = queue.filter((t) => t.status === 'failed').length;
    progress.status = failed ? '队列完成（含失败任务）' : '队列完成';
    // 队列收尾汇总日志
    const done = queue.filter((t) => t.status === 'done').length;
    console.log(`[队列] 全部完成：成功 ${done} 个，失败 ${failed} 个`);
  } finally {
    workerRunning = false;
  }
}

/** 段级进度控制台日志：每 10 段打印一次，最后一段必打（避免整本书刷屏） */
function logProgress(filename: string, done: number, total: number) {
  if (done === total || done % 10 === 0) {
    console.log(`[进度] ${filename}：${done}/${total} 段`);
  }
}

/** 把文本写入暂存目录，返回暂存路径 */
function stageText(text: string): string {
  const p = path.join(STAGING_DIR, `${randomUUID()}.txt`);
  fs.writeFileSync(p, text, 'utf-8');
  return p;
}

/** 原始文件名 → 输出 mp3 文件名：去扩展名、替换非法字符 */
function toMp3Name(filename: string): string {
  return filename.replace(/\.(txt|md)$/i, '').replace(/[\\/:*?"<>|]/g, '_') + '.mp3';
}

/** 时间戳：用于粘贴文本的默认命名，如 20260828-153000 */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// WebUI 静态页面
app.get('/', async (_req, reply) => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf-8');
  return reply.type('text/html').send(html);
});

// 浏览器标签页图标（favicon）
app.get('/icon.png', async (_req, reply) => {
  const icon = fs.readFileSync(path.join(PUBLIC_DIR, 'icon.png'));
  return reply.type('image/png').send(icon);
});

await app.listen({ host: '0.0.0.0', port: PORT });
console.log(`storybook-gen 已启动：http://localhost:${PORT}`);
