/** storybook-gen 服务入口：Fastify + WebUI + 批量转换队列 API */
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProvider, listProviders } from './providers';
import { getEnv, getEnvNumber, saveEnv } from './config';
import { textToAudio, type SegmentFailInfo } from './pipeline';
import { isLlmConfigured } from './llm';
import { ApiError, errorSummary, isRetryable } from './errors';
import { FailureLog } from './errorlog';
import { backoffDelay, sleep } from './retry';

const PORT = Number(getEnv('PORT') ?? '5666');
const PUBLIC_DIR = path.join(process.cwd(), 'public');
/** 产物目录 */
const OUTPUT_DIR = path.join(process.cwd(), 'output');
/** 上传文件暂存目录（挂在 output/ 下，天然被 .gitignore 覆盖） */
const STAGING_DIR = path.join(OUTPUT_DIR, '.tmp');

// bodyLimit 调大到 100MB：单本小说 txt 可能超过默认 20MB
const app = Fastify({ bodyLimit: 100 * 1024 * 1024 });
await app.register(multipart);

// 自定义 JSON 解析：空 body 视为 {}。
// 否则「带 Content-Type: application/json 但不带 body」的请求（如 curl -X POST 调
// /api/queue/retry-failed）会被 Fastify 以 FST_ERR_CTP_EMPTY_JSON_BODY 拒掉。
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const raw = (body as string) ?? '';
  if (raw.trim() === '') return done(null, {});
  try {
    done(null, JSON.parse(raw));
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    e.statusCode = 400;
    done(e, undefined);
  }
});

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
  /** 失败原因的处理建议（来自 ApiError.detail.hint），WebUI 里辅助判断该不该重试 */
  errorHint?: string;
  /** 已尝试次数（含首次），重排队后继续累加 */
  attempts: number;
  /** 已重排队次数，达到上限后不再重试 */
  requeues: number;
  /** 最早可执行时间（毫秒时间戳），重排队后的退避等待用；0 表示立即可执行 */
  notBefore: number;
  /** 最终失败时保留原文，供「重试失败任务」补转；正常完成的文件不留（省内存） */
  text?: string;
}

/** 任务级重试策略：整章因 API 侧失败后重新排到队尾等待重试（参数见 .env.example） */
const TASK_ATTEMPTS = Math.max(1, Math.floor(getEnvNumber('TTS_TASK_ATTEMPTS', 4)));
const TASK_RETRY_BASE_MS = getEnvNumber('TTS_TASK_RETRY_BASE_MS', 15_000);
const TASK_RETRY_MAX_MS = getEnvNumber('TTS_TASK_RETRY_MAX_MS', 120_000);
/** 队列只剩「未到重试时间」的任务时，worker 的轮询间隔（保证新入队任务能及时插队） */
const IDLE_TICK_MS = 2_000;

/**
 * 失败日志整理器：同一类错误（同状态码 + 同错误体）在 30s 内只完整展开一次，
 * 否则一本 200 段的书连续 500 会把控制台刷爆；连续失败到阈值还会给一次「接口疑似故障」的告警。
 */
const failures = new FailureLog({
  outageWarnAfter: getEnvNumber('TTS_OUTAGE_WARN_AFTER', 5),
});

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
  const tasks = queue.map((t) => ({
    id: t.id,
    filename: t.filename,
    status: t.status,
    error: t.error,
    errorHint: t.errorHint,
    attempts: t.attempts,
    requeues: t.requeues,
    /** waiting 为 true 表示因 API 失败已重排队、正在等重试时间点 */
    waiting: t.status === 'pending' && t.requeues > 0,
  }));
  return {
    status: progress.status,
    segDone: progress.done,
    segTotal: progress.total,
    pending: tasks.filter((t) => t.status === 'pending').length,
    done: tasks.filter((t) => t.status === 'done').length,
    failed: tasks.filter((t) => t.status === 'failed').length,
    /** 已重排队等待重试的任务数 */
    retrying: tasks.filter((t) => t.waiting).length,
    /** 单任务最多重排队次数（WebUI 展示「重试 n/N」用） */
    maxRequeues: TASK_ATTEMPTS - 1,
    tasks,
  };
});

