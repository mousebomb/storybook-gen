# 20260828 storybook-gen 有声书工具搭建与朗读版测试

## 用户原始需求

做一个类似旧项目 ai-voice-storybook 的文本转有声书工具，但**不依赖本地 CosyVoice**：

1. 做成**可插拔式 TTS provider**，先用小米 MiMo API
2. API Key 通过 **WebUI 界面**输入，保存到 `.env`，不硬编码
3. 目标用途：把某本已完结女频小说做成朗读版，方便忙时路上听
4. 项目保存到 `/Users/rhett/MyWork/2026/storybook-gen`

## 小结

### 完成内容

- **技术栈**：TypeScript + Fastify + ffmpeg（音频合并），WebUI 为零依赖单文件 HTML
- **可插拔架构**：`providers/types.ts` 定义 `TTSProvider` 接口（synthesize/listVoices/isConfigured），`providers/mimo.ts` 已实现小米 MiMo-V2.5-TTS，`providers/index.ts` 注册表管理，新增引擎零改动管线
- **合成管线**（pipeline.ts）：markdown 清洗（保留标题文字与对话引号）→ 按自然段/句子拆段（≤300字）→ 串行逐段合成 → ffmpeg 合并输出 mp3（24kHz 单声道 64kbps，段间 0.25s 静音）
- **Key 管理**：WebUI 表单 → `POST /api/config/apikey` → `saveEnv()` 写 `.env`（保留注释与无关键），`.gitignore` 排除，进程内即时刷新
- **WebUI**：状态徽标、Key 配置、音色/语气指令选择、上传文件或粘贴文本、实时进度轮询、完成后自动下载
- **结果落盘**：转换结果同时写入 `output/`，客户端断开不丢音频，适配整本挂机

### 踩坑记录

1. **中文文件名 Header**：`Content-Disposition` 直接带中文名会被 Fastify 拒绝（`Invalid character in header content`），需 RFC 5987 编码：`filename*=UTF-8''${encodeURIComponent(name)}`
2. **ffmpeg concat filter**：7.1 的 `-filter_complex_script` 已弃用，且 concat 输入标签前不能有多余前缀（`[a0][a1]concat=...` 即可，不要 `[a0][a0][a1]...`）
3. **长任务客户端断开**：HTTP 客户端中途断开后服务端任务仍在跑，需用进度轮询 + 结果落盘兜底，避免误判"失败"

### 验证结果

- 短文本：一次通过（9.4s / 75KB）
- 测试章节（约 4000 字，拆 170 段）：串行合成 + 合并一次通过，输出 28.3 分钟朗读 mp3（13.5MB / 24kHz / 64kbps）

### 后续 TODO

- 整本批量转换（CLI/脚本 + 断点续传 + 并发控制）
- 单段合成失败自动重试 1~2 次，避免整章中断
- 「带语气脚本」生成：先用 LLM 分析章节产出每段风格指令（当前仅全局统一语气）
- MiMo 语速参数字段待确认后启用 `speed`