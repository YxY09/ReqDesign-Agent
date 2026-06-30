/**
 * 编排配置 + BudgetManager — 运行时可调的限制。
 */

import { parseOrchestrationConfig, type OrchestrationConfig as ParsedOrchestrationConfig } from "../config.js";
import type { OrchestratorSnapshot } from "./snapshot.js";

export interface OrchestrationConfigRaw {
  max_repair_per_task?: number;
  diagram_repair_before_regenerate?: number;
  design_repair_before_regenerate?: number;
  max_regenerate_per_task?: number;
  max_replan_count?: number;
  max_runtime_seconds?: number;
  max_decision_count?: number;
  max_planner_failures?: number;
  max_evaluator_timeouts?: number;
  max_save_failures?: number;
  max_final_major_issues?: number;
  max_final_major_repair_per_task?: number;
  max_concurrent_evaluators?: number;
  min_runtime_remaining_for_new_work_seconds?: number;
  skip_evaluation?: boolean;
  worker_timeout_seconds?: number;
  poll_interval_ms?: number;
  heartbeat_interval_seconds?: number;
  max_concurrency?: number;
  convergence_accept_max_issues_decreasing?: number;
  convergence_accept_max_issues_flat?: number;
  max_convergence_rounds?: number;
}

export class OrchestrationConfig implements ParsedOrchestrationConfig {
  maxRepairPerTask!: number;
  diagramRepairBeforeRegenerate!: number;
  designRepairBeforeRegenerate!: number;
  maxRegeneratePerTask!: number;
  maxReplanCount!: number;
  maxRuntimeSeconds!: number;
  maxDecisionCount!: number;
  maxPlannerFailures!: number;
  maxEvaluatorTimeouts!: number;
  maxSaveFailures!: number;
  maxFinalMajorIssues!: number;
  maxFinalMajorRepairPerTask!: number;
  maxConcurrentEvaluators!: number;
  minRuntimeRemainingForNewWorkSeconds!: number;
  skipEvaluation!: boolean;
  workerTimeoutSeconds!: number;
  pollIntervalMs!: number;
  heartbeatIntervalSeconds!: number;
  maxConcurrency!: number;
  convergenceAcceptMaxIssuesDecreasing!: number;
  convergenceAcceptMaxIssuesFlat!: number;
  maxConvergenceRounds!: number;

  constructor(init?: Partial<ParsedOrchestrationConfig>) {
    Object.assign(this, parseOrchestrationConfig(init ?? {}));
  }

  static fromRaw(raw: OrchestrationConfigRaw | Record<string, unknown>): OrchestrationConfig {
    return new OrchestrationConfig(parseOrchestrationConfig(raw));
  }
}

// ---------------------------------------------------------------------------
// BudgetManager
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// BudgetManager
// ---------------------------------------------------------------------------

export class BudgetManager {
  maxRepairPerTask: number;
  diagramRepairBeforeRegenerate: number;
  designRepairBeforeRegenerate: number;
  maxRegeneratePerTask: number;
  maxReplanCount: number;
  maxRuntimeSeconds: number;
  maxDecisionCount: number;
  maxPlannerFailures: number;
  maxEvaluatorTimeouts: number;
  maxSaveFailures: number;
  maxFinalMajorIssues: number;
  maxFinalMajorRepairPerTask: number;
  maxConcurrentEvaluators: number;
  minRuntimeRemainingForNewWorkSeconds: number;
  skipEvaluation: boolean;
  workerTimeoutSeconds: number;
  pollIntervalMs: number;
  heartbeatIntervalSeconds: number;
  maxConcurrency: number;
  convergenceAcceptMaxIssuesDecreasing: number;
  convergenceAcceptMaxIssuesFlat: number;
  maxConvergenceRounds: number;

  constructor(config?: OrchestrationConfig) {
    const c = config ?? new OrchestrationConfig();
    this.maxRepairPerTask = c.maxRepairPerTask;
    this.diagramRepairBeforeRegenerate = c.diagramRepairBeforeRegenerate;
    this.designRepairBeforeRegenerate = c.designRepairBeforeRegenerate;
    this.maxRegeneratePerTask = c.maxRegeneratePerTask;
    this.maxReplanCount = c.maxReplanCount;
    this.maxRuntimeSeconds = c.maxRuntimeSeconds;
    this.maxDecisionCount = c.maxDecisionCount;
    this.maxPlannerFailures = c.maxPlannerFailures;
    this.maxEvaluatorTimeouts = c.maxEvaluatorTimeouts;
    this.maxSaveFailures = c.maxSaveFailures;
    this.maxFinalMajorIssues = c.maxFinalMajorIssues;
    this.maxFinalMajorRepairPerTask = c.maxFinalMajorRepairPerTask;
    this.maxConcurrentEvaluators = c.maxConcurrentEvaluators;
    this.minRuntimeRemainingForNewWorkSeconds =
      c.minRuntimeRemainingForNewWorkSeconds;
    this.skipEvaluation = c.skipEvaluation;
    this.workerTimeoutSeconds = c.workerTimeoutSeconds;
    this.pollIntervalMs = c.pollIntervalMs;
    this.heartbeatIntervalSeconds = c.heartbeatIntervalSeconds;
    this.maxConcurrency = c.maxConcurrency;
    this.convergenceAcceptMaxIssuesDecreasing = c.convergenceAcceptMaxIssuesDecreasing;
    this.convergenceAcceptMaxIssuesFlat = c.convergenceAcceptMaxIssuesFlat;
    this.maxConvergenceRounds = c.maxConvergenceRounds;
  }

