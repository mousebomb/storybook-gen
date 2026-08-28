/** TTS provider 统一接口：新增引擎只需实现本接口并注册到 index.ts */

export interface VoiceOption {
  /** 传给 TTS 引擎的音色 ID */
  id: string;
  /** 展示名称 */
  label: string;
}

export interface SynthesizeOptions {
  /** 待合成文本（单段，建议 <=300 字） */
  text: string;
  /** 音色 ID */
  voice?: string;
  /** 语速（0.25 ~ 4.0） */
  speed?: number;
  /** 语气/风格指令（自然语言描述） */
  style?: string;
}

export interface TTSProvider {
  /** 唯一标识，与 .env 中 TTS_PROVIDER 对应 */
  id: string;
  /** 展示名称 */
  name: string;
  description?: string;
  /** 是否已配置好凭据（如 API Key） */
  isConfigured(): boolean;
  /** 列出可用音色 */
  listVoices(): Promise<VoiceOption[]>;
  /** 合成单段文本，返回音频 Buffer（mp3） */
  synthesize(opts: SynthesizeOptions): Promise<Buffer>;
}