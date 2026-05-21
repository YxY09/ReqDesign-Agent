/**
 * Deterministic engineering policy for obvious orchestration states.
 *
 * Ported from reqdesign/orchestration/policy.py.
 */

import { BudgetManager } from "./budget.js";
import { ReviewScheduler } from "./reviewScheduler.js";
import type { OrchestratorSnapshot } from "./snapshot.js";
import { type StrategyDecision, createStrategyDecision } from "./strategy.js";

function isTaskRunning(snapshot: OrchestratorSnapshot, taskId: string): boolean {
  return taskId !== "" && snapshot.runningTasks.includes(taskId);
}

// ---------------------------------------------------------------------------
// PolicyGuard
// ---------------------------------------------------------------------------

export class PolicyGuard {
  readonly budget: BudgetManager;
  readonly reviewScheduler: ReviewScheduler;

  static readonly MAX_REPAIR_PER_TASK = 4;
  static readonly MAX_REPLAN_COUNT = 2;

  constructor(budget?: BudgetManager) {
    this.budget = budget ?? new BudgetManager(undefined);
    if (!budget) {
      this.budget.maxRepairPerTask = PolicyGuard.MAX_REPAIR_PER_TASK;
      this.budget.maxReplanCount = PolicyGuard.MAX_REPLAN_COUNT;
    }
    this.reviewScheduler = new ReviewScheduler();
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
    if (!(snapshot.finalReviewCurrent && snapshot.finalReviewPassed)) return false;
    const finalMajorCount = snapshot.latestIssues.filter((issue) => issue["severity"] === "major").length;
    return finalMajorCount <= this.budget.maxFinalMajorIssues;
  }

  canReplan(snapshot: OrchestratorSnapshot): boolean {
    return this.budget.canReplan(snapshot);
  }

  canRunFinalReview(snapshot: OrchestratorSnapshot): boolean {
    if (snapshot.evaluatorRunning || snapshot.runningTasks.length > 0) return false;
    if (!snapshot.hasArtifacts) return false;
    if (!snapshot.planReady) return false;
    if (snapshot.planReady && !snapshot.planAllCompleted) return false;
    if (snapshot.rejectedArtifacts.length > 0) return false;
    return !snapshot.finalReviewCurrent;
  }

  // Shared by both PolicyGuard and DeterministicPolicy
  _isSafeFinalMajorRepairTarget(snapshot: OrchestratorSnapshot, target: string): boolean {
    const taskType = this.budget.taskType(snapshot, target);
    const targetIssues = snapshot.latestIssues.filter((issue) => issue["target_task_id"] === target);
    const majorIssues = targetIssues.filter((issue) => issue["severity"] === "major");
    if (majorIssues.length === 0) return false;

    if (taskType === "analyze") {
      const hasLocal = majorIssues.some((issue) => {
        const scope = String(issue["scope"] ?? "");
        return scope !== "upstream" && scope !== "systemic";
      });
      return hasLocal;
    }

    const hasLocalIssue = majorIssues.some((issue) => {
      const scope = String(issue["scope"] ?? "");
      if (scope === "upstream" || scope === "systemic") return false;
      const targetType = String(issue["target_task_type"] ?? "");
      return !targetType || !taskType || targetType === taskType;
    });
    return hasLocalIssue;
  }