// 手动补转所有失败任务：重新排到队尾（复用失败时保留的原文），
// 用于修好配置（如换 Key）或接口恢复后把没转完的补齐
app.post('/api/queue/retry-failed', async () => {
  const requeued: string[] = [];
  const skipped: string[] = [];
  for (const task of queue.filter((t) => t.status === 'failed')) {
    if (!task.text) {
      // 原文没保留（例如读暂存文件就失败了），只能重新上传
      skipped.push(task.filename);
      continue;
    }
    task.filePath = stageText(task.text);
    task.text = undefined;
    task.error = undefined;
    task.errorHint = undefined;
    task.requeues = 0;
    task.notBefore = 0;
    task.status = 'pending';
    moveToTail(task);
    requeued.push(task.filename);
  }
  if (requeued.length) void processQueue();
  console.log(`[补转] 重新入队 ${requeued.length} 个失败任务，${skipped.length} 个无原文跳过`);
  return { ok: true, requeued: requeued.length, skipped: skipped.length };
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
  const task: ConvertTask = {
    ...t,
    id: randomUUID().slice(0, 8),
    status: 'pending',
    attempts: 0,
    requeues: 0,
    notBefore: 0,
  };
  queue.push(task);
  void processQueue();
  return task;
}

/**
 * 队列消费循环：串行处理所有 pending 任务，全部处理完后退出。
 * 失败任务若属 API 侧原因，会被重新排到队尾并带上退避时间，
 * 因此这里取任务时要跳过「还没到重试时间」的，等时间到了再接着转。
 */
async function processQueue() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (true) {
      const task = nextReadyTask();
      if (!task) {
        // 队列里只剩等重试的任务：小睡一轮再检查（期间可能又有新文件入队，能及时插队）
        if (!queue.some((t) => t.status === 'pending')) break;
        await sleep(IDLE_TICK_MS);
        continue;
      }
      await runTask(task);
    }
    progress.done = 0;
    progress.total = 0;
    const failed = queue.filter((t) => t.status === 'failed').length;
    progress.status = failed ? '队列完成（含失败任务）' : '队列完成';
    // 队列收尾汇总日志
    const done = queue.filter((t) => t.status === 'done').length;
    console.log(`[队列] 全部完成：成功 ${done} 个，失败 ${failed} 个`);
    if (failed > 0) {
      // 失败原因分布：一眼看出「全是同一个故障」还是「零散问题」
      const counts = new Map<string, number>();
      for (const t of queue) {
        if (t.status === 'failed' && t.error) counts.set(t.error, (counts.get(t.error) ?? 0) + 1);
      }
      const parts = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([msg, n]) => `${msg} × ${n}`);
      console.warn(`[队列] 失败原因分布：${parts.join(' · ')}`);
      console.warn('[队列] 失败任务的原文仍保留在内存中：点 WebUI 的「重试失败任务」即可补转，无需重新上传');
    }
  } finally {
    workerRunning = false;
  }
}

/** 取下一个可执行任务：入队顺序优先，未到重试时间点的任务先跳过 */
function nextReadyTask(): ConvertTask | undefined {
  const now = Date.now();
  return queue.find((t) => t.status === 'pending' && t.notBefore <= now);
}

