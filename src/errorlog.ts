/**
 * 失败日志整理。
 *
 * 解决的问题：批量转一本 200 段的小说时，接口可能连续 500，每段每次都完整展开
 * 细节会把控制台刷爆，反而看不见第一条关键信息。所以：
 * - 同一类错误（指纹见 errors.ts）在时间窗内重复出现时只打一行摘要，细节不重复展开；
 * - 隔一段时间（或换了一种错误）会重新完整展开一次，保证长时间挂机时仍能看到现场；
 * - 连续失败到阈值且期间没有任何一段成功时，额外给一次「接口疑似故障」的告警，
 *   免得白等一整轮重试。
 */
import { errorSignature, errorSummary, formatErrorReport } from './errors';

export interface FailureLogOptions {
  /** 同指纹错误在该时间窗内重复出现只打摘要（默认 30s，<=0 表示每次都展开） */
  repeatWindowMs?: number;
  /** 连续失败多少次后提示「接口疑似故障」（默认 5，<=0 关闭） */
  outageWarnAfter?: number;
}

export class FailureLog {
  private readonly repeatWindowMs: number;
  private readonly outageWarnAfter: number;
  private lastSig = '';
  private lastFullAt = 0;
  private repeats = 0;
  private consecutiveFailures = 0;
  private outageWarned = false;

  constructor(opts: FailureLogOptions = {}) {
    this.repeatWindowMs = opts.repeatWindowMs ?? 30_000;
    this.outageWarnAfter = opts.outageWarnAfter ?? 5;
  }

  /** 记录一次成功：连续失败计数清零，故障恢复后下次出错会重新完整展开细节 */
  ok() {
    this.consecutiveFailures = 0;
    this.outageWarned = false;
  }

  /**
   * 记录一次失败，返回应打印的文本。
   * @param context 失败位置的一句话说明（哪个文件、第几段、第几次尝试）
   * @param opts.force 强制完整展开细节：用于「任务最终判失败」这种必须留现场的场景
   */
  fail(err: unknown, context?: string, opts: { force?: boolean } = {}): string {
    this.consecutiveFailures += 1;

    const sig = errorSignature(err);
    const now = Date.now();
    const lines: string[] = [];
    const deduped = !opts.force
      && this.repeatWindowMs > 0
      && sig === this.lastSig
      && now - this.lastFullAt < this.repeatWindowMs;

    if (deduped) {
      this.repeats += 1;
      // context 里通常已经带了错误摘要，这里只补一个「同类第几次」的标记，避免摘要重复两遍
      const note = `（同类错误第 ${this.repeats} 次，细节见上方首次输出）`;
      lines.push(context ? `${context}${note}` : `${errorSummary(err)}${note}`);
    } else {
      const prev = this.repeats;
      this.lastSig = sig;
      this.lastFullAt = now;
      this.repeats = 0;
      // force 的场景紧接着就会展开细节，不需要再单独交代重复了多少次
      if (prev > 0 && !opts.force) {
        lines.push(`（上一类错误的重复次数已达 ${prev} 次，下面重新展开一次细节）`);
      }
      lines.push(context ? `${context}\n${indentBlock(formatErrorReport(err))}` : formatErrorReport(err));
    }

    if (this.outageWarnAfter > 0 && !this.outageWarned && this.consecutiveFailures >= this.outageWarnAfter) {
      this.outageWarned = true;
      lines.push(outageWarning(this.consecutiveFailures, err));
    }

    return lines.join('\n');
  }
}

/** 连续失败告警：这种情况继续等重试基本是白等，早点告诉用户 */
function outageWarning(count: number, err: unknown): string {
  return [
    `⚠ 接口已连续失败 ${count} 次，期间没有任何一段合成成功。`,
    `   当前错误：${errorSummary(err)}`,
    '   这通常是服务端故障或配额问题，而不是本地配置错误——继续重试大概率无效。',
    '   建议：先别急着等它跑完。已生成的 mp3 都在 output/ 不会丢；',
    '         等接口恢复后点 WebUI 的「重试失败任务」补转即可，失败任务不用重新上传。',
  ].join('\n');
}

/** 细节块整体缩进，跟首行摘要拉开层次 */
function indentBlock(text: string): string {
  return text.split('\n').map((l) => (l.startsWith('  ') ? l : `  ${l}`)).join('\n');
}
