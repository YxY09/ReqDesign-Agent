/**
 * Policy guards for strategy-level orchestration decisions.
 *
 * Ported from reqdesign/orchestration/gates.py.
 */

import { BudgetManager } from "./budget.js";
import type { OrchestratorSnapshot } from "./snapshot.js";
import { ReviewScheduler } from "./reviewScheduler.js";
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
    // Ensure budget uses class-level defaults if nothing was provided
    if (!budget) {
      this.budget.maxRepairPerTask = PolicyGuard.MAX_REPAIR_PER_TASK;
      this.budget.maxReplanCount = PolicyGuard.MAX_REPLAN_COUNT;
    }
    this.reviewScheduler = new ReviewScheduler();
  }

  /** Validate or downgrade a strategy before action compilation. */
  validate(
    decision: StrategyDecision,
    snapshot: OrchestratorSnapshot,
  ): StrategyDecision {
    const strategy = decision.strategy;

    // -- save / finish gates -----------------------------------------------
    if (strategy === "save_outputs" || strategy === "finish") {
      if (snapshot.outputSaved && strategy === "finish") {
        return decision;
      }
      if (
        strategy === "finish" &&
        !snapshot.requirementLoaded &&
        !snapshot.hasArtifacts &&
        !snapshot.planReady
      ) {
        return decision;
      }
      if (this.canSave(snapshot)) {
        return decision;
      }
      return this._nextSafeStrategy(snapshot, "save gate is not satisfied");
    }

    // -- replan gate -------------------------------------------------------
    if (strategy === "escalate_to_replan") {
      if (this.canReplan(snapshot)) {
        return decision;
      }
      return this._nextSafeStrategy(snapshot, "replan gate is not satisfied");
    }

    // -- regenerate gate ---------------------------------------------------
    if (strategy === "regenerate_downstream") {
      const target =
        decision.targetTaskId ||
        (decision.affectedTaskIds.length > 0
          ? decision.affectedTaskIds[0]
          : "");
      if (target && this.budget.shouldRegenerate(snapshot, target)) {
        decision.targetTaskId = target;
        decision.affectedTaskIds = [target];
        return decision;
      }
      return this._nextSafeStrategy(
        snapshot,
        "regenerate gate is not satisfied",
      );
    }

    // -- repair gate -------------------------------------------------------
    if (
      strategy === "repair_local_artifact" ||
      strategy === "repair_upstream_artifact"
    ) {
      let target =
        decision.targetTaskId ||
        (snapshot.rejectedArtifacts.length > 0
          ? snapshot.rejectedArtifacts[0]
          : snapshot.majorPendingTaskIds.length > 0
            ? snapshot.majorPendingTaskIds[0]
            : "");
      if (target && this.budget.shouldRegenerate(snapshot, target)) {
        const taskType = this.budget.taskType(snapshot, target);
        return createStrategyDecision({
          strategy: "regenerate_downstream",
          targetTaskId: target,
          affectedTaskIds: [target],
          reason: `${taskType || "artifact"} repair budget reached for ${target}; regenerate instead`,
        });
      }
      if (target && isTaskRunning(snapshot, target)) {
        return createStrategyDecision({
          strategy: "wait_for_running",
          targetTaskId: target,
          reason: `${target} repair is already running`,
        });
      }
      if (
        target &&
        snapshot.finalReviewCurrent &&
        snapshot.majorPendingTaskIds.includes(target)
      ) {
        if (
          this.budget.canRepairFinalMajor(snapshot, target) &&
          this._isSafeFinalMajorRepairTarget(snapshot, target)
        ) {
          decision.targetTaskId = target;
          return decision;
        }
        if (this.canReplan(snapshot)) {
          return createStrategyDecision({
            strategy: "escalate_to_replan",
            reason: `final review major issues are not safe for local repair in ${target}`,
          });
        }
        return this._nextSafeStrategy(snapshot, "final review repair gate is not satisfied");
      }
      if (target && this.budget.canRepair(snapshot, target)) {
        decision.targetTaskId = target;
        return decision;
      }
      if (this.canReplan(snapshot)) {
        return createStrategyDecision({
          strategy: "escalate_to_replan",
          reason: `repair budget exhausted for ${target}`,
        });
      }
      return this._nextSafeStrategy(snapshot, "repair gate is not satisfied");
    }

    // -- final review gate -------------------------------------------------
    if (strategy === "run_final_review") {
      if (this.canRunFinalReview(snapshot)) {
        return decision;
      }
      return this._nextSafeStrategy(snapshot, "final review gate is not ready");
    }

    // -- direct routing gate -----------------------------------------------
    if (strategy === "route_direct_diagrams") {
      if (
        snapshot.requirementLoaded &&
        !snapshot.planReady &&
        !snapshot.hasArtifacts &&
        snapshot.runningTasks.length === 0
      ) {
        return decision;
      }
      return this._nextSafeStrategy(
        snapshot,
        "direct routing gate is not satisfied",
      );
    }

    return decision;
  }

  // -------------------------------------------------------------------
  // Gate predicates
  // -------------------------------------------------------------------

  canSave(snapshot: OrchestratorSnapshot): boolean {
    if (snapshot.outputSaved) return false;
    if (snapshot.runningTasks.length > 0 || snapshot.evaluatorRunning)
      return false;
    if (snapshot.planReady && !snapshot.planAllCompleted) return false;
    if (snapshot.unacceptedArtifacts.length > 0) return false;
    if (!(snapshot.finalReviewCurrent && snapshot.finalReviewPassed))
      return false;
    const finalMajorCount = snapshot.latestIssues.filter(
      (issue) => issue["severity"] === "major",
    ).length;
    return finalMajorCount <= this.budget.maxFinalMajorIssues;
  }

  canReplan(snapshot: OrchestratorSnapshot): boolean {
    return this.budget.canReplan(snapshot);
  }

  canRunFinalReview(snapshot: OrchestratorSnapshot): boolean {
    if (snapshot.evaluatorRunning || snapshot.runningTasks.length > 0)
      return false;
    if (!snapshot.hasArtifacts) return false;
    if (!snapshot.planReady) return false;
    if (snapshot.planReady && !snapshot.planAllCompleted) return false;
    if (snapshot.rejectedArtifacts.length > 0) return false;
    return !snapshot.finalReviewCurrent;
  }

  // -------------------------------------------------------------------
  // Fallback strategy chain
  // -------------------------------------------------------------------

  private _nextSafeStrategy(
    snapshot: OrchestratorSnapshot,
    reason: string,
  ): StrategyDecision {
    // A) Rejected artifacts — try repair, then replan
    if (snapshot.rejectedArtifacts.length > 0) {
      const target = snapshot.rejectedArtifacts[0];
      if (this.budget.shouldRegenerate(snapshot, target)) {
        return createStrategyDecision({
          strategy: "regenerate_downstream",
          targetTaskId: target,
          affectedTaskIds: [target],
          reason,
        });
      }
      if (!this.budget.canRepair(snapshot, target)) {
        if (this.canReplan(snapshot)) {
          return createStrategyDecision({
            strategy: "escalate_to_replan",
            reason,
          });
        }
        return createStrategyDecision({
          strategy: "pause_for_user",
          targetTaskId: target,
          reason,
        });
      }
      return createStrategyDecision({
        strategy: "repair_local_artifact",
        targetTaskId: target,
        reason,
      });
    }

    // B) Final review major issues — try repair, then replan
    if (
      snapshot.finalReviewCurrent &&
      snapshot.majorPendingTaskIds.length > 0
    ) {
      for (const target of snapshot.majorPendingTaskIds) {
        if (isTaskRunning(snapshot, target)) {
          continue;
        }
        if (
          this.budget.canRepairFinalMajor(snapshot, target) &&
          this._isSafeFinalMajorRepairTarget(snapshot, target)
        ) {
          return createStrategyDecision({
            strategy: "repair_local_artifact",
            targetTaskId: target,
            reason,
          });
        }
      }
      const runningTarget = snapshot.majorPendingTaskIds.find((taskId) =>
        isTaskRunning(snapshot, taskId),
      );
      if (runningTarget) {
        return createStrategyDecision({
          strategy: "wait_for_running",
          targetTaskId: runningTarget,
          reason,
        });
      }
      if (this.canReplan(snapshot)) {
        return createStrategyDecision({
          strategy: "escalate_to_replan",
          reason,
        });
      }
      return createStrategyDecision({
        strategy: "pause_for_user",
        targetTaskId: snapshot.majorPendingTaskIds[0],
        reason,
      });
    }

    // C) Ready tasks — advance work
    if (snapshot.readyTasks.length > 0) {
      return createStrategyDecision({
        strategy: "advance_ready_work",
        reason,
      });
    }

    // D) Run final review if possible
    if (this.canRunFinalReview(snapshot)) {
      return createStrategyDecision({
        strategy: "run_final_review",
        reason,
      });
    }

    // E) Opportunistic review
    const reviewPlan = this.reviewScheduler.nextScope(snapshot);
    if (reviewPlan.hasScope && !snapshot.evaluatorRunning) {
      return createStrategyDecision({
        strategy: "run_opportunistic_review",
        affectedTaskIds: [...reviewPlan.scopeTaskIds],
        reason,
      });
    }

    // F) Already saved — finish
    if (snapshot.outputSaved) {
      return createStrategyDecision({ strategy: "finish", reason });
    }

    // G) Pause
    return createStrategyDecision({
      strategy: "pause_for_user",
      reason,
    });
  }

  private _isSafeFinalMajorRepairTarget(
    snapshot: OrchestratorSnapshot,
    target: string,
  ): boolean {
    const taskType =
      snapshot.artifactTypesByTask[target] ??
      snapshot.planTaskTypesById[target] ??
      "";
    if (taskType === "analyze") return false;

    const targetIssues = snapshot.latestIssues.filter(
      (issue) => issue["target_task_id"] === target,
    );
    const majorIssues = targetIssues.filter(
      (issue) => issue["severity"] === "major",
    );
    if (majorIssues.length === 0) return false;

    return majorIssues.every((issue) => {
      const scope = String(issue["scope"] ?? "");
      if (scope === "upstream" || scope === "systemic") return false;
      const targetType = String(issue["target_task_type"] ?? "");
      return !targetType || !taskType || targetType === taskType;
    });
  }
}
