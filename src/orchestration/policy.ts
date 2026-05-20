/**
 * Deterministic engineering policy for obvious orchestration states.
 *
 * Ported from reqdesign/orchestration/policy.py.
 */

import { BudgetManager } from "./budget.js";
import { PolicyGuard } from "./gates.js";
import { ReviewScheduler } from "./reviewScheduler.js";
import type { OrchestratorSnapshot } from "./snapshot.js";
import { type StrategyDecision, createStrategyDecision } from "./strategy.js";

function isTaskRunning(snapshot: OrchestratorSnapshot, taskId: string): boolean {
  return taskId !== "" && snapshot.runningTasks.includes(taskId);
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
      if (!this._isSafeFinalMajorRepairTarget(snapshot, target)) continue;
      return target;
    }
    return "";
  }

  private _isSafeFinalMajorRepairTarget(
    snapshot: OrchestratorSnapshot,
    target: string,
  ): boolean {
    const taskType = this.budget.taskType(snapshot, target);

    const targetIssues = snapshot.latestIssues.filter(
      (issue) => issue["target_task_id"] === target,
    );
    const majorIssues = targetIssues.filter(
      (issue) => issue["severity"] === "major",
    );
    if (majorIssues.length === 0) return false;

    // Allow analyze repair for local issues, skip upstream/systemic.
    if (taskType === "analyze") {
      const hasLocal = majorIssues.some((issue) => {
        const scope = String(issue["scope"] ?? "");
        return scope !== "upstream" && scope !== "systemic";
      });
      return hasLocal;
    }

    // Allow repair if at least one major issue is local (repairable).
    // Upstream/systemic issues are skipped — they require replan, not repair.
    const hasLocalIssue = majorIssues.some((issue) => {
      const scope = String(issue["scope"] ?? "");
      if (scope === "upstream" || scope === "systemic") return false;
      const targetType = String(issue["target_task_type"] ?? "");
      return !targetType || !taskType || targetType === taskType;
    });
    return hasLocalIssue;
  }
}