  runtimeDeadline(startTime: number): number {
    return startTime + this.maxRuntimeSeconds;
  }

  runtimeExhausted(startTime: number, now?: number): boolean {
    return (now ?? Date.now() / 1000) >= this.runtimeDeadline(startTime);
  }

  runtimeRemainingSeconds(startTime: number, now?: number): number {
    return Math.max(0, this.runtimeDeadline(startTime) - (now ?? Date.now() / 1000));
  }

  hasRuntimeBudgetForNewWork(startTime: number, now?: number): boolean {
    return (
      this.runtimeRemainingSeconds(startTime, now) >=
      this.minRuntimeRemainingForNewWorkSeconds
    );
  }

  minRuntimeForTaskType(taskType: string): number {
    if (taskType === "analyze") return 600;
    if (taskType === "domain_model") return 300;
    if (taskType === "design") return 360;
    if (taskType === "diagrams" || taskType === "tests") return 240;
    return this.minRuntimeRemainingForNewWorkSeconds;
  }

  hasRuntimeBudgetForTaskType(
    startTime: number,
    taskType: string,
    now?: number,
  ): boolean {
    return this.runtimeRemainingSeconds(startTime, now) >=
      this.minRuntimeForTaskType(taskType);
  }

  decisionExhausted(decisionCount: number): boolean {
    return decisionCount >= this.maxDecisionCount;
  }

  /** 收敛轮数是否已耗尽，保证收敛路径必然终止。 */
  convergenceRoundsExhausted(roundCount: number): boolean {
    return roundCount >= this.maxConvergenceRounds;
  }

  repairCount(snapshot: OrchestratorSnapshot, taskId: string): number {
    return snapshot.repairCountsByTask[taskId] ?? 0;
  }

  regenerateCount(snapshot: OrchestratorSnapshot, taskId: string): number {
    return snapshot.regenerateCountsByTask[taskId] ?? 0;
  }

  taskType(snapshot: OrchestratorSnapshot, taskId: string): string {
    return (
      snapshot.artifactTypesByTask[taskId] ??
      snapshot.planTaskTypesById[taskId] ??
      ""
    );
  }

  canRepair(snapshot: OrchestratorSnapshot, taskId: string): boolean {
    return this.repairCount(snapshot, taskId) < this.maxRepairPerTask;
  }

  canRepairFinalMajor(snapshot: OrchestratorSnapshot, taskId: string): boolean {
    return this.repairCount(snapshot, taskId) < this.maxFinalMajorRepairPerTask;
  }

  shouldRegenerate(snapshot: OrchestratorSnapshot, taskId: string): boolean {
    const taskType = this.taskType(snapshot, taskId);
    const repairCount = this.repairCount(snapshot, taskId);
    const regenerateCount = this.regenerateCount(snapshot, taskId);
    if (regenerateCount >= this.maxRegeneratePerTask) return false;
    if (taskType === "diagrams") {
      return repairCount >= this.diagramRepairBeforeRegenerate;
    }
    if (taskType === "design") {
      return repairCount >= this.designRepairBeforeRegenerate;
    }
    return false;
  }

  canReplan(snapshot: OrchestratorSnapshot): boolean {
    return (
      snapshot.planReady &&
      !snapshot.isDirectMode &&
      snapshot.runningTasks.length === 0 &&
      !snapshot.evaluatorRunning &&
      snapshot.plannerFailures < this.maxPlannerFailures &&
      snapshot.planRevisionCount < this.maxReplanCount
    );
  }

  /**
   * True if a replan would be permitted once all currently-running tasks have
   * settled (i.e., same as canReplan but ignoring the "no running tasks" gate).
   * Used to decide whether waiting for running tasks can ever unblock a replan.
   */
  canReplanWhenIdle(snapshot: OrchestratorSnapshot): boolean {
    return (
      snapshot.planReady &&
      !snapshot.isDirectMode &&
      snapshot.plannerFailures < this.maxPlannerFailures &&
      snapshot.planRevisionCount < this.maxReplanCount
    );
  }
}
