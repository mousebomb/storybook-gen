/**
 * 错误分类与诊断信息。
 *
 * 两件事：
 * 1. 区分「远端 API 临时故障」和「本地/配置问题」——只有前者值得重试；
 * 2. 把响应状态码、响应体原文、网关响应头、请求参数一并收进 ApiError.detail，
 *    失败时能直接从日志看清「谁失败、为什么失败、还有没有救」。
 *
 * 之前只提取 error.message，而小米接口 500 时 message 恰好就是
 * "Internal Server Error" 这句废话，等于什么都没打印出来；因此这里保留
 * 完整响应体原文与链路响应头（x-mife-upstream-status 之类）。
 */

/** 一次失败的结构化诊断信息；字段都可能缺，日志里只打印有值的部分 */
export interface ApiErrorDetail {
  /** HTTP 状态码（网络层失败时没有） */
  status?: number;
  /** 状态文本，如 Internal Server Error */
  statusText?: string;
  /** 响应体原文（超长截断）。非 JSON 的网关报错页也照样保留 */
  body?: string;
  /** 从响应体里抠出来的一句话说明 */
  bodyMessage?: string;
  /** 响应体里的错误码 / 类型，如 500 / InternalServerError / rate_limit_exceeded */
  code?: string;
  /** 排查服务端问题时最有用的响应头（请求 id、上游状态、Retry-After 等） */
  headers?: Record<string, string>;
  /** 请求侧上下文（模型、音色、文本长度…）。不含 API Key，默认也不含正文 */
  request?: Record<string, string | number>;
  /** 本次请求耗时（毫秒） */
  elapsedMs?: number;
  /** 针对该状态码的处理建议 */
  hint?: string;
}

/** 远端 API 调用失败（TTS / LLM）；retryable 标记这次失败是否值得重试 */
export class ApiError extends Error {
  /** 是否值得重试：429/5xx/超时/空响应等为 true，400/401 等为 false */
  readonly retryable: boolean;
  /** HTTP 状态码（网络层失败时无） */
  readonly status?: number;
  /** 结构化诊断信息，供日志展开打印 */
  readonly detail: ApiErrorDetail;

  constructor(
    message: string,
    opts: { retryable: boolean; status?: number; cause?: unknown; detail?: ApiErrorDetail },
  ) {
    super(message, { cause: opts.cause });
    this.name = 'ApiError';
    this.retryable = opts.retryable;
    this.status = opts.status;
    this.detail = opts.detail ?? {};
  }

  /** 多行诊断文本：需要看细节时才调用（重复的同类错误在 errorlog.ts 里会去重） */
  report(): string {
    return formatErrorReport(this);
  }
}

/**
 * 判断失败是否来自 API 侧、值得重排队重试。
 * 约定：只有明确标记为可重试的 ApiError 才算数，未识别的错误一律视为本地问题。
 * 这样即使以后新增 provider 忘了归类，也只会少重试，不会陷入无意义的重试循环。
 */
export function isRetryable(err: unknown): boolean {
  return err instanceof ApiError && err.retryable;
}

/** HTTP 状态码 → 是否值得重试：限流/超时/服务端故障可重试，请求本身有问题的不可 */
export function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 409 || status === 425 || status === 429) return true;
  return status >= 500;
}

/** 需要额外留意的响应头：网关/链路信息比状态码更能说明服务端发生了什么 */
const INTERESTING_HEADERS = [
  'x-mife-upstream-status',
  'x-request-id',
  'x-trace-id',
  'x-amzn-trace-id',
  'request-id',
  'retry-after',
  'server',
  'content-type',
  'content-length',
  'date',
];

/** 响应体最大保留长度：够看清报错，又不至于把控制台刷爆 */
const MAX_BODY_CHARS = 2000;

