/**
 * 多 Agent 运行时进度追踪。
 *
 * 追踪每个任务的产物修订与内容变化，并持有预算计数器（repair/regenerate/
 * planner 失败次数）。终止与升级决策不再依赖一个独立的"全局停滞"信号——
 * 那条控制回路已被收敛硬上限 + finalMajor 无效修复闸门取代（见 policyRules /
 * remediation）。本类只保留仍被消费的状态。
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * 用于变更检测的产物内容确定性哈希。
 * 返回 SHA-256 摘要的前 16 个十六进制字符。
 */
function contentHash(content: unknown): string {
  if (content === null || content === undefined) {
    return "";
  }
  const text = String(content);
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** 当前挂钟时间（秒），等同于 Python 的 `time.time()`。 */
function nowSeconds(): number {
  return Date.now() / 1000;
}

// ---------------------------------------------------------------------------
// ProgressSnapshot
// ---------------------------------------------------------------------------

/**
 * 进度状态：产物修订追踪 + 预算计数器。
 *
 * 由运行时在折叠通知时更新；由 Coordinator 通过快照读取（修复/再生/replan
 * 次数）。
 */
export class ProgressSnapshot {
  /** 被视为有意义变化的最小内容变化比例。 */
  contentChangeMinRatio: number = 0.05;

  /** 每个任务的产物被修订的次数。 */
  artifactRevisionCount: Record<string, number> = {};

  /** 每个任务最新产物内容的 SHA-256 前缀哈希。 */
  artifactContentHashes: Record<string, string> = {};

  /** 最后一次*有意义的*进度事件的时间戳（秒）。 */
  lastProgressAt: number = 0.0;

  /** 计划被变更的次数。 */
  planRevisionCount: number = 0;

  /** 用于预算跟踪的任意计数器（如 planner_spawn_fail、repair_count:taskId）。 */
  _counters: Record<string, number> = {};

  private _lastContentText: Record<string, string> = {};

  // -----------------------------------------------------------------------
  // 变更 API（由运行时在折叠通知时调用）
  // -----------------------------------------------------------------------

  /**
   * 记录新的产物修订。
   *
   * @returns 内容是否有意义地改变了。
   */
  recordArtifact(taskId: string, content: unknown): boolean {
    const newHash = contentHash(content);
    const oldHash = this.artifactContentHashes[taskId] ?? null;

    this.artifactRevisionCount[taskId] =
      (this.artifactRevisionCount[taskId] ?? 0) + 1;
    this.artifactContentHashes[taskId] = newHash;

    if (oldHash === null) {
      // 该任务的第一个产物 — 始终视为进展
      this._lastContentText[taskId] =
        content !== null && content !== undefined ? String(content) : "";
      this._markProgress();
      return true;
    }

    if (newHash !== oldHash) {
      const oldText = this._lastContentText[taskId] ?? "";
      const oldSize = oldText.length;
      const newSize =
        content !== null && content !== undefined ? String(content).length : 0;

      if (oldSize === 0 || newSize === 0) {
        this._lastContentText[taskId] =
          content !== null && content !== undefined ? String(content) : "";
        this._markProgress();
        return true;
      }

      const ratio = Math.abs(newSize - oldSize) / Math.max(oldSize, 1);
      if (ratio >= this.contentChangeMinRatio || newHash !== oldHash) {
        this._lastContentText[taskId] =
          content !== null && content !== undefined ? String(content) : "";
        this._markProgress();
        return true;
      }
    }

    return false;
  }

  /** 记录计划被变更。 */
  recordPlanMutation(): void {
    this.planRevisionCount += 1;
    this._markProgress();
  }

  // -----------------------------------------------------------------------
  // 内部方法
  // -----------------------------------------------------------------------

  /** 标记刚刚发生了有意义的进展。 */
  private _markProgress(): void {
    this.lastProgressAt = nowSeconds();
  }
}
