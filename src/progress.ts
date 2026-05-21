/**
 * 多 Agent 运行时进度追踪。
 *
 * 将"进度"作为一等公民：运行时追踪每个通知是否代表真正的进展或停滞，
 * 并将这些信息暴露给 Coordinator 以做出更智能的决策。
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
 * 某一时刻的进度状态快照。
 *
 * 由运行时在折叠通知时更新；由 Coordinator 读取以决定 repair/replan/pause 策略。
 */
export class ProgressSnapshot {
  // -- 阈值（类级默认值，可按实例覆盖） ---------

  /** 任务被判定为停滞前的连续拒绝次数。 */
  stalledRejectionThreshold: number = 3;

  /** 被视为有意义变化的最小内容变化比例。 */
  contentChangeMinRatio: number = 0.05;

  // -- 追踪状态 -------------------------------------------------------

  /** 每个任务的产物被修订的次数。 */
  artifactRevisionCount: Record<string, number> = {};

  /** 每个任务最新产物内容的 SHA-256 前缀哈希。 */
  artifactContentHashes: Record<string, string> = {};

  /** 每个任务从头重新启动的次数。 */
  taskRetryCount: Record<string, number> = {};

  /** 最后一次*有意义的*进度事件的时间戳（秒）。 */
  lastProgressAt: number = 0.0;

  /** 反复被拒绝且无改进的任务 ID。 */
  stalledTaskIds: Set<string> = new Set();

  /** 各任务的连续拒绝次数（未通过）。 */
  rejectionStreakByTask: Record<string, number> = {};

  /** 计划被变更的次数。 */
  planRevisionCount: number = 0;

  /** 跨轮次的评估器分数（用于趋势检测）。 */
  scoreHistory: number[] = [];

  /** 全局连续无进展事件数。 */
  noProgressStreak: number = 0;

  // -- 私有记账 -------------------------------------------------

