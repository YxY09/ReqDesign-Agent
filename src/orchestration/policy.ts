/**
 * 确定性工程策略 — 针对明显编排状态的工程化策略。
 *
 * 源自 reqdesign/orchestration/policy.py。
 */

import { BudgetManager } from "./budget.js";
import { RemediationLadder, isTaskRunning } from "./remediation.js";
import { ReviewScheduler } from "./reviewScheduler.js";
import type { OrchestratorSnapshot } from "./snapshot.js";
import { type StrategyDecision, createStrategyDecision } from "./strategy.js";
import { POLICY_RULES } from "./policyRules.js";

// ---------------------------------------------------------------------------
// PolicyGuard
// ---------------------------------------------------------------------------

export class PolicyGuard {
  readonly budget: BudgetManager;
  readonly reviewScheduler: ReviewScheduler;
  readonly ladder: RemediationLadder;

  static readonly MAX_REPAIR_PER_TASK = 4;
  static readonly MAX_REPLAN_COUNT = 2;

  constructor(budget?: BudgetManager) {
    this.budget = budget ?? new BudgetManager(undefined);
    if (!budget) {
      this.budget.maxRepairPerTask = PolicyGuard.MAX_REPAIR_PER_TASK;
      this.budget.maxReplanCount = PolicyGuard.MAX_REPLAN_COUNT;
    }
    this.reviewScheduler = new ReviewScheduler();
    this.ladder = new RemediationLadder(this.budget);
  }

  validate(decision: StrategyDecision, snapshot: OrchestratorSnapshot): StrategyDecision {
    const strategy = decision.strategy;

    if (strategy === "save_outputs" || strategy === "finish") {
      if (snapshot.outputSaved && strategy === "finish") return decision;
      if (strategy === "finish" && !snapshot.requirementLoaded && !snapshot.hasArtifacts && !snapshot.planReady) return decision;
      if (this.canSave(snapshot)) return decision;
      return this._nextSafeStrategy(snapshot, "save gate is not satisfied");
    }

    if (strategy === "escalate_to_replan") {
      if (this.canReplan(snapshot)) return decision;
      return this._nextSafeStrategy(snapshot, "replan gate is not satisfied");
    }

    if (strategy === "regenerate_downstream") {
      const target = decision.targetTaskId || (decision.affectedTaskIds.length > 0 ? decision.affectedTaskIds[0] : "");
      if (target && ((snapshot.failedTasks.includes(target) && (snapshot.regenerateCountsByTask[target] ?? 0) < this.budget.maxRegeneratePerTask) || this.budget.shouldRegenerate(snapshot, target))) {
        decision.targetTaskId = target;
        decision.affectedTaskIds = [target];
        return decision;
      }
      return this._nextSafeStrategy(snapshot, "regenerate gate is not satisfied");
    }

    if (strategy === "repair_local_artifact" || strategy === "repair_upstream_artifact") {
      let target = decision.targetTaskId || (snapshot.rejectedArtifacts.length > 0 ? snapshot.rejectedArtifacts[0] : snapshot.majorPendingTaskIds.length > 0 ? snapshot.majorPendingTaskIds[0] : "");
      if (target && this.budget.shouldRegenerate(snapshot, target)) {
        const taskType = this.budget.taskType(snapshot, target);
        return createStrategyDecision({ strategy: "regenerate_downstream", targetTaskId: target, affectedTaskIds: [target], reason: `${taskType || "artifact"} repair budget reached for ${target}; regenerate instead` });
      }
      if (target && isTaskRunning(snapshot, target)) {
        return createStrategyDecision({ strategy: "wait_for_running", targetTaskId: target, reason: `${target} repair is already running` });
      }
      if (target && snapshot.finalReviewCurrent && snapshot.majorPendingTaskIds.includes(target)) {
        if (this.budget.canRepairFinalMajor(snapshot, target) && this._isSafeFinalMajorRepairTarget(snapshot, target)) {
          decision.targetTaskId = target;
          return decision;
        }
        if (this.canReplan(snapshot)) {
          return createStrategyDecision({ strategy: "escalate_to_replan", reason: `final review major issues are not safe for local repair in ${target}` });
        }
        return this._nextSafeStrategy(snapshot, "final review repair gate is not satisfied");
      }
      if (target && this.budget.canRepair(snapshot, target)) {
        decision.targetTaskId = target;
        return decision;
      }
      if (this.canReplan(snapshot)) {
        return createStrategyDecision({ strategy: "escalate_to_replan", reason: `repair budget exhausted for ${target}` });
      }
      return this._nextSafeStrategy(snapshot, "repair gate is not satisfied");
    }

    if (strategy === "run_final_review") {
      if (this.canRunFinalReview(snapshot)) return decision;
      return this._nextSafeStrategy(snapshot, "final review gate is not ready");
    }

    if (strategy === "route_direct_diagrams") {
      if (snapshot.requirementLoaded && !snapshot.planReady && !snapshot.hasArtifacts && snapshot.runningTasks.length === 0) return decision;
      return this._nextSafeStrategy(snapshot, "direct routing gate is not satisfied");
    }

    return decision;
  }