/** 执行单个任务：合成成功则落盘，失败交给 requeueOrFail 决定是重排队还是判失败 */
async function runTask(task: ConvertTask) {
  task.status = 'running';
  task.attempts += 1;
  progress.done = 0;
  progress.total = 0;
  progress.status = `转换中 · ${task.filename}`;
  const suffix = task.requeues ? `（第 ${task.requeues + 1} 次尝试）` : '';
  console.log(`[转换] 开始：${task.filename}${suffix}`);

  // 暂存文件读入内存后立即删除，控制暂存目录大小；失败重排队时再落一份回去
  let text = '';
  // 段级重试用尽的位置：最终失败的日志里要能看出「前几段已成功、卡在第几段」
  let segFail: SegmentFailInfo | undefined;
  try {
    text = fs.readFileSync(task.filePath, 'utf-8');
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
        // 有一段成功就说明接口是通的：连续失败计数清零
        failures.ok();
      },
      // LLM 拆解等阶段性状态（此时段级进度还没产生）
      onStatus: (msg) => {
        if (!progress.done) progress.status = `${msg} · ${task.filename}`;
        console.log(`[状态] ${task.filename}：${msg}`);
      },
      // 段级重试：只影响当前这一段，整章不用从头再来。
      // 同一类错误在日志里去重，首次出现时完整展开响应体/响应头/请求参数
      onSegmentRetry: ({ index, total, attempt, delayMs, message, err }) => {
        progress.status = `段 ${index}/${total} 失败，${Math.round(delayMs / 1000)}s 后重试（第 ${attempt} 次） · ${task.filename}`;
        console.warn(failures.fail(err, `[重试] ${task.filename} 第 ${index}/${total} 段第 ${attempt} 次尝试：${message}`));
      },
      // 段级重试用尽：先记下位置，等抛到任务级失败处理时一并打印
      onSegmentFail: (info) => { segFail = info; },
    });
    // 产物落盘 output/：挂机批量生成，客户端断开不丢
    const outName = toMp3Name(task.filename);
    fs.writeFileSync(path.join(OUTPUT_DIR, outName), mp3);
    task.status = 'done';
    task.error = undefined;
    task.errorHint = undefined;
    console.log(`[完成] ${task.filename} → output/${outName}（${(mp3.length / 1024 / 1024).toFixed(1)} MB）`);
  } catch (err) {
    requeueOrFail(task, err, text, segFail);
  }
}

/**
 * 失败处理：只有「API 侧故障」（限流/超时/5xx/空响应）才自动排到队尾重试；
 * 本地原因（缺 Key、ffmpeg 未装、文件读不到）重试再多次也一样，直接判失败。
 */
function requeueOrFail(task: ConvertTask, err: unknown, text: string, segFail?: SegmentFailInfo) {
  const message = errorSummary(err);
  task.error = message;
  task.errorHint = err instanceof ApiError ? err.detail.hint : undefined;

  // 失败位置：说明整章卡在哪一段、前面已经成了多少（重排队不必怀疑已成功的部分）
  const where = segFail
    ? `卡在 ${segFail.index}/${segFail.total} 段，前 ${segFail.done} 段已合成`
    : undefined;

  if (isRetryable(err) && task.requeues + 1 < TASK_ATTEMPTS) {
    task.requeues += 1;
    const delayMs = backoffDelay(task.requeues, TASK_RETRY_BASE_MS, TASK_RETRY_MAX_MS);
    task.status = 'pending';
    task.notBefore = Date.now() + delayMs;
    // 原文在读入时已删除，重排队前重新落一份暂存，保证重试时还能读到
    if (text) task.filePath = stageText(text);
    moveToTail(task);
    const ctx = `[重试] ${task.filename} 已排到队尾（第 ${task.requeues}/${TASK_ATTEMPTS - 1} 次重排队，`
      + `${Math.round(delayMs / 1000)}s 后可执行${where ? `；${where}` : ''}）`;
    console.warn(failures.fail(err, ctx));
    return;
  }

  task.status = 'failed';
  // 保留原文，供 WebUI「重试失败任务」补转（仅失败任务，占内存有限）
  if (text) task.text = text;
  const reason = isRetryable(err)
    ? `API 侧失败，重排队 ${task.requeues} 次仍未成功`
    : '本地/配置原因，不自动重试';
  // 最终失败强制完整展开细节：这是整轮跑完后最需要看的现场，不参与去重
  console.error(failures.fail(
    err,
    `[失败] ${task.filename}（${reason}${where ? `；${where}` : ''}）`,
    { force: true },
  ));
}

/** 把任务移到队列末尾：本轮剩余文件先转完，等重试时间点再回到它 */
function moveToTail(task: ConvertTask) {
  const idx = queue.indexOf(task);
  if (idx !== -1) queue.splice(idx, 1);
  queue.push(task);
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