  /** 用于预算跟踪的任意计数器（如 planner_fail、repair_count:taskId）。 */
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
      if (
        ratio >= this.contentChangeMinRatio ||
        newHash !== oldHash
      ) {
        this._lastContentText[taskId] =
          content !== null && content !== undefined ? String(content) : "";
        this._markProgress();
        return true;
      }
    }

    return false;
  }

  /**
   * 记录任务被拒绝。
   * 增加连续拒绝计数，并可能将任务标记为停滞。
   */
  recordRejection(taskId: string): void {
    const streak = (this.rejectionStreakByTask[taskId] ?? 0) + 1;
    this.rejectionStreakByTask[taskId] = streak;

    if (streak >= this.stalledRejectionThreshold) {
      this.stalledTaskIds.add(taskId);
    }

    this.noProgressStreak += 1;
  }

  /**
   * 记录成功通过。
   * 清除该任务的连续拒绝计数。
   */
  recordAcceptance(taskId: string): void {
    delete this.rejectionStreakByTask[taskId];
    this.stalledTaskIds.delete(taskId);
    this._markProgress();
  }

  /**
   * 记录评估器分数。
   *
   * @returns 分数是否比上一次有所提升。
   */
  recordScore(score: number): boolean {
    this.scoreHistory.push(score);
    if (this.scoreHistory.length >= 2) {
      if (score > this.scoreHistory[this.scoreHistory.length - 2]) {
        this._markProgress();
        return true;
      }
      this.noProgressStreak += 1;
      return false;
    }
    this._markProgress();
    return true;
  }

  /** 记录任务被重新启动（非继续）。 */
  recordRetry(taskId: string): void {
    this.taskRetryCount[taskId] = (this.taskRetryCount[taskId] ?? 0) + 1;
  }

  /** 记录计划被变更。 */
  recordPlanMutation(): void {
    this.planRevisionCount += 1;
    this._markProgress();
  }

  /** 显式标记无进展事件。 */
  recordNoProgress(): void {
    this.noProgressStreak += 1;
  }

  // -----------------------------------------------------------------------
  // 查询 API（由 Coordinator 调用）
  // -----------------------------------------------------------------------

  /** 该任务是否停滞（反复拒绝且无改进）？ */
  isTaskStalled(taskId: string): boolean {
    return this.stalledTaskIds.has(taskId);
  }

  /** 整个运行是否停滞（连续无进展事件）？ */
  isGloballyStalled(threshold = 3): boolean {
    return this.noProgressStreak >= threshold;
  }

  /** 返回所有停滞任务 ID 的排序数组。 */
  getStalledTaskIds(): string[] {
    return Array.from(this.stalledTaskIds).sort();
  }

  /** 获取任务的当前连续拒绝次数。 */
  getRejectionStreak(taskId: string): number {
    return this.rejectionStreakByTask[taskId] ?? 0;
  }

  /** 获取任务从头重试的次数。 */
  getRetryCount(taskId: string): number {
    return this.taskRetryCount[taskId] ?? 0;
  }

  /** 返回最新的评估器分数，如果没有记录则返回 `0.0`。 */
  latestScore(): number {
    if (this.scoreHistory.length === 0) return 0.0;
    return this.scoreHistory[this.scoreHistory.length - 1];
  }

  /**
   * 判断近期分数趋势。
   *
   * @returns `"improving"` | `"declining"` | `"flat"` | `"unknown"`
   */
  scoreTrend(): "improving" | "declining" | "flat" | "unknown" {
    if (this.scoreHistory.length < 2) return "unknown";

    const recent =
      this.scoreHistory.length >= 3
        ? this.scoreHistory.slice(-3)
        : this.scoreHistory;

    if (recent[recent.length - 1] > recent[0]) return "improving";
    if (recent[recent.length - 1] < recent[0]) return "declining";
    return "flat";
  }

  /** 距离上次有意义进度事件的秒数。 */
  timeSinceLastProgress(): number {
    if (this.lastProgressAt === 0.0) return 0.0;
    return nowSeconds() - this.lastProgressAt;
  }

  /** 导出供 Coordinator 使用的摘要字典。 */
  summary(): Record<string, unknown> {
    return {
      artifactRevisionCount: { ...this.artifactRevisionCount },
      taskRetryCount: { ...this.taskRetryCount },
      stalledTaskIds: this.getStalledTaskIds(),
      rejectionStreakByTask: { ...this.rejectionStreakByTask },
      planRevisionCount: this.planRevisionCount,
      scoreHistory: [...this.scoreHistory],
      latestScore: this.latestScore(),
      scoreTrend: this.scoreTrend(),
      noProgressStreak: this.noProgressStreak,
      globallyStalled: this.isGloballyStalled(),
      timeSinceLastProgress: Math.round(this.timeSinceLastProgress() * 10) / 10,
    };
  }

  // -----------------------------------------------------------------------
  // 序列化
  // -----------------------------------------------------------------------

  /** 序列化为普通对象（适合 JSON）。 */
  toDict(): Record<string, unknown> {
    return {
      artifactRevisionCount: { ...this.artifactRevisionCount },
      artifactContentHashes: { ...this.artifactContentHashes },
      taskRetryCount: { ...this.taskRetryCount },
      lastProgressAt: this.lastProgressAt,
      stalledTaskIds: this.getStalledTaskIds(),
      rejectionStreakByTask: { ...this.rejectionStreakByTask },
      planRevisionCount: this.planRevisionCount,
      scoreHistory: [...this.scoreHistory],
      noProgressStreak: this.noProgressStreak,
    };
  }

  /** 从之前序列化的对象重建 `ProgressSnapshot`。 */
  static fromDict(data: Record<string, unknown>): ProgressSnapshot {
    const snap = new ProgressSnapshot();
    snap.artifactRevisionCount = (data["artifactRevisionCount"] as Record<string, number>) ?? {};
    snap.artifactContentHashes = (data["artifactContentHashes"] as Record<string, string>) ?? {};
    snap.taskRetryCount = (data["taskRetryCount"] as Record<string, number>) ?? {};
    snap.lastProgressAt = (data["lastProgressAt"] as number) ?? 0.0;
    snap.stalledTaskIds = new Set<string>(
      Array.from((data["stalledTaskIds"] as string[]) ?? []),
    );
    snap.rejectionStreakByTask =
      (data["rejectionStreakByTask"] as Record<string, number>) ?? {};
    snap.planRevisionCount = (data["planRevisionCount"] as number) ?? 0;
    snap.scoreHistory = (data["scoreHistory"] as number[]) ?? [];
    snap.noProgressStreak = (data["noProgressStreak"] as number) ?? 0;
    return snap;
  }

  // -----------------------------------------------------------------------
  // 内部方法
  // -----------------------------------------------------------------------

  /** 标记刚刚发生了有意义的进展。 */
  private _markProgress(): void {
    this.lastProgressAt = nowSeconds();
    this.noProgressStreak = 0;
  }

  /** 返回用于大小比较的最后一个已知原始内容文本。 */
  private _lastKnownContent(taskId: string): string {
    return this._lastContentText[taskId] ?? "";
  }

  // 暴露 _lastKnownContent 用于测试（对应 Python 的内部辅助函数）
  /** @internal */
  getLastKnownContent(taskId: string): string {
    return this._lastKnownContent(taskId);
  }
}