  canSave(snapshot: OrchestratorSnapshot): boolean {
    if (snapshot.outputSaved) return false;
    if (snapshot.runningTasks.length > 0 || snapshot.evaluatorRunning) return false;
    if (snapshot.planReady && !snapshot.planAllCompleted) return false;
    if (snapshot.unacceptedArtifacts.length > 0) return false;
    if (!this.budget.skipEvaluation && !snapshot.finalReviewCurrent) return false;
    if (snapshot.latestIssues.filter((issue) => issue["severity"] === "blocker").length > 0) return false;
    const finalMajorCount = snapshot.latestIssues.filter((issue) => issue["severity"] === "major").length;
    return finalMajorCount <= this.budget.maxFinalMajorIssues;
  }

  canReplan(snapshot: OrchestratorSnapshot): boolean {
    return this.budget.canReplan(snapshot);
  }

  canRunFinalReview(snapshot: OrchestratorSnapshot): boolean {
    if (this.budget.skipEvaluation) return false;
    if (snapshot.evaluatorRunning || snapshot.runningTasks.length > 0) return false;
    if (!snapshot.hasArtifacts) return false;
    if (!snapshot.planReady) return false;
    if (snapshot.planReady && !snapshot.planAllCompleted) return false;
    if (snapshot.rejectedArtifacts.length > 0) return false;
    return !snapshot.finalReviewCurrent;
  }

  // PolicyGuard 和 DeterministicPolicy 共享的方法（实现在 RemediationLadder）
  _isSafeFinalMajorRepairTarget(snapshot: OrchestratorSnapshot, target: string): boolean {
    return this.ladder.isSafeFinalMajorRepairTarget(snapshot, target);
  }

  private _nextSafeStrategy(snapshot: OrchestratorSnapshot, reason: string): StrategyDecision {
    const rejectedStep = this.ladder.rejectedArtifact(snapshot, reason);
    if (rejectedStep) return rejectedStep;

    if (snapshot.finalReviewCurrent) {
      const majorStep = this.ladder.finalMajor(snapshot, reason);
      if (majorStep) return majorStep;
    }

    if (snapshot.readyTasks.length > 0) return createStrategyDecision({ strategy: "advance_ready_work", reason });
    if (!this.budget.skipEvaluation && this.canRunFinalReview(snapshot)) return createStrategyDecision({ strategy: "run_final_review", reason });

    if (!this.budget.skipEvaluation) {
      const reviewPlan = this.reviewScheduler.nextScope(snapshot);
      if (reviewPlan.hasScope && !snapshot.evaluatorRunning) {
        return createStrategyDecision({ strategy: "run_opportunistic_review", affectedTaskIds: [...reviewPlan.scopeTaskIds], reason });
      }
    }

    if (snapshot.outputSaved) return createStrategyDecision({ strategy: "finish", reason });
    return createStrategyDecision({ strategy: "pause_for_user", reason });
  }
}

// ---------------------------------------------------------------------------
// DeterministicPolicy
// ---------------------------------------------------------------------------

export class DeterministicPolicy {
  readonly guard: PolicyGuard;
  readonly budget: BudgetManager;
  readonly reviewScheduler: ReviewScheduler;
  readonly ladder: RemediationLadder;

  constructor(guard?: PolicyGuard) {
    this.guard = guard ?? new PolicyGuard();
    this.budget = this.guard.budget;
    this.reviewScheduler = new ReviewScheduler();
    this.ladder = this.guard.ladder;
  }

  /**
   * 为不需要 LLM 判断的状态返回策略。
   *
   * 当状态需要 LLM 推理时返回 `null`——此时调用方应咨询 {@link StrategyBrain}。
   * 规则按顺序评估，第一个触发的胜出（见 policyRules.ts）。
   */
  decide(snapshot: OrchestratorSnapshot): StrategyDecision | null {
    for (const rule of POLICY_RULES) {
      const decision = rule(snapshot, this);
      if (decision !== null) return decision;
    }
    return null;
  }
}
