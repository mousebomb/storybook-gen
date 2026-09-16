/**
 * 通用重试工具：只对 API 侧故障重试（判定见 errors.ts），本地错误直接抛出。
 *
 * 段级重试（管线内）和任务级重排队（队列）共用这里的退避算法，
 * 保证两层的等待节奏一致、可配置。
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { isRetryable } from './errors';

export interface RetryOptions {
  /** 总尝试次数（含首次），<=1 表示不重试 */
  attempts: number;
  /** 退避基数（毫秒）：第 n 次重试等待 base * 2^(n-1) */
  baseDelayMs?: number;
  /** 单次退避上限（毫秒） */
  maxDelayMs?: number;
  /** 每次重试前的回调（打日志 / 更新进度展示） */
  onRetry?: (err: Error, nextAttempt: number, delayMs: number) => void;
}

/**
 * 指数退避 + 抖动：抖动是为了避免同一时刻大量失败的重试再次齐齐打回接口，
 * 反而把限流拖得更久。
 */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const raw = Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), maxDelayMs);
  return Math.round(raw * (0.8 + Math.random() * 0.4));
}

/**
 * 执行 fn，并在失败可重试时自动退避重试。
 * 不可重试的错误立即抛出；重试次数用尽后抛出最后一次的错误。
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const attempts = Math.max(1, Math.floor(opts.attempts));
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 30_000;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt >= attempts) throw err;
      const delay = backoffDelay(attempt, base, max);
      opts.onRetry?.(err as Error, attempt + 1, delay);
      await sleep(delay);
    }
  }
  // 循环内必然 return 或 throw，此处仅为类型完备
  throw lastErr;
}

export { sleep };
