# storybook-gen 项目约定

文本转有声书工具：上传 txt / md → 拆句逐段合成 → 合并输出一个连贯 mp3。
可插拔 TTS provider，默认小米 MiMo-V2.5-TTS。

## 运行

```bash
npm run dev         # 开发模式（tsx watch）
npm run start       # 启动服务，http://localhost:5666
npm run typecheck   # 类型检查，改动代码后必须跑
```

## 架构约定

- 新增 TTS 引擎：在 `src/providers/` 下实现 `TTSProvider` 接口（见 `providers/types.ts`），再在 `providers/index.ts` 里 `registerProvider()` 注册即可，管线无需改动
- 转换管线不依赖具体引擎：`pipeline.ts` 编排，`text.ts` 负责清洗/拆句，`audio.ts` 负责 ffmpeg 合并
- 转换结果自动落盘 `output/`，客户端断开不丢，适配整本挂机生成
- WebUI 为单文件 `public/index.html`，零前端框架

## 敏感信息规范（重要）

- API Key 一律存 `.env`，通过 WebUI（`POST /api/config/apikey`）写入，**永不硬编码进源码**
- `.env`、`output/`、`node_modules/` 已在 `.gitignore`，禁止强行提交
- 文档、devlog、日志中不得出现：具体测试小说名、测试 API Key、私人路径
- 涉及真实测试数据一律用占位描述（如「某本已完结女频小说」），示例数据必须虚构

## 其他

- 所有注释使用中文
- 改动后跑 `npm run typecheck`
- 每轮开发任务完成写 `devlog/YYYYMMDD-<简短描述>.md`（记录用户需求 + 小结，同样遵守脱敏规范）