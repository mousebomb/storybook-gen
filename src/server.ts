/** storybook-gen 服务入口：Fastify + WebUI + 转换 API */
import Fastify, { type FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import fs from 'node:fs';
import path from 'node:path';
import { getProvider, listProviders } from './providers';
import { getEnv, saveEnv } from './config';
import { textToAudio } from './pipeline';

const PORT = Number(getEnv('PORT') ?? '5666');
const PUBLIC_DIR = path.join(process.cwd(), 'public');

const app = Fastify({ bodyLimit: 20 * 1024 * 1024 });
await app.register(multipart);

// 当前转换进度（内存态，同时只跑一个任务）
const progress = { running: false, done: 0, total: 0, status: '空闲' };

// 状态查询：返回所有 provider、当前选中项、key 是否已配置
app.get('/api/status', async () => ({
  providers: listProviders().map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    configured: p.isConfigured(),
  })),
  current: getEnv('TTS_PROVIDER') ?? 'mimo',
  defaultVoice: getEnv('MIMO_VOICE') ?? '茉莉',
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

app.get('/api/progress', async () => progress);

// JSON 文本转换：直接提交正文
app.post('/api/convert', async (req, reply) => {
  if (progress.running) return reply.code(409).send({ error: '已有任务在转换中，请等待完成' });
  const body = req.body as { text?: string; voice?: string; style?: string; speed?: number; gapMs?: number } | null;
  const text = body?.text?.trim();
  if (!text) return reply.code(400).send({ error: '缺少待转换文本' });

  return runConversion(reply, text, {
    voice: body?.voice,
    style: body?.style,
    speed: body?.speed,
    gapMs: body?.gapMs,
  });
});

// 文件上传转换：上传 txt/md 文件
app.post('/api/convert/file', async (req, reply) => {
  if (progress.running) return reply.code(409).send({ error: '已有任务在转换中，请等待完成' });

  let text = '';
  let filename = '';
  let voice: string | undefined;
  let style: string | undefined;

  for await (const part of req.parts()) {
    if (part.type === 'file') {
      filename = part.filename;
      const buf = await part.toBuffer();
      text = buf.toString('utf-8');
    } else if (part.fieldname === 'voice') {
      voice = String(part.value);
    } else if (part.fieldname === 'style') {
      style = String(part.value);
    }
  }

  if (!text.trim()) return reply.code(400).send({ error: '上传文件为空或无法读取' });
  return runConversion(reply, text, { voice, style }, filename);
});

/** 执行转换并返回 mp3 响应；统一处理进度与错误 */
async function runConversion(
  reply: FastifyReply,
  text: string,
  opts: { voice?: string; style?: string; speed?: number; gapMs?: number },
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

await app.listen({ host: '0.0.0.0', port: PORT });
console.log(`storybook-gen 已启动：http://localhost:${PORT}`);