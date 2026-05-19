/**
 * Workflow state for the message-driven multi-agent runtime.
 *
 * Ported from reqdesign/state.py (Phase 6).
 *
 * `WorkflowState` is held by the runtime; it contains only final products,
 * task index, notification history, and control metadata.
 *
 * `MultiAgentState` is kept as a backward-compatible alias.
 */

import {
  type Artifact,
  type ExecutionPlan,
  type PlanMutation,
  type Task,
  type TaskType,
  type Verdict,
  createExecutionPlan,
  createTask,
} from "./agent/types.js";
import { ProgressSnapshot } from "./progress.js";
import { ConvergenceTracker } from "./orchestration/convergence.js";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Task-type → aggregate-field mapping
// ---------------------------------------------------------------------------

const TASK_TYPE_TO_ARTIFACT_KEY: Record<string, string> = {
  analyze: "requirement_json",
  design: "design_text",
  diagrams: "diagrams",
  tests: "test_cases",
};

export interface ArtifactsState {
  artifacts: Record<string, Artifact>;
  requirementJson: Record<string, unknown>;
  designText: string;
  diagrams: Record<string, unknown>;
  testCases: string;
  artifactRevisionsByTask: Record<string, number>;
}

export interface ExecutionState {
  goal: string;
  inputPath: string;
  outputDir: string;
  taskStatuses: Record<string, string>;
  taskSessions: Record<string, string>;
  notifications: Record<string, unknown>[];
  errors: string[];
  runStatus: string;
  startTime: number;
  endTime: number;
  decisionCount: number;
}

export interface ReviewState {
  verdicts: Verdict[];
  evaluatedRevisionsByTask: Record<string, number>;
  acceptedRevisionsByTask: Record<string, number>;
  reviewStatusByTask: Record<string, string>;
  majorPendingTaskIds: Set<string>;
  finalReviewDone: boolean;
  finalReviewPassed: boolean;
  finalReviewRevisions: Record<string, number>;
}

// ---------------------------------------------------------------------------
// WorkflowState
// ---------------------------------------------------------------------------

/**
 * Runtime state — lightweight, notification-driven.
 *
 * Replaces the old monolithic MultiAgentState. Differences from the Python
 * version are noted inline where applicable.
 */
export class WorkflowState {
  // --- Goal / paths -------------------------------------------------------
  goal: string = "design";
  inputPath: string = "";
  outputDir: string = "";

  // --- Input --------------------------------------------------------------
  requirementText: string = "";

  // --- Plan ---------------------------------------------------------------
  plan: ExecutionPlan | null = null;

  // --- Products (final map of taskId → Artifact) -------------------------
  artifacts: Record<string, Artifact> = {};

  // --- Evaluator verdicts (history) --------------------------------------
  verdicts: Verdict[] = [];

  // --- Convergence tracking ---------------------------------------------
  convergence = new ConvergenceTracker(3);

  // --- Notification history -----------------------------------------------
  notifications: Record<string, unknown>[] = [];

  // --- Inspect snapshots (latest per session) -----------------------------
  /** sessionId → snapshot */
  inspectSnapshots: Record<string, Record<string, unknown>> = {};

  // --- Control ------------------------------------------------------------
  finished: boolean = false;
  persisted: boolean = false;
  /** running | completed | partial | failed | paused */
  runStatus: string = "running";
  /** unknown | passed | rejected */
  qualityStatus: string = "unknown";
  /** not_saved | final_saved | partial_saved */
  persistStatus: string = "not_saved";
  runSummary: Record<string, unknown> = {};
  errors: string[] = [];
  /** Incremented each main-loop decision; guards re-decide loops. */
  decisionCount: number = 0;
  /** Previous action; guards against same-action re-decide. */
  lastAction: string = "";
  /** decisionCount when lastAction was set. */
  lastDecisionCount: number = -1;
  /** TaskId sent in last continue; guards re-decide loop. */
  lastContinuedTask: string = "";
  startTime: number = 0.0;
  endTime: number = 0.0;

  // --- Mode flag ----------------------------------------------------------
  /** True when Coordinator decides to skip Planner and go direct. */
  isDirectMode: boolean = false;

  // --- Task lifecycle -----------------------------------------------------
  /** taskId → pending | running | completed | failed | rejected | cancelled */
  taskStatuses: Record<string, string> = {};
  /** taskId → sessionId */
  taskSessions: Record<string, string> = {};
  taskHistory: Record<string, unknown>[] = [];

  // --- Aggregate fields (for legacy consumers) ---------------------------
  requirementJson: Record<string, unknown> = {};
  designText: string = "";
  diagrams: Record<string, unknown> = {};
  testCases: string = "";
  reviewResult: Record<string, unknown> = {};

  // --- Progress tracking --------------------------------------------------
  progress: ProgressSnapshot = new ProgressSnapshot();
  private _lastArtifactContents: Record<string, unknown> = {};
  private latestArtifactTaskByType: Record<string, string> = {};
  private diagramSourcesByKey: Record<string, string> = {};
  artifactRevisionsByTask: Record<string, number> = {};
  evaluatedRevisionsByTask: Record<string, number> = {};
  acceptedRevisionsByTask: Record<string, number> = {};
  reviewStatusByTask: Record<string, string> = {};
  majorPendingTaskIds: Set<string> = new Set();
  finalReviewDone: boolean = false;
  finalReviewPassed: boolean = false;
  finalReviewRevisions: Record<string, number> = {};

