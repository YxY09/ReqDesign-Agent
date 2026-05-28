// ---------------------------------------------------------------------------
// Status union types
// ---------------------------------------------------------------------------

/** Valid run status values for WorkflowState. */
export type RunStatus = "running" | "completed" | "partial" | "failed" | "paused";

/** Valid quality status values for WorkflowState. */
export type QualityStatus = "unknown" | "passed" | "rejected";

/** Valid persist status values for WorkflowState. */
export type PersistStatus = "not_saved" | "final_saved" | "partial_saved";

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
  type TaskType,
  type Verdict,
} from "./shared/types.js";
import type { SectionIndex } from "./xmlParser.js";
import { ProgressSnapshot } from "./progress.js";
import { ConvergenceTracker } from "./orchestration/snapshot.js";
import { TaskLifecycleManager } from "./runtime/TaskLifecycleManager.js";
import { PlanMutator } from "./runtime/PlanMutator.js";
import { ArtifactManager } from "./runtime/ArtifactManager.js";
import { ReviewManager } from "./runtime/ReviewManager.js";

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
  sectionIndex: SectionIndex[] = [];

  // --- Registry ------------------------------------------------------------
  registry: import("./shared/types.js").EntityRegistry | null = null;

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
  runStatus: RunStatus = "running";
  /** unknown | passed | rejected */
  qualityStatus: QualityStatus = "unknown";
  /** not_saved | final_saved | partial_saved */
  persistStatus: PersistStatus = "not_saved";
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
  _lastArtifactContents: Record<string, unknown> = {};
  latestArtifactTaskByType: Record<string, string> = {};
  diagramSourcesByKey: Record<string, string> = {};
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

  private readonly _taskLifecycleManager: TaskLifecycleManager;
  private readonly _planMutator: PlanMutator;
  private readonly _artifactManager: ArtifactManager;
  private readonly _reviewManager: ReviewManager;
  private readonly _artifactsStateView: ArtifactsState;
  private readonly _executionStateView: ExecutionState;
  private readonly _reviewStateView: ReviewState;

  constructor() {
    this._taskLifecycleManager = new TaskLifecycleManager(this);
    this._planMutator = new PlanMutator(this);
    this._artifactManager = new ArtifactManager(this, () => this.majorPendingTaskIds.clear());
    this._reviewManager = new ReviewManager(this);
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
        this.runStatus = value as RunStatus;
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
  // Artifact management (delegated to ArtifactManager)
  // ------------------------------------------------------------------

  addArtifact(artifact: Artifact): void {
    return this._artifactManager.addArtifact(artifact);
  }

  // ------------------------------------------------------------------
  // Verdict management (delegated to ReviewManager)
  // ------------------------------------------------------------------

  addVerdict(verdict: Verdict): void {
    return this._reviewManager.addVerdict(verdict);
  }

  // ------------------------------------------------------------------
  // Notification history (delegated to TaskLifecycleManager)
  // ------------------------------------------------------------------

  recordNotification(notif: Record<string, unknown>): void {
    return this._taskLifecycleManager.recordNotification(notif);
  }

  recordRepairAttempt(taskId: string): void {
    return this._taskLifecycleManager.recordRepairAttempt(taskId);
  }

  recordRegenerateAttempt(taskId: string): void {
    return this._taskLifecycleManager.recordRegenerateAttempt(taskId);
  }

  recordPlannerFailure(): void {
    return this._taskLifecycleManager.recordPlannerFailure();
  }

  // ------------------------------------------------------------------
  // Task lifecycle (delegated to TaskLifecycleManager)
  // ------------------------------------------------------------------

  markTaskStatus(taskId: string, status: string, sessionId: string = "", details?: Record<string, unknown> | null): void {
    return this._taskLifecycleManager.markTaskStatus(taskId, status, sessionId, details);
  }

  taskStatus(taskId: string): string {
    return this._taskLifecycleManager.taskStatus(taskId);
  }

  isTaskCompleted(taskId: string): boolean {
    return this._taskLifecycleManager.isTaskCompleted(taskId);
  }

  isTaskRunning(taskId: string): boolean {
    return this._taskLifecycleManager.isTaskRunning(taskId);
  }

  getCompletedTaskIds(): string[] {
    return this._taskLifecycleManager.getCompletedTaskIds();
  }

  getRunningTaskIds(): string[] {
    return this._taskLifecycleManager.getRunningTaskIds();
  }

  getFailedTaskIds(): string[] {
    return this._taskLifecycleManager.getFailedTaskIds();
  }

  getPlanTaskIds(): string[] {
    return this._taskLifecycleManager.getPlanTaskIds();
  }

  getCompletedPlanTaskIds(): string[] {
    return this._taskLifecycleManager.getCompletedPlanTaskIds();
  }

  getReadyTaskIds(): string[] {
    return this._taskLifecycleManager.getReadyTaskIds();
  }

  getPendingTaskIds(): string[] {
    return this._taskLifecycleManager.getPendingTaskIds();
  }

  getBlockedTaskIds(): string[] {
    return this._taskLifecycleManager.getBlockedTaskIds();
  }

  // ------------------------------------------------------------------
  // Derived properties (delegated to ReviewManager where applicable)
  // ------------------------------------------------------------------

  get latestVerdict(): Verdict | null {
    return this._reviewManager.latestVerdict;
  }

  // --- Artifact-derived properties (delegated to ArtifactManager) ---

  get totalArtifacts(): number {
    return this._artifactManager.totalArtifacts;
  }

  artifactSummary(): Record<string, Record<string, unknown>> {
    return this._artifactManager.artifactSummary();
  }

  artifactSnapshots(taskIds?: string[]): Record<string, Record<string, unknown>> {
    return this._artifactManager.artifactSnapshots(taskIds);
  }

  finalArtifactSnapshots(): Record<string, Record<string, unknown>> {
    return this._artifactManager.finalArtifactSnapshots();
  }

  latestArtifactTaskIdOfType(type: string): string {
    return this._artifactManager.latestArtifactTaskIdOfType(type);
  }

  diagramSourceTaskId(diagramKey: string): string {
    return this._artifactManager.diagramSourceTaskId(diagramKey);
  }

  currentArtifactRevision(taskId: string): number {
    return this._artifactManager.currentArtifactRevision(taskId);
  }

  latestEvaluatedRevision(taskId: string): number {
    return this._reviewManager.latestEvaluatedRevision(taskId);
  }

  currentReviewStatus(taskId: string): string {
    return this._reviewManager.currentReviewStatus(taskId);
  }

  isCurrentArtifactAccepted(taskId: string): boolean {
    return this._reviewManager.isCurrentArtifactAccepted(taskId);
  }

  getUnevaluatedArtifactTaskIds(): string[] {
    return this._reviewManager.getUnevaluatedArtifactTaskIds();
  }

  getRejectedArtifactTaskIds(): string[] {
    return this._reviewManager.getRejectedArtifactTaskIds();
  }

  getUnacceptedArtifactTaskIds(): string[] {
    return this._reviewManager.getUnacceptedArtifactTaskIds();
  }

  getMajorPendingTaskIds(): string[] {
    return this._reviewManager.getMajorPendingTaskIds();
  }

  clearMajorPending(): void {
    return this._reviewManager.clearMajorPending();
  }

  hasArtifactOfType(taskType: string): boolean {
    return this._artifactManager.hasArtifactOfType(taskType);
  }

  getArtifactsByType(taskType: string): Artifact[] {
    return this._artifactManager.getArtifactsByType(taskType);
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

  // ------------------------------------------------------------------
  // Plan mutation (delegated to PlanMutator)
  // ------------------------------------------------------------------

  setPlan(plan: ExecutionPlan): void {
    return this._planMutator.setPlan(plan);
  }

  setRequirementJson(json: Record<string, unknown>): void {
    return this._planMutator.setRequirementJson(json);
  }

  setQualityStatus(status: QualityStatus): void {
    return this._planMutator.setQualityStatus(status);
  }

  getTaskById(taskId: string): {
    id: string;
    type: TaskType;
    description: string;
    dependsOn: string[];
    contextHints: Record<string, unknown>;
  } | null {
    return this._planMutator.getTaskById(taskId);
  }

  mutatePlan(mutation: PlanMutation): string[] {
    return this._planMutator.mutatePlan(mutation);
  }

  static checkDag(depGraph: Map<string, Set<string>>): string[] {
    return PlanMutator.checkDag(depGraph);
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
