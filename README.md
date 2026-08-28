# storybook-gen

<p align="center">
  <img src="public/icon.png" width="120" alt="storybook-gen 图标">
</p>

文本转有声书工具：上传 txt / md，自动拆句逐段合成，合并输出一个连贯的 mp3。支持批量多选上百个文件入队挂机转换。

区别于旧的 `ai-voice-storybook`（依赖本地 CosyVoice 大模型），本工具采用**可插拔 TTS provider** 架构：
- 默认内置小米 **MiMo-V2.5-TTS**（OpenAI 兼容接口，限时免费，无需本地模型）
- 新增引擎只需实现 `TTSProvider` 接口并注册，无需改动管线
- API Key 通过 WebUI 填写，只保存到本地 `.env`，不硬编码进源码

## 功能

- WebUI（`http://localhost:5666`）：配置 API Key、选音色、填语气指令、上传文件或粘贴文本、实时进度
- 批量挂机转换：文件框支持多选上百个 txt/md，入队后按顺序自动转换，产物落盘 `output/`，不触发逐文件下载
- 转换队列：任务级进度统计（待处理/完成/失败）+ 当前文件段级进度，单个任务失败不中断后续
- LLM 自动语气（可选）：配置 OpenAI 兼容 LLM 后，自动拆解文本并逐段生成语气指令，驱动 TTS 带语气朗读
- 文本预处理：去 markdown 标记（保留标题文字与对话引号），按自然段/句子拆分，每段 ≤300 字
- 合成管线：串行逐段合成（稳、不易限流）→ ffmpeg 合并，段落间自动加 0.25s 静音
- 产物管理：全部自动落盘 `output/`，WebUI 产物卡片可随时查看/下载，客户端断开不丢音频
- 输出规格：24kHz 单声道 64kbps MP3（朗读够用、体积小）

## 快速开始

```bash
npm install
npm start        # 启动后打开 http://localhost:5666
```

在 WebUI 里填入 MiMo API Key（到 [platform.xiaomimimo.com](https://platform.xiaomimimo.com) 控制台获取），
再选择一个或多个 `.txt` / `.md` 文件（或粘贴文本）加入队列，转换在后台按顺序执行，产物保存在 `output/`。

## 配置（.env）

`.env.example` 复制为 `.env` 即可，WebUI 保存 Key 时也会自动写入：

```ini
TTS_PROVIDER=mimo
MIMO_API_KEY=            # 通过 WebUI 填写，勿提交到仓库
MIMO_VOICE=茉莉          # 精品音色：茉莉/冰糖/苏打/白桦/Mia/Chloe/Milo/Dean
PORT=5666

# LLM（OpenAI 兼容）自动语气功能（可选，也可通过 WebUI 填写）
LLM_API_KEY=
LLM_BASE_URL=
LLM_MODEL=
AUTO_STYLE_ENABLED=false
```

## 架构

```
src/
  server.ts          # Fastify 入口：WebUI + 批量转换队列 API + 产物列表
  config.ts          # .env 读写（Key 只存这里）
  text.ts            # markdown 清洗 + 拆句
  audio.ts           # ffmpeg 合并 mp3（段落间静音）
  llm.ts             # LLM 自动拆解 + 逐段语气指令（自动语气功能）
  pipeline.ts        # 文本 → 逐段合成 → 合并 主流程
  providers/
    types.ts         # TTSProvider 接口（新增引擎实现它）
    mimo.ts          # 小米 MiMo-V2.5-TTS
    index.ts         # provider 注册表
public/index.html    # WebUI 单文件
output/              # 生成的 mp3（自动落盘）；.tmp/ 为上传暂存目录，自动清理
```

### 新增 TTS provider

1. 在 `src/providers/` 新建文件，实现 `TTSProvider` 接口（`synthesize()` 返回 mp3 Buffer，`listVoices()` 返回音色列表）。
2. 在 `src/providers/index.ts` 里 `registerProvider(new XxxProvider())`。
3. 在 `.env` 设 `TTS_PROVIDER=xxx`，如需 Key 配置再在 WebUI 或 `config.ts` 补一条保存逻辑。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | provider 列表、当前选中、Key 是否已配置、LLM 配置状态 |
| POST | `/api/config/apikey` | 保存 provider 的 API Key 到 `.env` |
| POST | `/api/config/llm` | 保存 LLM（Base URL / API Key / Model）配置 |
| POST | `/api/config/autostyle` | 切换自动语气开关 |
| GET | `/api/progress` | 队列状态：当前任务段级进度 + 任务级统计（pending/done/failed）+ 任务明细 |
| POST | `/api/convert` | JSON：`{ text, voice, style, autoStyle }`，入队（粘贴文本） |
| POST | `/api/convert/file` | multipart：`file`（可多文件）+ `voice` + `style` + `autoStyle`，全部入队后立即返回 |
| GET | `/api/output` | 产物列表（`output/` 下 mp3，按修改时间倒序） |
| GET | `/api/output/:name` | 下载指定产物 |

## 批量转换整本小说

WebUI 已内置批量队列：文件框一次多选上百个 txt/md（按选择顺序入队），转换在后台串行执行，
产物自动按原文件名落盘到 `output/`，WebUI「产物」卡片可随时查看和下载，无需逐文件触发下载。

命令行批量同理，循环调 `/api/convert/file` 逐文件入队即可：

```bash
for f in chapters/*.txt; do
  curl -s -F "file=@$f" -F "voice=茉莉" http://localhost:5666/api/convert/file
done
```

注意：队列当前为内存态，服务重启后未完成任务丢失（上传暂存文件一并清理），重新入队即可。

## 已知限制 / TODO

- 单段合成失败会中断整章（当前靠串行 + 免费接口稳定性兜底）；可加每段重试 1~2 次
- 队列为内存态，不支持断点续转；如需可在任务入队时持久化到磁盘
- MiMo 语速参数字段未确认，`speed` 暂未下发（见 `providers/mimo.ts` 内 TODO）