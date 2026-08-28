/** storybook-gen 服务入口：Fastify + WebUI + 转换 API */
import Fastify, { type FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import fs from 'node:fs';
import path from 'node:path';
import { getProvider, listProviders } from './providers';
import { getEnv, saveEnv } from './config';
import { textToAudio } from './pipeline';
import { isLlmConfigured } from './llm';

const PORT = Number(getEnv('PORT') ?? '5666');
const PUBLIC_DIR = path.join(process.cwd(), 'public');

const app = Fastify({ bodyLimit: 20 * 1024 * 1024 });
await app.register(multipart);

// 当前转换进度（内存态，同时只跑一个任务）
const progress = { running: false, done: 0, total: 0, status: '空闲' };

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

app.get('/api/progress', async () => progress);

// JSON 文本转换：直接提交正文
app.post('/api/convert', async (req, reply) => {
  if (progress.running) return reply.code(409).send({ error: '已有任务在转换中，请等待完成' });
  const body = req.body as {
    text?: string; voice?: string; style?: string; speed?: number; gapMs?: number; autoStyle?: boolean;
  } | null;
  const text = body?.text?.trim();
  if (!text) return reply.code(400).send({ error: '缺少待转换文本' });

  return runConversion(reply, text, {
    voice: body?.voice,
    style: body?.style,
    speed: body?.speed,
    gapMs: body?.gapMs,
    autoStyle: body?.autoStyle,
  });
});

// 文件上传转换：上传 txt/md 文件
app.post('/api/convert/file', async (req, reply) => {
  if (progress.running) return reply.code(409).send({ error: '已有任务在转换中，请等待完成' });

  let text = '';
  let filename = '';
  let voice: string | undefined;
  let style: string | undefined;
  let autoStyle = false;

  for await (const part of req.parts()) {
    if (part.type === 'file') {
      filename = part.filename;
      const buf = await part.toBuffer();
      text = buf.toString('utf-8');
    } else if (part.fieldname === 'voice') {
      voice = String(part.value);
    } else if (part.fieldname === 'style') {
      style = String(part.value);
    } else if (part.fieldname === 'autoStyle') {
      autoStyle = String(part.value) === 'true';
    }
  }

  if (!text.trim()) return reply.code(400).send({ error: '上传文件为空或无法读取' });
  return runConversion(reply, text, { voice, style, autoStyle }, filename);
});

/** 执行转换并返回 mp3 响应；统一处理进度与错误 */
async function runConversion(
  reply: FastifyReply,
  text: string,
  opts: { voice?: string; style?: string; speed?: number; gapMs?: number; autoStyle?: boolean },
  filename = 'storybook.mp3',
) {
  const provider = getProvider();
  progress.running = true;
  progress.done = 0;
  progress.total = 0;
  progress.status = '准备中…';
  try {
    const mp3 = await textToAudio(provider, text, {
      ...opts,
      onProgress: (done, total) => {
        progress.done = done;
        progress.total = total;
        progress.status = `合成中 ${done}/${total}`;
      },
      // LLM 拆解等阶段性状态（此时 done/total 还未产生）
      onStatus: (msg) => {
        if (!progress.done) progress.status = msg;
      },
    });
    progress.status = '完成';
    // 结果同时落盘到 output/：客户端断开也不丢，便于整本挂机批量生成
    const outDir = path.join(process.cwd(), 'output');
    fs.mkdirSync(outDir, { recursive: true });
    const downloadName = filename.replace(/\.(txt|md)$/i, '') + '.mp3';
    fs.writeFileSync(path.join(outDir, downloadName), mp3);
    // 中文文件名需 RFC 5987 编码，否则 Fastify 拒绝非 ASCII header
    return reply
      .header('Content-Type', 'audio/mpeg')
      .header('Content-Disposition', `attachment; filename="storybook.mp3"; filename*=UTF-8''${encodeURIComponent(downloadName)}`)
      .send(mp3);
  } catch (err) {
    progress.status = `失败：${(err as Error).message}`;
    return reply.code(500).send({ error: (err as Error).message });
  } finally {
    progress.running = false;
  }
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