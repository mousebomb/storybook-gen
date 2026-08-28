# storybook-gen

<p align="center">
  <img src="public/icon.png" width="120" alt="storybook-gen 图标">
</p>

文本转有声书工具：上传 txt / md，自动拆句逐段合成，合并输出一个连贯的 mp3。

区别于旧的 `ai-voice-storybook`（依赖本地 CosyVoice 大模型），本工具采用**可插拔 TTS provider** 架构：
- 默认内置小米 **MiMo-V2.5-TTS**（OpenAI 兼容接口，限时免费，无需本地模型）
- 新增引擎只需实现 `TTSProvider` 接口并注册，无需改动管线
- API Key 通过 WebUI 填写，只保存到本地 `.env`，不硬编码进源码

## 功能

- WebUI（`http://localhost:5666`）：配置 API Key、选音色、填语气指令、上传文件或粘贴文本、实时进度
- 文本预处理：去 markdown 标记（保留标题文字与对话引号），按自然段/句子拆分，每段 ≤300 字
- 合成管线：串行逐段合成（稳、不易限流）→ ffmpeg 合并，段落间自动加 0.25s 静音
- 结果双保险：响应下载 + 自动落盘到 `output/`，客户端断开不丢音频，适合整本挂机生成
- 输出规格：24kHz 单声道 64kbps MP3（朗读够用、体积小）

## 快速开始

```bash
npm install
npm start        # 启动后打开 http://localhost:5666
```

在 WebUI「配置」里填入 MiMo API Key（到 [platform.xiaomimimo.com](https://platform.xiaomimimo.com) 控制台获取），
再上传 `.txt` / `.md` 章节文件开始转换。

## 配置（.env）

`.env.example` 复制为 `.env` 即可，WebUI 保存 Key 时也会自动写入：

```ini
TTS_PROVIDER=mimo
MIMO_API_KEY=            # 通过 WebUI 填写，勿提交到仓库
MIMO_VOICE=茉莉          # 精品音色：茉莉/冰糖/苏打/白桦/Mia/Chloe/Milo/Dean
PORT=5666
```

## 架构

```
src/
  server.ts          # Fastify 入口：WebUI + 转换 API + 进度
  config.ts          # .env 读写（Key 只存这里）
  text.ts            # markdown 清洗 + 拆句
  audio.ts           # ffmpeg 合并 mp3（段落间静音）
  pipeline.ts        # 文本 → 逐段合成 → 合并 主流程
  providers/
    types.ts         # TTSProvider 接口（新增引擎实现它）
    mimo.ts          # 小米 MiMo-V2.5-TTS
    index.ts         # provider 注册表
public/index.html    # WebUI 单文件
output/              # 生成的 mp3（自动落盘）
```

### 新增 TTS provider

1. 在 `src/providers/` 新建文件，实现 `TTSProvider` 接口（`synthesize()` 返回 mp3 Buffer，`listVoices()` 返回音色列表）。
2. 在 `src/providers/index.ts` 里 `registerProvider(new XxxProvider())`。
3. 在 `.env` 设 `TTS_PROVIDER=xxx`，如需 Key 配置再在 WebUI 或 `config.ts` 补一条保存逻辑。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | provider 列表、当前选中、Key 是否已配置 |
| POST | `/api/config/apikey` | 保存 provider 的 API Key 到 `.env` |
| GET | `/api/progress` | 当前转换进度 |
| POST | `/api/convert` | JSON：`{ text, voice, style }` 转换并返回 mp3 |
| POST | `/api/convert/file` | multipart：`file` + `voice` + `style`，转换并返回 mp3 |

## 批量转换整本小说

当前 WebUI 单文件转换。批量（如整本已完结小说，数百章规模）可循环调 `/api/convert/file` 逐章生成：
结果自动按章节名落盘到 `output/`。批量脚本与断点续传可后续补 CLI。

## 已知限制 / TODO

- 单段合成失败会中断整章（当前靠串行 + 免费接口稳定性兜底）；可加每段重试 1~2 次
- MiMo 语速参数字段未确认，`speed` 暂未下发（见 `providers/mimo.ts` 内 TODO）
- 「带语气脚本」生成（先用 LLM 分析章节产出每段风格指令）尚未实现，当前用全局统一语气指令