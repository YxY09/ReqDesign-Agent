/**
 * Orchestration configuration + BudgetManager — runtime-tunable limits.
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

  static fromRaw(raw: OrchestrationConfigRaw): OrchestrationConfig {
    const cfg = new OrchestrationConfig();
    if (raw.max_repair_per_task !== undefined) cfg.maxRepairPerTask = raw.max_repair_per_task;
    if (raw.diagram_repair_before_regenerate !== undefined) cfg.diagramRepairBeforeRegenerate = raw.diagram_repair_before_regenerate;
    if (raw.design_repair_before_regenerate !== undefined) cfg.designRepairBeforeRegenerate = raw.design_repair_before_regenerate;
    if (raw.max_regenerate_per_task !== undefined) cfg.maxRegeneratePerTask = raw.max_regenerate_per_task;
    if (raw.max_replan_count !== undefined) cfg.maxReplanCount = raw.max_replan_count;
    if (raw.max_runtime_seconds !== undefined) cfg.maxRuntimeSeconds = raw.max_runtime_seconds;
    if (raw.max_decision_count !== undefined) cfg.maxDecisionCount = raw.max_decision_count;
    if (raw.max_planner_failures !== undefined) cfg.maxPlannerFailures = raw.max_planner_failures;
    if (raw.max_evaluator_timeouts !== undefined) cfg.maxEvaluatorTimeouts = raw.max_evaluator_timeouts;
    if (raw.max_save_failures !== undefined) cfg.maxSaveFailures = raw.max_save_failures;
    if (raw.max_final_major_issues !== undefined) cfg.maxFinalMajorIssues = raw.max_final_major_issues;
    if (raw.max_final_major_repair_per_task !== undefined) cfg.maxFinalMajorRepairPerTask = raw.max_final_major_repair_per_task;
    if (raw.max_concurrent_evaluators !== undefined) cfg.maxConcurrentEvaluators = raw.max_concurrent_evaluators;
    if (raw.min_runtime_remaining_for_new_work_seconds !== undefined) cfg.minRuntimeRemainingForNewWorkSeconds = raw.min_runtime_remaining_for_new_work_seconds;
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
}