  // --- Action history (for trace export) ----------------------------------
  actionHistory: Record<string, unknown>[] = [];

  private readonly _artifactsStateView: ArtifactsState;
  private readonly _executionStateView: ExecutionState;
  private readonly _reviewStateView: ReviewState;

  constructor() {
    this._artifactsStateView = this._createArtifactsStateView();
    this._executionStateView = this._createExecutionStateView();
    this._reviewStateView = this._createReviewStateView();
  }

  private _linkStateViewProperty<TValue>(
    target: object,
    key: string,
    getter: () => TValue,
    setter: (value: TValue) => void,
  ): void {
    Object.defineProperty(target, key, {
      get: getter,
      set: setter,
      enumerable: true,
      configurable: false,
    });
  }

  private _createArtifactsStateView(): ArtifactsState {
    const view: ArtifactsState = {
      artifacts: this.artifacts,
      requirementJson: this.requirementJson,
      designText: this.designText,
      diagrams: this.diagrams,
      testCases: this.testCases,
      artifactRevisionsByTask: this.artifactRevisionsByTask,
    };
    this._linkStateViewProperty(
      view,
      "artifacts",
      () => this.artifacts,
      (value) => {
        this.artifacts = value as Record<string, Artifact>;
      },
    );
    this._linkStateViewProperty(
      view,
      "requirementJson",
      () => this.requirementJson,
      (value) => {
        this.requirementJson = value as Record<string, unknown>;
      },
    );
    this._linkStateViewProperty(
      view,
      "designText",
      () => this.designText,
      (value) => {
        this.designText = value as string;
      },
    );
    this._linkStateViewProperty(
      view,
      "diagrams",
      () => this.diagrams,
      (value) => {
        this.diagrams = value as Record<string, unknown>;
      },
    );
    this._linkStateViewProperty(
      view,
      "testCases",
      () => this.testCases,
      (value) => {
        this.testCases = value as string;
      },
    );
    this._linkStateViewProperty(
      view,
      "artifactRevisionsByTask",
      () => this.artifactRevisionsByTask,
      (value) => {
        this.artifactRevisionsByTask = value as Record<string, number>;
      },
    );
    return view;
  }

  private _createExecutionStateView(): ExecutionState {
    const view: ExecutionState = {
      goal: this.goal,
      inputPath: this.inputPath,
      outputDir: this.outputDir,
      taskStatuses: this.taskStatuses,
      taskSessions: this.taskSessions,
      notifications: this.notifications,
      errors: this.errors,
      runStatus: this.runStatus,
      startTime: this.startTime,
      endTime: this.endTime,
      decisionCount: this.decisionCount,
    };
    this._linkStateViewProperty(
      view,
      "goal",
      () => this.goal,
      (value) => {
        this.goal = value as string;
      },
    );
    this._linkStateViewProperty(
      view,
      "inputPath",
      () => this.inputPath,
      (value) => {
        this.inputPath = value as string;
      },
    );
    this._linkStateViewProperty(
      view,
      "outputDir",
      () => this.outputDir,
      (value) => {
        this.outputDir = value as string;
      },
    );
    this._linkStateViewProperty(
      view,
      "taskStatuses",
      () => this.taskStatuses,
      (value) => {
        this.taskStatuses = value as Record<string, string>;
      },
    );
    this._linkStateViewProperty(
      view,
      "taskSessions",
      () => this.taskSessions,
      (value) => {
        this.taskSessions = value as Record<string, string>;
      },
    );
    this._linkStateViewProperty(
      view,
      "notifications",
      () => this.notifications,
      (value) => {
        this.notifications = value as Record<string, unknown>[];
      },
    );
    this._linkStateViewProperty(
      view,
      "errors",
      () => this.errors,
      (value) => {
        this.errors = value as string[];
      },
    );
    this._linkStateViewProperty(
      view,
      "runStatus",
      () => this.runStatus,
      (value) => {
        this.runStatus = value as string;
      },
    );
    this._linkStateViewProperty(
      view,
      "startTime",
      () => this.startTime,
      (value) => {
        this.startTime = value as number;
      },
    );
    this._linkStateViewProperty(
      view,
      "endTime",
      () => this.endTime,
      (value) => {
        this.endTime = value as number;
      },
    );
    this._linkStateViewProperty(
      view,
      "decisionCount",
      () => this.decisionCount,
      (value) => {
        this.decisionCount = value as number;
      },
    );
    return view;
  }

