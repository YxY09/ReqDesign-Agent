/**
 * Progress tracking for the multi-agent runtime.
 *
 * Makes "progress" a first-class concept: the runtime tracks whether
 * each notification represents genuine forward movement or stagnation,
 * and exposes that information to the Coordinator for smarter decisions.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic hash of artifact content for change detection.
 * Returns the first 16 hex characters of a SHA-256 digest.
 */
function contentHash(content: unknown): string {
  if (content === null || content === undefined) {
    return "";
  }
  const text = String(content);
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** Current wall-clock time in seconds (equivalent to Python's `time.time()`). */
function nowSeconds(): number {
  return Date.now() / 1000;
}

// ---------------------------------------------------------------------------
// ProgressSnapshot
// ---------------------------------------------------------------------------

/**
 * Snapshot of progress state at a point in time.
 *
 * Updated by the runtime when folding notifications; read by the
 * Coordinator to decide repair / replan / pause strategies.
 */
export class ProgressSnapshot {
  // -- Thresholds (class-level defaults, overridable per instance) ---------

  /** Consecutive rejections before a task is considered stalled. */
  stalledRejectionThreshold: number = 3;

  /** Minimum fractional content change to be considered meaningful. */
  contentChangeMinRatio: number = 0.05;

  // -- Tracked state -------------------------------------------------------

  /** How many times each task's artifact was revised. */
  artifactRevisionCount: Record<string, number> = {};

  /** SHA-256 prefix hash of each task's latest artifact content. */
  artifactContentHashes: Record<string, string> = {};

  /** How many times each task was re-spawned from scratch. */
  taskRetryCount: Record<string, number> = {};

  /** Timestamp (seconds) of the last *meaningful* progress event. */
  lastProgressAt: number = 0.0;

  /** Task IDs with repeated rejections and no improvement. */
  stalledTaskIds: Set<string> = new Set();

  /** Consecutive rejections (by task) without a pass. */
  rejectionStreakByTask: Record<string, number> = {};

  /** How many times the plan was mutated. */
  planRevisionCount: number = 0;

  /** Evaluator scores across rounds (for trend detection). */
  scoreHistory: number[] = [];

  /** Consecutive global no-progress events. */
  noProgressStreak: number = 0;

  // -- Private bookkeeping -------------------------------------------------

  /** Arbitrary counters for budget tracking (e.g. planner_fail, repair_count:taskId). */
  _counters: Record<string, number> = {};

  private _lastContentText: Record<string, string> = {};

  // -----------------------------------------------------------------------
  // Mutation API (called by runtime when folding notifications)
  // -----------------------------------------------------------------------

  /**
   * Record a new artifact revision.
   *
   * @returns `true` if the content meaningfully changed.
   */
  recordArtifact(taskId: string, content: unknown): boolean {
    const newHash = contentHash(content);
    const oldHash = this.artifactContentHashes[taskId] ?? null;

    this.artifactRevisionCount[taskId] =
      (this.artifactRevisionCount[taskId] ?? 0) + 1;
    this.artifactContentHashes[taskId] = newHash;

    if (oldHash === null) {
      // First artifact for this task — always progress
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
   * Record a rejection for a task.
   * Increments the rejection streak and may mark the task as stalled.
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
   * Record a successful pass.
   * Clears the rejection streak for this task.
   */
  recordAcceptance(taskId: string): void {
    delete this.rejectionStreakByTask[taskId];
    this.stalledTaskIds.delete(taskId);
    this._markProgress();
  }

  /**
   * Record an evaluator score.
   *
   * @returns `true` if the score improved over the previous one.
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

  /** Record that a task was re-spawned (not continued). */
  recordRetry(taskId: string): void {
    this.taskRetryCount[taskId] = (this.taskRetryCount[taskId] ?? 0) + 1;
  }

  /** Record that the plan was mutated. */
  recordPlanMutation(): void {
    this.planRevisionCount += 1;
    this._markProgress();
  }

  /** Explicitly mark a no-progress event. */
  recordNoProgress(): void {
    this.noProgressStreak += 1;
  }

  // -----------------------------------------------------------------------
  // Query API (called by Coordinator)
  // -----------------------------------------------------------------------

  /** Is this task stalled (repeated rejections with no improvement)? */
  isTaskStalled(taskId: string): boolean {
    return this.stalledTaskIds.has(taskId);
  }

  /** Is the entire run stalled (consecutive no-progress events)? */
  isGloballyStalled(threshold = 3): boolean {
    return this.noProgressStreak >= threshold;
  }

  /** Return a sorted array of all stalled task IDs. */
  getStalledTaskIds(): string[] {
    return Array.from(this.stalledTaskIds).sort();
  }

  /** Get the current rejection streak for a task. */
  getRejectionStreak(taskId: string): number {
    return this.rejectionStreakByTask[taskId] ?? 0;
  }

  /** Get how many times a task has been retried from scratch. */
  getRetryCount(taskId: string): number {
    return this.taskRetryCount[taskId] ?? 0;
  }

  /** Return the most recent evaluator score, or `0.0` if none recorded. */
  latestScore(): number {
    if (this.scoreHistory.length === 0) return 0.0;
    return this.scoreHistory[this.scoreHistory.length - 1];
  }

  /**
   * Determine the trend of recent scores.
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

  /** Seconds since the last meaningful progress event. */
  timeSinceLastProgress(): number {
    if (this.lastProgressAt === 0.0) return 0.0;
    return nowSeconds() - this.lastProgressAt;
  }

  /** Export a summary dict for Coordinator consumption. */
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
  // Serialization
  // -----------------------------------------------------------------------

  /** Serialize to a plain object (suitable for JSON). */
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

  /** Reconstruct a `ProgressSnapshot` from a previously serialized object. */
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
  // Internal
  // -----------------------------------------------------------------------

  /** Mark that meaningful progress just occurred. */
  private _markProgress(): void {
    this.lastProgressAt = nowSeconds();
    this.noProgressStreak = 0;
  }

  /** Return the last known raw content text for size comparison. */
  private _lastKnownContent(taskId: string): string {
    return this._lastContentText[taskId] ?? "";
  }

  // Expose _lastKnownContent for testing (mirrors Python's internal helper)
  /** @internal */
  getLastKnownContent(taskId: string): string {
    return this._lastKnownContent(taskId);
  }
}
