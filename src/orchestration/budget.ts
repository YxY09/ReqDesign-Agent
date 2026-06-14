/**
 * 编排配置 + BudgetManager — 运行时可调的限制。
 */

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
}

export class OrchestrationConfig {
  maxRepairPerTask = 4;
  diagramRepairBeforeRegenerate = 2;
  designRepairBeforeRegenerate = 2;
  maxRegeneratePerTask = 1;
  maxReplanCount = 2;
  maxRuntimeSeconds = 1800;
  maxDecisionCount = 500;
  maxPlannerFailures = 3;
  maxEvaluatorTimeouts = 3;
  maxSaveFailures = 3;
  maxFinalMajorIssues = 3;
  maxFinalMajorRepairPerTask = 3;
  maxConcurrentEvaluators = 2;
  minRuntimeRemainingForNewWorkSeconds = 120;
  skipEvaluation = false;
  /** 单个 worker 会话的执行超时（秒）。 */
  workerTimeoutSeconds = 900;
  /** 主循环空转时的轮询间隔（毫秒）。 */
  pollIntervalMs = 20;
  /** 会话心跳间隔（秒）。 */
  heartbeatIntervalSeconds = 0.25;
  /** worker 最大并发数（环境变量 MAX_CONCURRENCY 优先）。 */
  maxConcurrency = 5;
  /** 收敛卡死但问题数下降时，强制接受的问题数上限。 */
  convergenceAcceptMaxIssuesDecreasing = 8;
  /** 收敛卡死且趋势非上升时，强制接受的问题数上限。 */
  convergenceAcceptMaxIssuesFlat = 10;

  /** snake_case raw key → camelCase config key pairs. */
  private static readonly RAW_TO_CFG: ReadonlyArray<
    [keyof OrchestrationConfigRaw, keyof OrchestrationConfig]
  > = [
    ["max_repair_per_task", "maxRepairPerTask"],
    ["diagram_repair_before_regenerate", "diagramRepairBeforeRegenerate"],
    ["design_repair_before_regenerate", "designRepairBeforeRegenerate"],
    ["max_regenerate_per_task", "maxRegeneratePerTask"],
    ["max_replan_count", "maxReplanCount"],
    ["max_runtime_seconds", "maxRuntimeSeconds"],
    ["max_decision_count", "maxDecisionCount"],
    ["max_planner_failures", "maxPlannerFailures"],
    ["max_evaluator_timeouts", "maxEvaluatorTimeouts"],
    ["max_save_failures", "maxSaveFailures"],
    ["max_final_major_issues", "maxFinalMajorIssues"],
    ["max_final_major_repair_per_task", "maxFinalMajorRepairPerTask"],
    ["max_concurrent_evaluators", "maxConcurrentEvaluators"],
    ["min_runtime_remaining_for_new_work_seconds", "minRuntimeRemainingForNewWorkSeconds"],
    ["skip_evaluation", "skipEvaluation"],
    ["worker_timeout_seconds", "workerTimeoutSeconds"],
    ["poll_interval_ms", "pollIntervalMs"],
    ["heartbeat_interval_seconds", "heartbeatIntervalSeconds"],
    ["max_concurrency", "maxConcurrency"],
    ["convergence_accept_max_issues_decreasing", "convergenceAcceptMaxIssuesDecreasing"],
    ["convergence_accept_max_issues_flat", "convergenceAcceptMaxIssuesFlat"],
  ];

  static fromRaw(raw: OrchestrationConfigRaw): OrchestrationConfig {
    const cfg = new OrchestrationConfig();
    for (const [rawKey, cfgKey] of OrchestrationConfig.RAW_TO_CFG) {
      const v = raw[rawKey];
      if (v !== undefined) (cfg as unknown as Record<string, unknown>)[cfgKey] = v;
    }
    return cfg;
  }
}

// ---------------------------------------------------------------------------
// BudgetManager
// ---------------------------------------------------------------------------

import type { OrchestratorSnapshot } from "./snapshot.js";

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
  minRuntimeRemainingForNewWorkSeconds: number;
  skipEvaluation: boolean;
  workerTimeoutSeconds: number;
  pollIntervalMs: number;
  heartbeatIntervalSeconds: number;
  maxConcurrency: number;
  convergenceAcceptMaxIssuesDecreasing: number;
  convergenceAcceptMaxIssuesFlat: number;

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
    this.minRuntimeRemainingForNewWorkSeconds =
      c.minRuntimeRemainingForNewWorkSeconds;
    this.skipEvaluation = c.skipEvaluation;
    this.workerTimeoutSeconds = c.workerTimeoutSeconds;
    this.pollIntervalMs = c.pollIntervalMs;
    this.heartbeatIntervalSeconds = c.heartbeatIntervalSeconds;
    this.maxConcurrency = c.maxConcurrency;
    this.convergenceAcceptMaxIssuesDecreasing = c.convergenceAcceptMaxIssuesDecreasing;
    this.convergenceAcceptMaxIssuesFlat = c.convergenceAcceptMaxIssuesFlat;
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