  private _nextSafeStrategy(snapshot: OrchestratorSnapshot, reason: string): StrategyDecision {
    if (snapshot.rejectedArtifacts.length > 0) {
      const target = snapshot.rejectedArtifacts[0];
      if (this.budget.shouldRegenerate(snapshot, target)) {
        return createStrategyDecision({ strategy: "regenerate_downstream", targetTaskId: target, affectedTaskIds: [target], reason });
      }
      if (!this.budget.canRepair(snapshot, target)) {
        if (this.canReplan(snapshot)) return createStrategyDecision({ strategy: "escalate_to_replan", reason });
        return createStrategyDecision({ strategy: "pause_for_user", targetTaskId: target, reason });
      }
      return createStrategyDecision({ strategy: "repair_local_artifact", targetTaskId: target, reason });
    }

    if (snapshot.finalReviewCurrent && snapshot.majorPendingTaskIds.length > 0) {
      for (const target of snapshot.majorPendingTaskIds) {
        if (isTaskRunning(snapshot, target)) continue;
        if (this.budget.canRepairFinalMajor(snapshot, target) && this._isSafeFinalMajorRepairTarget(snapshot, target)) {
          return createStrategyDecision({ strategy: "repair_local_artifact", targetTaskId: target, reason });
        }
      }
      const runningTarget = snapshot.majorPendingTaskIds.find((taskId) => isTaskRunning(snapshot, taskId));
      if (runningTarget) return createStrategyDecision({ strategy: "wait_for_running", targetTaskId: runningTarget, reason });
      if (this.canReplan(snapshot)) return createStrategyDecision({ strategy: "escalate_to_replan", reason });
      return createStrategyDecision({ strategy: "pause_for_user", targetTaskId: snapshot.majorPendingTaskIds[0], reason });
    }

    if (snapshot.readyTasks.length > 0) return createStrategyDecision({ strategy: "advance_ready_work", reason });
    if (this.canRunFinalReview(snapshot)) return createStrategyDecision({ strategy: "run_final_review", reason });

    const reviewPlan = this.reviewScheduler.nextScope(snapshot);
    if (reviewPlan.hasScope && !snapshot.evaluatorRunning) {
      return createStrategyDecision({ strategy: "run_opportunistic_review", affectedTaskIds: [...reviewPlan.scopeTaskIds], reason });
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

  constructor(guard?: PolicyGuard) {
    this.guard = guard ?? new PolicyGuard();
    this.budget = this.guard.budget;
    this.reviewScheduler = new ReviewScheduler();
  }

  /**
   * Return a strategy for states that do not need LLM judgment.
   *
   * Returns `null` when the state requires LLM reasoning — the caller
   * should then consult {@link StrategyBrain}.
   */
  decide(snapshot: OrchestratorSnapshot): StrategyDecision | null {
    // 1) Replan produced ready remediation tasks → advance them
    const remediationReady = snapshot.readyTasks.filter(
      (taskId) => !snapshot.rejectedArtifacts.includes(taskId),
    );
    if (snapshot.planRevisionCount > 0 && remediationReady.length > 0) {
      return createStrategyDecision({
        strategy: "advance_ready_work",
        affectedTaskIds: remediationReady,
        reason: "replan produced ready remediation task(s)",
      });
    }

    // 2) Failed plan tasks — regenerate the concrete failed task before
    // replanning broader downstream work.
    if (snapshot.failedTasks.length > 0) {
      const target = snapshot.failedTasks.find(
        (taskId) => !isTaskRunning(snapshot, taskId),
      );
      if (!target) {
        return createStrategyDecision({
          strategy: "wait_for_running",
          targetTaskId: snapshot.failedTasks[0],
          reason: `${snapshot.failedTasks[0]} is already running`,
        });
      }
      if (
        (snapshot.regenerateCountsByTask[target] ?? 0) >=
        this.budget.maxRegeneratePerTask
      ) {
        if (this.guard.canReplan(snapshot)) {
          return createStrategyDecision({
            strategy: "escalate_to_replan",
            targetTaskId: target,
            reason: `${target} failed after regeneration budget was exhausted`,
          });
        }
        return createStrategyDecision({
          strategy: "pause_for_user",
          targetTaskId: target,
          reason: `${target} failed and regeneration/replan budget is exhausted`,
        });
      }
      return createStrategyDecision({
        strategy: "regenerate_downstream",
        targetTaskId: target,
        affectedTaskIds: [target],
        reason: `${target} failed; regenerate the failed task before changing the plan`,
      });
    }

    // 3) Rejected artifacts — repair, regenerate, or replan
    if (snapshot.rejectedArtifacts.length > 0) {
      const target = snapshot.rejectedArtifacts.find(
        (taskId) => !isTaskRunning(snapshot, taskId),
      );
      if (!target) {
        return createStrategyDecision({
          strategy: "wait_for_running",
          targetTaskId: snapshot.rejectedArtifacts[0],
          reason: `${snapshot.rejectedArtifacts[0]} repair is already running`,
        });
      }
      if (this.budget.shouldRegenerate(snapshot, target)) {
        const taskType = this.budget.taskType(snapshot, target);
        return createStrategyDecision({
          strategy: "regenerate_downstream",
          targetTaskId: target,
          affectedTaskIds: [target],
          reason: `${target} is a ${taskType || "artifact"} artifact after repeated repair; regenerate`,
        });
      }
      if (
        snapshot.stalledTaskIds.includes(target) ||
        !this.budget.canRepair(snapshot, target)
      ) {
        if (this.guard.canReplan(snapshot)) {
          return createStrategyDecision({
            strategy: "escalate_to_replan",
            targetTaskId: target,
            reason: `${target} is stalled or exhausted repair budget`,
          });
        }
        return createStrategyDecision({
          strategy: "pause_for_user",
          targetTaskId: target,
          reason: `${target} cannot be repaired safely and replan budget is exhausted`,
        });
      }
      return createStrategyDecision({
        strategy: "repair_local_artifact",
        targetTaskId: target,
        reason: `current artifact revision is rejected: ${target}`,
      });
    }

    // 4) Globally stalled and replan is available
    if (snapshot.globallyStalled && this.guard.canReplan(snapshot)) {
      return createStrategyDecision({
        strategy: "escalate_to_replan",
        reason: "workflow is globally stalled",
      });
    }

    // 5) Convergence stall — same issues persist across rounds.
    //    But if issues are trending down and below threshold, accept.
    if (snapshot.convergenceStalled && snapshot.convergenceRoundCount >= 3) {
      const trend = snapshot.convergenceTrend ?? "flat";
      if (trend === "decreasing" && snapshot.latestIssues.length <= 8) {
        // Issues are declining and manageable — force accept to avoid infinite loop
        return createStrategyDecision({
          strategy: "finish",
          reason: `convergence accepted despite stall: ${snapshot.latestIssues.length} issues, trend decreasing`,
        });
      }
      // Also accept if non-increasing + low count — evaluator is strict,
      // don't waste tokens on cosmetic issues that can't be resolved.
      if (trend !== "increasing" && snapshot.latestIssues.length <= 10) {
        return createStrategyDecision({
          strategy: "finish",
          reason: `convergence accepted: ${snapshot.latestIssues.length} issues, trend ${trend}, low enough`,
        });
      }
      return createStrategyDecision({
        strategy: "pause_for_user",
        reason: `convergence stalled: ${snapshot.convergenceStalledFingerprints.length} issue(s) unchanged across ${snapshot.convergenceRoundCount} rounds`,
      });
    }

    // 6) Final review rejected — no safe repair targets
    if (
      snapshot.finalReviewCurrent &&
      !snapshot.finalReviewPassed &&
      snapshot.majorPendingTaskIds.length === 0 &&
      snapshot.rejectedArtifacts.length === 0 &&
      snapshot.runningTasks.length === 0 &&
      !snapshot.evaluatorRunning
    ) {
      return createStrategyDecision({
        strategy: "pause_for_user",
        reason: "final review rejected but no repairable targets (issues are in analyze tasks or non-repairable scope)",
      });
    }

    // 7) Final review major issues — try repair per-task
    // Fire even if finalReviewCurrent is false: if evaluator found major issues,
    // we should attempt repair before re-running evaluation.
    if (snapshot.majorPendingTaskIds.length > 0) {
      const target = this._selectFinalMajorRepairTarget(snapshot);
      if (target) {
        return createStrategyDecision({
          strategy: "repair_local_artifact",
          targetTaskId: target,
          reason: `final review found local major issues in ${target}`,
        });
      }
      const runningTarget = snapshot.majorPendingTaskIds.find((taskId) =>
        isTaskRunning(snapshot, taskId),
      );
      if (runningTarget) {
        return createStrategyDecision({
          strategy: "wait_for_running",
          targetTaskId: runningTarget,
          reason: `final review repair is already running for ${runningTarget}`,
        });
      }
      if (snapshot.runningTasks.length > 0 || snapshot.evaluatorRunning) {
        return createStrategyDecision({
          strategy: "wait_for_running",
          reason: "final review major issues remain, but workflow work is still running",
        });
      }
      if (this.guard.canReplan(snapshot)) {
        return createStrategyDecision({
          strategy: "escalate_to_replan",
          reason: "final review major issues exceeded repair budget",
        });
      }
      return createStrategyDecision({
        strategy: "pause_for_user",
        targetTaskId: snapshot.majorPendingTaskIds[0],
        reason:
          "final review major issues remain but repair/replan budget is exhausted",
      });
    }

    // 8) Current final review rejected but there is no safe automatic repair.
    if (snapshot.finalReviewCurrent && !snapshot.finalReviewPassed) {
      return createStrategyDecision({
        strategy: "pause_for_user",
        reason: "final review rejected and no automatic repair target remains",
      });
    }

    // 9) Outputs already saved → finish
    if (snapshot.outputSaved) {
      return createStrategyDecision({
        strategy: "finish",
        reason: "outputs already saved",
      });
    }

    // 10) Work is still running → wait
    if (snapshot.runningTasks.length > 0 || snapshot.evaluatorRunning) {
      return createStrategyDecision({
        strategy: "wait_for_running",
        reason: "work is still running",
      });
    }

    // 11) No plan yet → delegate initial routing to LLM (StrategyBrain)
    if (
      !snapshot.planReady &&
      snapshot.requirementLoaded &&
      !snapshot.hasArtifacts
    ) {
      if (snapshot.plannerFailures >= 3) {
        return createStrategyDecision({
          strategy: "pause_for_user",
          reason: `planner failed ${snapshot.plannerFailures} times`,
        });
      }
      // Let StrategyBrain decide: start_planning vs route_direct_diagrams
      return null;
    }

    // 12) Ready tasks waiting → advance them
    if (snapshot.readyTasks.length > 0) {
      return createStrategyDecision({
        strategy: "advance_ready_work",
        affectedTaskIds: [...snapshot.readyTasks],
        reason: `${snapshot.readyTasks.length} task(s) are ready`,
      });
    }

    // 13) Final review is ready
    if (this.guard.canRunFinalReview(snapshot)) {
      return createStrategyDecision({
        strategy: "run_final_review",
        reason: "final full review is required",
      });
    }

    // 14) Opportunistic review
    const reviewPlan = this.reviewScheduler.nextScope(snapshot);
    if (reviewPlan.hasScope) {
      return createStrategyDecision({
        strategy: "run_opportunistic_review",
        affectedTaskIds: [...reviewPlan.scopeTaskIds],
        reason: reviewPlan.reason,
      });
    }

    // 15) Quality + save gates passed
    if (this.guard.canSave(snapshot)) {
      return createStrategyDecision({
        strategy: "save_outputs",
        reason: "quality and save gates passed",
      });
    }

    // 16) Nothing loaded → finish
    if (!snapshot.requirementLoaded && !snapshot.hasArtifacts) {
      return createStrategyDecision({
        strategy: "finish",
        reason: "nothing has been loaded",
      });
    }

    // Requires LLM judgment
    return null;
  }

  private _selectFinalMajorRepairTarget(
    snapshot: OrchestratorSnapshot,
  ): string {
    for (const target of snapshot.majorPendingTaskIds) {
      if (isTaskRunning(snapshot, target)) continue;
      if (!this.budget.canRepairFinalMajor(snapshot, target)) continue;
      if (!this.guard._isSafeFinalMajorRepairTarget(snapshot, target)) continue;
      return target;
    }
    return "";
  }
}