/** 超长文本截断（响应体留档、文本片段预览共用） */
export function truncateBody(text: string, max = MAX_BODY_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…（共 ${text.length} 字符，已截断）` : text;
}

/** 状态码 → 处理建议（对照小米 MiMo 官方错误码速查整理） */
export function hintForStatus(status: number): string {
  switch (status) {
    case 400:
      return '请求格式无效：JSON 错误、缺必填参数、参数越界或模型名不存在；请对比官方文档的请求体格式';
    case 401:
      return '鉴权失败：API Key 缺失/无效，或请求头格式不对（本项目的头是 api-key）';
    case 402:
      return '账户余额不足，需要充值';
    case 403:
      return '当前地区不可用，或 Key 被风控限制';
    case 404:
      return '请求的端点或模型不存在，检查模型名与 Base URL';
    case 421:
      return '内容被安全策略过滤，检查这一段的文本是否触发风控';
    case 429:
      return '触发限流或配额耗尽（各模型有独立的 RPM/TPM 与并发配额），降低频率或等配额恢复';
    case 503:
      return '服务端过载（高流量），与本地无关，稍后重试';
    default:
      if (status >= 500) {
        return '服务端内部错误，与本地配置无关；若持续出现说明接口正在故障，重试通常无效，'
          + '可稍后再试或联系官方支持';
      }
      return '';
  }
}

/** 一次性把响应体读完（不能再用 res.json()，否则解析失败就拿不到原文了） */
async function readBodySafely(res: Response): Promise<string | undefined> {
  try {
    const raw = await res.text();
    if (!raw) return undefined;
    return raw.length > MAX_BODY_CHARS
      ? `${raw.slice(0, MAX_BODY_CHARS)}…（共 ${raw.length} 字符，已截断）`
      : raw;
  } catch {
    return undefined; // 响应体读取本身失败（连接被掐断）：有状态码也够定位
  }
}

/** 从各种可能的报错体结构里抠出可读信息，格式不认识时返回空（原文依然会打出来） */
function parseErrorBody(body: string | undefined): { message?: string; code?: string } {
  if (!body) return {};
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return {}; // 不是 JSON（网关 HTML 报错页等），原文已保留
  }
  const obj = json as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object') return {};

  const errField = obj.error;
  const errObj = (typeof errField === 'object' && errField !== null ? errField : undefined) as
    | Record<string, unknown>
    | undefined;

  const pickStr = (...vals: unknown[]): string | undefined => {
    for (const v of vals) if (typeof v === 'string' && v) return v;
    return undefined;
  };

  return {
    // 覆盖 OpenAI 风格 error.message，以及常见的 message/msg/detail 变体
    message: pickStr(
      errObj?.message, typeof errField === 'string' ? errField : undefined,
      obj.message, obj.msg, obj.error_msg, obj.detail, obj.reason,
    ),
    code: pickStr(errObj?.code, errObj?.type, obj.code, obj.error_code),
  };
}

/** 摘出有价值的响应头 */
function pickHeaders(headers: Headers): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const name of INTERESTING_HEADERS) {
    const v = headers.get(name);
    if (v) out[name] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 把 HTTP 错误响应转成 ApiError（各 provider 复用，统一重试判定口径） */
export async function apiErrorFromResponse(
  prefix: string,
  res: Response,
  extra: { request?: Record<string, string | number>; elapsedMs?: number } = {},
): Promise<ApiError> {
  const body = await readBodySafely(res);
  const parsed = parseErrorBody(body);

  // 与旧格式保持兼容：HTTP 500 Internal Server Error
  const label = parsed.message ?? res.statusText ?? '';
  const message = `${prefix}：HTTP ${res.status}${label ? ` ${label}` : ''}`;

  return new ApiError(message, {
    retryable: isRetryableStatus(res.status),
    status: res.status,
    detail: {
      status: res.status,
      statusText: res.statusText || undefined,
      body,
      bodyMessage: parsed.message,
      code: parsed.code,
      headers: pickHeaders(res.headers),
      request: extra.request,
      elapsedMs: extra.elapsedMs,
      hint: hintForStatus(res.status),
    },
  });
}

/**
 * 把 fetch 抛出的网络层异常（DNS 失败、连接中断、超时、响应体被掐断）转成可重试的 ApiError。
 * 这类失败往往只留一句 "fetch failed" / "terminated"，所以把 cause 里的真实原因也带出来。
 */
export function apiErrorFromNetwork(
  prefix: string,
  err: unknown,
  extra: { request?: Record<string, string | number>; elapsedMs?: number } = {},
): ApiError {
  const e = err as
    | { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string } }
    | null;
  const timeout = e?.name === 'AbortError' || e?.name === 'TimeoutError';
  const causeMsg = e?.cause?.message;

  let reason: string;
  if (timeout) reason = `请求超时或被中断（${e?.message ?? '已中止'}）`;
  else if (causeMsg && causeMsg !== e?.message) reason = `${e?.message || '请求失败'}（底层原因：${causeMsg}）`;
  else reason = e?.message || '请求失败';

  return new ApiError(`${prefix}：${reason}`, {
    retryable: true,
    cause: err,
    detail: {
      code: e?.code ?? e?.cause?.code,
      bodyMessage: reason,
      request: extra.request,
      elapsedMs: extra.elapsedMs,
      hint: timeout
        ? `超过单次请求超时上限，接口可能在高负载或挂死；已按待重试处理`
        : '网络层失败（连接被中断、超时或无法解析域名），通常是临时故障',
    },
  });
}

/**
 * 错误指纹：同状态码 + 同错误码 + 同错误体的一句话算同一类错误。
 * errorlog.ts 用它判断「这条报错刚才是不是已经展开过了」。
 */
export function errorSignature(err: unknown): string {
  if (err instanceof ApiError) {
    const d = err.detail;
    return `api|${d.status ?? 'net'}|${d.code ?? ''}|${d.bodyMessage ?? err.message}`;
  }
  return `local|${err instanceof Error ? err.message : String(err)}`;
}

/** 一句话摘要：用于重复错误的单行日志 */
export function errorSummary(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.split('\n')[0];
}

/** 多行诊断文本：首行是摘要，后续行为缩进的细节 */
export function formatErrorReport(err: unknown): string {
  if (!(err instanceof ApiError)) {
    const lines = [errorSummary(err)];
    const cause = (err as { cause?: unknown })?.cause;
    if (cause instanceof Error && cause.message !== lines[0]) {
      lines.push(`  └ 底层原因：${cause.name}: ${cause.message}`);
    }
    lines.push('  └ 类型：非 API 错误，按本地/配置问题处理（不自动重试）');
    return lines.join('\n');
  }

  const d = err.detail;
  const rows: string[] = [errorSummary(err)];

  if (d.status !== undefined) {
    rows.push(`状态码：${d.status}${d.statusText ? ` ${d.statusText}` : ''}`
      + `（${err.retryable ? '可重试' : '不可重试'}）`);
  } else {
    rows.push('状态码：无（网络层失败）');
  }
  if (d.elapsedMs !== undefined) rows.push(`耗时：${d.elapsedMs}ms`);
  if (d.code) rows.push(`错误码：${d.code}`);
  if (d.body) rows.push(`响应体：${d.body}`);
  // 响应体不是 JSON、或 JSON 里没有说明字段时，至少把状态文本讲清楚
  if (!d.body && d.bodyMessage) rows.push(`说明：${d.bodyMessage}`);
  if (d.headers) {
    rows.push(`响应头：${Object.entries(d.headers).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  }
  if (d.request) {
    rows.push(`请求参数：${Object.entries(d.request).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  }
  if (d.hint) rows.push(`提示：${d.hint}`);

  // 首行是摘要，细节行用树线缩进；最后一行收尾换成 └，读起来有始有终
  const details = rows.slice(1).map((row, i) => {
    const last = i === rows.length - 2;
    return `  ${last ? '└' : '├'} ${row}`;
  });
  return [rows[0], ...details].join('\n');
}