  private _createReviewStateView(): ReviewState {
    const view: ReviewState = {
      verdicts: this.verdicts,
      evaluatedRevisionsByTask: this.evaluatedRevisionsByTask,
      acceptedRevisionsByTask: this.acceptedRevisionsByTask,
      reviewStatusByTask: this.reviewStatusByTask,
      majorPendingTaskIds: this.majorPendingTaskIds,
      finalReviewDone: this.finalReviewDone,
      finalReviewPassed: this.finalReviewPassed,
      finalReviewRevisions: this.finalReviewRevisions,
    };
    this._linkStateViewProperty(
      view,
      "verdicts",
      () => this.verdicts,
      (value) => {
        this.verdicts = value as Verdict[];
      },
    );
    this._linkStateViewProperty(
      view,
      "evaluatedRevisionsByTask",
      () => this.evaluatedRevisionsByTask,
      (value) => {
        this.evaluatedRevisionsByTask = value as Record<string, number>;
      },
    );
    this._linkStateViewProperty(
      view,
      "acceptedRevisionsByTask",
      () => this.acceptedRevisionsByTask,
      (value) => {
        this.acceptedRevisionsByTask = value as Record<string, number>;
      },
    );
    this._linkStateViewProperty(
      view,
      "reviewStatusByTask",
      () => this.reviewStatusByTask,
      (value) => {
        this.reviewStatusByTask = value as Record<string, string>;
      },
    );
    this._linkStateViewProperty(
      view,
      "majorPendingTaskIds",
      () => this.majorPendingTaskIds,
      (value) => {
        this.majorPendingTaskIds = value as Set<string>;
      },
    );
    this._linkStateViewProperty(
      view,
      "finalReviewDone",
      () => this.finalReviewDone,
      (value) => {
        this.finalReviewDone = value as boolean;
      },
    );
    this._linkStateViewProperty(
      view,
      "finalReviewPassed",
      () => this.finalReviewPassed,
      (value) => {
        this.finalReviewPassed = value as boolean;
      },
    );
    this._linkStateViewProperty(
      view,
      "finalReviewRevisions",
      () => this.finalReviewRevisions,
      (value) => {
        this.finalReviewRevisions = value as Record<string, number>;
      },
    );
    return view;
  }

  get artifactsState(): ArtifactsState {
    return this._artifactsStateView;
  }

  get executionState(): ExecutionState {
    return this._executionStateView;
  }

  get reviewState(): ReviewState {
    return this._reviewStateView;
  }

  // ------------------------------------------------------------------
  // Artifact management
  // ------------------------------------------------------------------

  /** Add an artifact, sync aggregate fields, and track progress. */
  addArtifact(artifact: Artifact): void {
    const artifactsState = this.artifactsState;

    const revision = (artifactsState.artifactRevisionsByTask[artifact.taskId] ?? 0) + 1;
    artifact.revision = revision;
    artifactsState.artifactRevisionsByTask[artifact.taskId] = revision;
    artifactsState.artifacts[artifact.taskId] = artifact;
    this.latestArtifactTaskByType[artifact.type] = artifact.taskId;
    this._syncAggregate(artifact);
    // Clear major pending for this task — its artifact has changed, needs re-evaluation
    this.reviewState.majorPendingTaskIds.delete(artifact.taskId);
    // Note: do NOT reset finalReviewDone here — repair adds artifacts which
    // is part of the review-repair cycle. Only clearReviewContext resets it.
    this.qualityStatus = "unknown";
    // Track progress: compare with previous content
    this.progress.recordArtifact(artifact.taskId, artifact.content);
    this._lastArtifactContents[artifact.taskId] = artifact.content;
  }

  /**
   * Sync aggregate fields from an artifact.
   *
   * For analyze type: rebuilds the aggregate from all current analyze artifacts.
   * This preserves multi-analyze intermediate state and avoids stale data when
   * an analyze task is regenerated.
   *
   * For other types: keeps the latest task output as the aggregate field.
   */
  private _syncAggregate(artifact: Artifact): void {
    const artifactsState = this.artifactsState;
    const key = TASK_TYPE_TO_ARTIFACT_KEY[artifact.type] ?? "";
    const content = artifact.content;

    if (!key || content === null || content === undefined) return;

    if (key === "requirement_json" && typeof content === "object" && !Array.isArray(content)) {
      artifactsState.requirementJson = this._rebuildRequirementAggregate();
    } else if (key === "design_text" && typeof content === "string") {
      if (content) {
        artifactsState.designText = content;
      }
    } else if (key === "diagrams" && typeof content === "object" && !Array.isArray(content)) {
      const existing: Record<string, unknown> = artifactsState.diagrams ?? {};
      for (const [diagramKey, diagramValue] of Object.entries(content as Record<string, unknown>)) {
        existing[diagramKey] = diagramValue;
        this.diagramSourcesByKey[diagramKey] = artifact.taskId;
      }
      artifactsState.diagrams = existing;
    } else if (key === "test_cases" && typeof content === "string") {
      if (content) {
        artifactsState.testCases = content;
      }
    }
  }

  private _rebuildRequirementAggregate(): Record<string, unknown> {
    const aggregate: Record<string, unknown> = {};

    for (const artifact of Object.values(this.artifactsState.artifacts)) {
      if (artifact.type !== "analyze") continue;
      if (!artifact.content || typeof artifact.content !== "object" || Array.isArray(artifact.content)) {
        continue;
      }
      this._mergeRequirementValue(aggregate, artifact.content as Record<string, unknown>);
    }

    return aggregate;
  }

  private _mergeRequirementValue(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
  ): void {
    for (const [field, value] of Object.entries(source)) {
      const existing = target[field];
      if (Array.isArray(existing) && Array.isArray(value)) {
        target[field] = this._mergeRequirementArrays(existing, value);
      } else if (this._isPlainObject(existing) && this._isPlainObject(value)) {
        const nestedTarget = { ...(existing as Record<string, unknown>) };
        this._mergeRequirementValue(nestedTarget, value as Record<string, unknown>);
        target[field] = nestedTarget;
      } else if (Array.isArray(value)) {
        target[field] = this._mergeRequirementArrays([], value);
      } else if (this._isPlainObject(value)) {
        const nestedTarget: Record<string, unknown> = {};
        this._mergeRequirementValue(nestedTarget, value as Record<string, unknown>);
        target[field] = nestedTarget;
      } else {
        target[field] = value;
      }
    }
  }

