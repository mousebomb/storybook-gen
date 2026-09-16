/**
 * 错误分类：把「远端 API 临时故障」和「本地/配置问题」区分开。
 *
 * 只有前者值得重试（限流、超时、5xx、响应为空等偶发情况）；
 * 后者（缺 API Key、ffmpeg 未安装、文件读不到）重试多少次结果都一样，
 * 必须直接判失败，否则会白白占着队列反复重排队。
 */

/** 远端 API 调用失败（TTS / LLM）；retryable 标记这次失败是否值得重试 */
export class ApiError extends Error {
  /** 是否值得重试：429/5xx/超时/空响应等为 true，400/401 等为 false */
  readonly retryable: boolean;
  /** HTTP 状态码（网络层失败时无） */
  readonly status?: number;

  constructor(message: string, opts: { retryable: boolean; status?: number; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.name = 'ApiError';
    this.retryable = opts.retryable;
    this.status = opts.status;
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

/** 把 HTTP 错误响应转成 ApiError（各 provider 复用，统一重试判定口径） */
export async function apiErrorFromResponse(prefix: string, res: Response): Promise<ApiError> {
  let detail = `HTTP ${res.status}`;
  try {
    const body = await res.json() as
      | { error?: { message?: string } | string; message?: string }
      | null;
    const msg = typeof body?.error === 'string' ? body.error : body?.error?.message ?? body?.message;
    if (msg) detail += ` ${msg}`;
  } catch {
    // 响应体不是 JSON（如网关 HTML 报错页），保留状态码即可
  }
  return new ApiError(`${prefix}：${detail}`, {
    retryable: isRetryableStatus(res.status),
    status: res.status,
  });
}

/** 把 fetch 抛出的网络层异常（DNS 失败、连接中断、超时）转成可重试的 ApiError */
export function apiErrorFromNetwork(prefix: string, err: unknown): ApiError {
  const e = err as { name?: string; message?: string } | null;
  const reason = e?.name === 'AbortError' ? '请求超时或被中断' : e?.message || '请求失败';
  return new ApiError(`${prefix}：${reason}`, { retryable: true, cause: err });
}
