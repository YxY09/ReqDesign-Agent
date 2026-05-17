/**
 * BudgetManager — centralized bounded-loop policy for repair, regenerate, replan, and runtime.
 *
 * Ported from reqdesign/orchestration/budget.py.
 */

import { OrchestrationConfig } from "./config.js";
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
  }

  runtimeDeadline(startTime: number): number {
    return startTime + this.maxRuntimeSeconds;
  }

  runtimeExhausted(startTime: number, now?: number): boolean {
    return (now ?? Date.now() / 1000) >= this.runtimeDeadline(startTime);
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
      snapshot.planRevisionCount < this.maxReplanCount
    );
  }
}