  private _mergeRequirementArrays(left: unknown[], right: unknown[]): unknown[] {
    const seen = new Set<string>();
    const merged: unknown[] = [];

    for (const item of [...left, ...right]) {
      const key = this._stableRequirementKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }

    return merged;
  }

  private _stableRequirementKey(value: unknown): string {
    if (Array.isArray(value)) {
      return JSON.stringify(value.map((item) => this._stableRequirementKey(item)));
    }
    if (this._isPlainObject(value)) {
      const entries = Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, this._stableRequirementKey(item)]);
      return JSON.stringify(entries);
    }
    return JSON.stringify(value);
  }

  private _isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // ------------------------------------------------------------------
  // Verdict management
  // ------------------------------------------------------------------

  /** Record a verdict. */
  addVerdict(verdict: Verdict): void {
    const reviewState = this.reviewState;
    const blockerTaskIds = new Set<string>();
    const majorTaskIds = new Set<string>();
    for (const issue of verdict.issues) {
      if (issue.severity === "blocker" && issue.targetTaskId) {
        blockerTaskIds.add(issue.targetTaskId);
      }
      if (issue.severity === "major" && issue.targetTaskId) {
        majorTaskIds.add(issue.targetTaskId);
      }
    }

    for (const [taskId, revision] of Object.entries(verdict.evaluatedRevisions)) {
      const current = reviewState.evaluatedRevisionsByTask[taskId] ?? 0;
      if (revision >= current) {
        // Don't downgrade an already-accepted revision to "rejected"
        const acceptedRev = reviewState.acceptedRevisionsByTask[taskId] ?? 0;
        if (revision <= acceptedRev) {
          continue;
        }
        reviewState.evaluatedRevisionsByTask[taskId] = revision;
        const status: string = blockerTaskIds.has(taskId) ? "rejected" : "passed";
        reviewState.reviewStatusByTask[taskId] = status;
        if (status === "passed") {
          reviewState.acceptedRevisionsByTask[taskId] = revision;
        }
      }
    }

    // Track tasks with major issues that passed (no blockers)
    // so the coordinator can attempt one repair round
    reviewState.majorPendingTaskIds = new Set(
      [...majorTaskIds].filter((id) => !blockerTaskIds.has(id)),
    );
    if (reviewState.majorPendingTaskIds.size > 0) {
      // Reset major repair tracking in progress (mirrors Python's _counters)
      this.progress.recordNoProgress();
    }

    reviewState.verdicts.push(verdict);

    // Update convergence tracker with latest evaluation issues
    if (verdict.issues.length > 0) {
      this.convergence.addRound({
        issues: verdict.issues.map((issue) => ({
          fingerprint: ConvergenceTracker.fingerprint(issue.description),
          severity: issue.severity,
        })),
      });
    }

    this.reviewResult = {
      passed: verdict.passed,
      isFinalReview: verdict.isFinalReview,
      evaluatedTaskIds: [...verdict.evaluatedTaskIds],
      evaluatedRevisions: { ...verdict.evaluatedRevisions },
      reviewStatusByTask: { ...reviewState.reviewStatusByTask },
      issues: verdict.issues.map((i) => ({
        severity: i.severity,
        target: i.targetTaskId,
        targetType: i.targetTaskType,
        description: i.description,
        suggestion: i.suggestion,
        scope: i.scope,
      })),
    };

    if (verdict.isFinalReview) {
      reviewState.finalReviewDone = true;
      reviewState.finalReviewPassed = verdict.passed;
      reviewState.finalReviewRevisions = { ...verdict.evaluatedRevisions };
      this.qualityStatus = verdict.passed ? "passed" : "rejected";
    }

    // Track evaluator activity
    if (verdict.passed) {
      this.progress.recordScore(1.0);
      for (const taskId of Object.keys(
        this.progress.rejectionStreakByTask,
      )) {
        this.progress.recordAcceptance(taskId);
      }
    } else {
      this.progress.recordScore(0.0);
    }
  }

  // ------------------------------------------------------------------
  // Notification history
  // ------------------------------------------------------------------

  /** Record a notification for trace/observability. */
  recordNotification(notif: Record<string, unknown>): void {
    const executionState = this.executionState;
    executionState.notifications.push(notif);
  }

  /** Record that a repair attempt was completed for a task. */
  recordRepairAttempt(taskId: string): void {
    if (!taskId) return;
    const key = `repair_count:${taskId}`;
    this.progress._counters[key] = (this.progress._counters[key] ?? 0) + 1;
  }

  /** Record that a task was regenerated from scratch. */
  recordRegenerateAttempt(taskId: string): void {
    if (!taskId) return;
    const key = `regenerate_count:${taskId}`;
    this.progress._counters[key] = (this.progress._counters[key] ?? 0) + 1;
  }

  /** Record a planner failure for orchestration budget guards. */
  recordPlannerFailure(): void {
    const key = "planner_spawn_fail";
    this.progress._counters[key] = (this.progress._counters[key] ?? 0) + 1;
  }

  /** Record the current lifecycle status for a task. */
  markTaskStatus(
    taskId: string,
    status: string,
    sessionId: string = "",
    details?: Record<string, unknown> | null,
  ): void {
    if (!taskId) return;
    const executionState = this.executionState;
    executionState.taskStatuses[taskId] = status;

    // Track planner failures for budget guards
    if (taskId === "planner" && status === "failed") {
      this.recordPlannerFailure();
    }
    if (sessionId) {
      executionState.taskSessions[taskId] = sessionId;
    }
    const entry: Record<string, unknown> = {
      taskId,
      status,
      timestamp: Date.now() / 1000,
    };
    if (sessionId) {
      entry["sessionId"] = sessionId;
    }
    if (details) {
      entry["details"] = details;
    }
    this.taskHistory.push(entry);
  }

  /** Get the lifecycle status of a task (defaults to `"pending"`). */
  taskStatus(taskId: string): string {
    return this.taskStatuses[taskId] ?? "pending";
  }

  /** Whether a task is completed. */
  isTaskCompleted(taskId: string): boolean {
    return this.taskStatus(taskId) === "completed";
  }

  /** Whether a task is running. */
  isTaskRunning(taskId: string): boolean {
    return this.taskStatus(taskId) === "running";
  }

  /** Sorted list of completed task IDs. */
  getCompletedTaskIds(): string[] {
    return Object.entries(this.taskStatuses)
      .filter(([, status]) => status === "completed")
      .map(([taskId]) => taskId)
      .sort();
  }

  /** Sorted list of running task IDs. */
  getRunningTaskIds(): string[] {
    return Object.entries(this.taskStatuses)
      .filter(([, status]) => status === "running")
      .map(([taskId]) => taskId)
      .sort();
  }

  /** Sorted list of failed task IDs. */
  getFailedTaskIds(): string[] {
    return Object.entries(this.taskStatuses)
      .filter(([, status]) => status === "failed")
      .map(([taskId]) => taskId)
      .sort();
  }

  /** All task IDs from the current plan. */
  getPlanTaskIds(): string[] {
    if (!this.plan) return [];
    return this.plan.tasks.map((t) => t.id);
  }

  /** Task IDs from the plan that are completed. */
  getCompletedPlanTaskIds(): string[] {
    const planTaskIds = new Set(this.getPlanTaskIds());
    return Object.entries(this.taskStatuses)
      .filter(([taskId, status]) => planTaskIds.has(taskId) && status === "completed")
      .map(([taskId]) => taskId)
      .sort();
  }

  /**
   * Plan tasks whose dependencies are complete and that are not already
   * running, completed, rejected, cancelled, or failed.
   */
  getReadyTaskIds(): string[] {
    if (!this.plan) return [];
    const ready: string[] = [];
    const terminalStatuses = new Set([
      "running",
      "completed",
      "rejected",
      "cancelled",
      "failed",
    ]);
    for (const task of this.plan.tasks) {
      const status = this.taskStatus(task.id);
      if (terminalStatuses.has(status)) continue;
      if (task.dependsOn.every((dep) => this.isTaskCompleted(dep))) {
        ready.push(task.id);
      }
    }
    return ready;
  }

  /** Plan tasks that have not started yet (status is `"pending"`). */
  getPendingTaskIds(): string[] {
    if (!this.plan) return [];
    return this.plan.tasks
      .filter((t) => this.taskStatus(t.id) === "pending")
      .map((t) => t.id);
  }

  /** Plan tasks that are waiting on unfinished dependencies. */
  getBlockedTaskIds(): string[] {
    if (!this.plan) return [];
    const readySet = new Set(this.getReadyTaskIds());
    const blocked: string[] = [];
    for (const task of this.plan.tasks) {
      if (readySet.has(task.id)) continue;
      if (this.taskStatus(task.id) === "pending" && task.dependsOn.length > 0) {
        blocked.push(task.id);
      }
    }
    return blocked;
  }

  // ------------------------------------------------------------------
  // Derived properties
  // ------------------------------------------------------------------

  /** The most recently added verdict, or `null`. */
  get latestVerdict(): Verdict | null {
    return this.verdicts.length > 0 ? this.verdicts[this.verdicts.length - 1] : null;
  }

  /** Total number of artifacts stored. */
  get totalArtifacts(): number {
    return Object.keys(this.artifacts).length;
  }

  /** Summary dict of all artifacts (type, revision, self-check, size). */
  artifactSummary(): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const [taskId, a] of Object.entries(this.artifacts)) {
      result[taskId] = {
        type: a.type,
        revision: a.revision,
        selfCheckPassed: a.selfCheckPassed,
        selfCorrectRounds: a.selfCorrectRounds,
        size: a.content !== null && a.content !== undefined ? String(a.content).length : 0,
      };
    }
    return result;
  }

  /**
   * Snapshot dict of artifacts for the given task IDs (or all if omitted).
   * Only includes tasks that have an artifact.
   */
  artifactSnapshots(
    taskIds?: string[],
  ): Record<string, Record<string, unknown>> {
    const ids = taskIds ?? Object.keys(this.artifacts);
    const snapshots: Record<string, Record<string, unknown>> = {};
    for (const taskId of ids) {
      const artifact = this.artifacts[taskId];
      if (artifact === undefined) continue;
      snapshots[taskId] = {
        taskId: artifact.taskId,
        type: artifact.type,
        revision: artifact.revision,
        content: artifact.content,
        selfCheckPassed: artifact.selfCheckPassed,
        selfCheckIssues: [...artifact.selfCheckIssues],
      };
    }
    return snapshots;
  }

  /** Snapshot of the effective final outputs, not every historical task artifact. */
  finalArtifactSnapshots(): Record<string, Record<string, unknown>> {
    const snapshots: Record<string, Record<string, unknown>> = {};

    if (this.requirementJson && Object.keys(this.requirementJson).length > 0) {
      snapshots["analyze-final"] = {
        taskId: "analyze-final",
        type: "analyze",
        revision: this._contentRevision(this.requirementJson),
        content: this.requirementJson,
        selfCheckPassed: true,
        selfCheckIssues: [],
        sourceRevisions: this._sourceRevisionsForType("analyze"),
      };
    }

    const latestDesign = this._latestArtifactOfType("design");
    if (latestDesign) {
      snapshots[latestDesign.taskId] = {
        taskId: latestDesign.taskId,
        type: latestDesign.type,
        revision: latestDesign.revision,
        content: latestDesign.content,
        selfCheckPassed: latestDesign.selfCheckPassed,
        selfCheckIssues: [...latestDesign.selfCheckIssues],
      };
    }

    if (this.diagrams && Object.keys(this.diagrams).length > 0) {
      snapshots["diagrams-final"] = {
        taskId: "diagrams-final",
        type: "diagrams",
        revision: this._contentRevision(this.diagrams),
        content: this.diagrams,
        selfCheckPassed: true,
        selfCheckIssues: [],
        sourceTaskIds: [...new Set(Object.values(this.diagramSourcesByKey))].sort(),
        sourceRevisions: this._sourceRevisionsForTaskIds(
          [...new Set(Object.values(this.diagramSourcesByKey))],
        ),
      };
    }

    const latestTests = this._latestArtifactOfType("tests");
    if (latestTests) {
      snapshots[latestTests.taskId] = {
        taskId: latestTests.taskId,
        type: latestTests.type,
        revision: latestTests.revision,
        content: latestTests.content,
        selfCheckPassed: latestTests.selfCheckPassed,
        selfCheckIssues: [...latestTests.selfCheckIssues],
      };
    }

    return snapshots;
  }

  private _latestArtifactOfType(type: string): Artifact | null {
    const latestTaskId = this.latestArtifactTaskByType[type];
    if (latestTaskId && this.artifacts[latestTaskId]) {
      return this.artifacts[latestTaskId];
    }
    let latest: Artifact | null = null;
    for (const artifact of Object.values(this.artifacts)) {
      if (artifact.type !== type) continue;
      latest = artifact;
    }
    return latest;
  }

  latestArtifactTaskIdOfType(type: string): string {
    const latestTaskId = this.latestArtifactTaskByType[type];
    if (latestTaskId && this.artifacts[latestTaskId]) return latestTaskId;
    const latest = this._latestArtifactOfType(type);
    return latest?.taskId ?? "";
  }

  diagramSourceTaskId(diagramKey: string): string {
    const normalized = diagramKey.trim();
    if (normalized && this.diagramSourcesByKey[normalized]) {
      return this.diagramSourcesByKey[normalized];
    }
    for (const [key, taskId] of Object.entries(this.diagramSourcesByKey)) {
      if (normalized && key.includes(normalized)) return taskId;
    }
    return this.latestArtifactTaskIdOfType("diagrams");
  }

  private _contentRevision(content: unknown): number {
    const text = JSON.stringify(content, (_key, value) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        );
      }
      return value;
    });
    const hex = createHash("sha256").update(text ?? "", "utf8").digest("hex").slice(0, 12);
    return parseInt(hex, 16) || 1;
  }

  private _sourceRevisionsForType(type: string): Record<string, number> {
    const revisions: Record<string, number> = {};
    for (const artifact of Object.values(this.artifacts)) {
      if (artifact.type !== type) continue;
      revisions[artifact.taskId] = this.currentArtifactRevision(artifact.taskId);
    }
    return revisions;
  }

  private _sourceRevisionsForTaskIds(taskIds: string[]): Record<string, number> {
    const revisions: Record<string, number> = {};
    for (const taskId of taskIds) {
      const revision = this.currentArtifactRevision(taskId);
      if (revision > 0) revisions[taskId] = revision;
    }
    return revisions;
  }

  /** Current revision number for a task's artifact (0 if none). */
  currentArtifactRevision(taskId: string): number {
    return this.artifactRevisionsByTask[taskId] ?? 0;
  }

  /** Latest revision that has been evaluated by the reviewer (0 if none). */
  latestEvaluatedRevision(taskId: string): number {
    return this.evaluatedRevisionsByTask[taskId] ?? 0;
  }

  /**
   * Review status of a task's current artifact revision.
   * Returns `"unknown"` if the current revision hasn't been evaluated yet.
   */
  currentReviewStatus(taskId: string): string {
    const currentRevision = this.currentArtifactRevision(taskId);
    if (currentRevision === 0) return "unknown";
    if (this.latestEvaluatedRevision(taskId) !== currentRevision) return "unknown";
    return this.reviewStatusByTask[taskId] ?? "unknown";
  }

  /** Whether the current artifact revision for a task has been accepted. */
  isCurrentArtifactAccepted(taskId: string): boolean {
    const currentRevision = this.currentArtifactRevision(taskId);
    if (currentRevision === 0) return false;
    return (
      this.latestEvaluatedRevision(taskId) === currentRevision &&
      this.reviewStatusByTask[taskId] === "passed" &&
      this.acceptedRevisionsByTask[taskId] === currentRevision
    );
  }

  /** Task IDs whose latest artifact revision has not been evaluated yet. */
  getUnevaluatedArtifactTaskIds(): string[] {
    return Object.keys(this.artifacts)
      .filter(
        (taskId) =>
          this.currentArtifactRevision(taskId) > this.latestEvaluatedRevision(taskId),
      )
      .sort();
  }

  /** Task IDs whose current artifact was rejected. */
  getRejectedArtifactTaskIds(): string[] {
    return Object.keys(this.artifacts)
      .filter((taskId) => this.currentReviewStatus(taskId) === "rejected")
      .sort();
  }

  /** Task IDs whose current artifact has not been accepted. */
  getUnacceptedArtifactTaskIds(): string[] {
    return Object.keys(this.artifacts)
      .filter((taskId) => !this.isCurrentArtifactAccepted(taskId))
      .sort();
  }

  /** Tasks that passed (no blockers) but have major issues worth fixing. */
  getMajorPendingTaskIds(): string[] {
    return [...this.majorPendingTaskIds]
      .filter((tid) => tid in this.artifacts)
      .sort();
  }

  /** Clear the set of major-pending task IDs. */
  clearMajorPending(): void {
    this.majorPendingTaskIds.clear();
  }

  /** Whether any artifact exists with the given task type. */
  hasArtifactOfType(taskType: string): boolean {
    return Object.values(this.artifacts).some((a) => a.type === taskType);
  }

  /** All artifacts matching the given task type. */
  getArtifactsByType(taskType: string): Artifact[] {
    return Object.values(this.artifacts).filter((a) => a.type === taskType);
  }

  /** Elapsed seconds since start (or between start and end). */
  duration(): number {
    if (this.endTime && this.startTime) {
      return this.endTime - this.startTime;
    }
    if (this.startTime) {
      return Date.now() / 1000 - this.startTime;
    }
    return 0.0;
  }

  /**
   * Look up a task from the plan by its id.
   * Returns a plain-object snapshot or `null`.
   */
  getTaskById(
    taskId: string,
  ): {
    id: string;
    type: TaskType;
    description: string;
    dependsOn: string[];
    contextHints: Record<string, unknown>;
  } | null {
    if (!this.plan) return null;
    for (const t of this.plan.tasks) {
      if (t.id === taskId) {
        return {
          id: t.id,
          type: t.type,
          description: t.description,
          dependsOn: t.dependsOn,
          contextHints: t.contextHints,
        };
      }
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Plan mutation
  // ------------------------------------------------------------------

  /**
   * Apply a {@link PlanMutation} to the current plan.
   *
   * Validates:
   * - Task type validity
   * - Completed tasks are not dropped or illegally modified
   * - New task IDs are unique
   * - Dependency graph is a DAG (acyclic)
   * - No dangling dependencies
   *
   * @returns Array of validation error strings (empty = success).
   */
  mutatePlan(mutation: PlanMutation): string[] {
    if (this.plan === null) {
      return ["cannot mutate: no plan exists"];
    }

    const errors: string[] = [];

    // --- Validate: new task types must be valid ---
    const validTypes = new Set<string>(["analyze", "design", "diagrams", "tests"]);
    for (const task of mutation.addTasks) {
      if (!validTypes.has(task.type)) {
        errors.push(`invalid task type '${task.type}' for '${task.id}'`);
      }
    }
    for (const task of mutation.updateTasks) {
      if (!validTypes.has(task.type)) {
        errors.push(`invalid task type '${task.type}' for '${task.id}'`);
      }
    }
    for (const taskId of mutation.dropTaskIds) {
      if (this.isTaskCompleted(taskId)) {
        errors.push(`cannot drop completed task '${taskId}'`);
      }
    }

    // --- Validate: completed tasks cannot be meaningfully updated ---
    for (const task of mutation.updateTasks) {
      if (this.isTaskCompleted(task.id)) {
        const existing = this.getTaskById(task.id);
        if (
          existing &&
          (task.type !== existing.type ||
            JSON.stringify(task.dependsOn) !==
              JSON.stringify(existing.dependsOn))
        ) {
          errors.push(
            `cannot change type/dependsOn of completed task '${task.id}'`,
          );
        }
      }
    }

    // --- Validate: new task IDs must be unique ---
    const existingIds = new Set(this.plan.tasks.map((t) => t.id));
    const dropSet = new Set(mutation.dropTaskIds);
    for (const task of mutation.addTasks) {
      if (existingIds.has(task.id) && !dropSet.has(task.id)) {
        errors.push(`new task id '${task.id}' conflicts with existing task`);
      }
    }
    // Check duplicates within addTasks itself
    const newIdSet = new Set(mutation.addTasks.map((t) => t.id));
    if (newIdSet.size !== mutation.addTasks.length) {
      errors.push("duplicate task ids in addTasks");
    }

    // --- Build the new task list ---
    if (errors.length > 0) {
      return errors;
    }

    // Start with existing tasks, applying mutations
    interface TaskInfo {
      id: string;
      type: TaskType;
      description: string;
      dependsOn: string[];
      contextHints: Record<string, unknown>;
    }

    const taskMap = new Map<string, TaskInfo>();
    for (const t of this.plan.tasks) {
      taskMap.set(t.id, {
        id: t.id,
        type: t.type,
        description: t.description,
        dependsOn: [...t.dependsOn],
        contextHints:
          t.contextHints && Object.keys(t.contextHints).length > 0
            ? { ...t.contextHints }
            : {},
      });
    }

    // Drop tasks
    for (const taskId of mutation.dropTaskIds) {
      taskMap.delete(taskId);
      delete this.taskStatuses[taskId];
    }

    // Update tasks
    for (const task of mutation.updateTasks) {
      const info = taskMap.get(task.id);
      if (info) {
        info.description = task.description;
        info.contextHints =
          task.contextHints && Object.keys(task.contextHints).length > 0
            ? { ...task.contextHints }
            : {};
        if (!this.isTaskCompleted(task.id)) {
          info.dependsOn = [...task.dependsOn];
        }
      }
    }

    // Add new tasks
    for (const task of mutation.addTasks) {
      taskMap.set(task.id, {
        id: task.id,
        type: task.type,
        description: task.description,
        dependsOn: [...task.dependsOn],
        contextHints:
          task.contextHints && Object.keys(task.contextHints).length > 0
            ? { ...task.contextHints }
            : {},
      });
      // Initialize status for new tasks
      this.taskStatuses[task.id] = "pending";
    }

    // Reorder edges
    for (const [taskId, newDeps] of Object.entries(mutation.reorderEdges)) {
      const info = taskMap.get(taskId);
      if (info && !this.isTaskCompleted(taskId)) {
        info.dependsOn = [...newDeps];
      }
    }

    // Reconstruct tasks list, preserving original order for existing tasks
    const preservedOrder = this.plan.tasks
      .map((t) => t.id)
      .filter((id) => taskMap.has(id));
    const newTaskIds = mutation.addTasks.map((t) => t.id);
    const orderedIds = [
      ...preservedOrder,
      ...newTaskIds.filter((tid) => !preservedOrder.includes(tid)),
    ];

    const newTasks: Task[] = [];
    for (const tid of orderedIds) {
      const info = taskMap.get(tid)!;
      newTasks.push(
        createTask({
          id: info.id,
          type: info.type,
          description: info.description,
          dependsOn: info.dependsOn,
          contextHints: info.contextHints,
        }),
      );
    }

    // --- Validate: dependency acyclicity ---
    const depGraph = new Map<string, Set<string>>();
    for (const t of newTasks) {
      depGraph.set(t.id, new Set(t.dependsOn));
    }
    const cycleErrors = WorkflowState.checkDag(depGraph);
    if (cycleErrors.length > 0) {
      return cycleErrors;
    }

    // --- Validate: no dangling dependencies ---
    const allIds = new Set(newTasks.map((t) => t.id));
    for (const t of newTasks) {
      for (const dep of t.dependsOn) {
        if (!allIds.has(dep)) {
          errors.push(
            `task '${t.id}' depends on non-existent task '${dep}'`,
          );
        }
      }
    }

    if (errors.length > 0) {
      return errors;
    }

    // Apply
    this.plan = createExecutionPlan({
      tasks: newTasks,
      goal: this.plan.goal,
      reasoning: this.plan.reasoning
        ? `${this.plan.reasoning} | replan: ${mutation.reasoning}`
        : mutation.reasoning,
    });
    this.progress.recordPlanMutation();
    return [];
  }

  // ------------------------------------------------------------------
  // DAG validation (static)
  // ------------------------------------------------------------------

  /**
   * Check that the dependency graph is a DAG (no cycles).
   *
   * Uses DFS with three-color marking (WHITE / GRAY / BLACK).
   *
   * @param depGraph - Map of node → set of its dependencies.
   * @returns Array of cycle description strings (empty = valid DAG).
   */
  static checkDag(depGraph: Map<string, Set<string>>): string[] {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;

    const color = new Map<string, number>();
    for (const node of depGraph.keys()) {
      color.set(node, WHITE);
    }

    const cycles: string[] = [];

    function dfs(node: string, path: string[]): void {
      color.set(node, GRAY);
      path.push(node);

      const deps = depGraph.get(node) ?? new Set<string>();
      for (const dep of deps) {
        if (!color.has(dep)) {
          // Dependency on a node not in the graph — skip
          continue;
        }
        const depColor = color.get(dep)!;
        if (depColor === GRAY) {
          const cycleStart = path.indexOf(dep);
          const cycle = path.slice(cycleStart).concat(dep);
          cycles.push(cycle.join(" → "));
        } else if (depColor === WHITE) {
          dfs(dep, path);
        }
      }

      path.pop();
      color.set(node, BLACK);
    }

    for (const node of depGraph.keys()) {
      if (color.get(node) === WHITE) {
        dfs(node, []);
      }
    }

    return cycles.map((c) => `dependency cycle detected: ${c}`);
  }
}

// ---------------------------------------------------------------------------
// Backward-compatible alias
// ---------------------------------------------------------------------------

/**
 * Backward-compatible alias.
 * Use `WorkflowState` for new code.
 */
export type MultiAgentState = WorkflowState;
