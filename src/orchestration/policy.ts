/**
 * 确定性工程策略 — 针对明显编排状态的工程化策略。
 *
 * 源自 reqdesign/orchestration/policy.py。
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

  // PolicyGuard 和 DeterministicPolicy 共享的方法
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

  constructor(guard?: PolicyGuard) {
    this.guard = guard ?? new PolicyGuard();
    this.budget = this.guard.budget;
    this.reviewScheduler = new ReviewScheduler();
  }

  /**
   * 为不需要 LLM 判断的状态返回策略。
   *
   * 当状态需要 LLM 推理时返回 `null`——此时调用方应咨询 {@link StrategyBrain}。
   */
  decide(snapshot: OrchestratorSnapshot): StrategyDecision | null {
    // 1) 重规划产生了就绪的修复任务 -> 推进它们
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

    // 2) 计划任务失败 —— 在重新规划更广泛的下游工作之前，先重新生成具体失败的任务。
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
        if (snapshot.runningTasks.length > 0 || snapshot.evaluatorRunning) {
          return createStrategyDecision({
            strategy: "wait_for_running",
            targetTaskId: target,
            reason: `${target} failed after regeneration budget was exhausted, but workflow work is still running`,
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

    // 3) 被拒绝的产物 —— 修复、重新生成或重新规划
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

    // 4) 全局卡死且可以重新规划
    if (snapshot.globallyStalled && this.guard.canReplan(snapshot)) {
      return createStrategyDecision({
        strategy: "escalate_to_replan",
        reason: "workflow is globally stalled",
      });
    }

    // 5) 收敛卡死 —— 同样的问题在多轮中持续存在。
    //    但如果问题呈下降趋势且低于阈值，则接受。
    if (snapshot.convergenceStalled && snapshot.convergenceRoundCount >= 3) {
      const trend = snapshot.convergenceTrend ?? "flat";
      if (trend === "decreasing" && snapshot.latestIssues.length <= 8) {
        // 问题正在下降且可控 —— 强制接受以避免无限循环
        return createStrategyDecision({
          strategy: "finish",
          reason: `convergence accepted despite stall: ${snapshot.latestIssues.length} issues, trend decreasing`,
        });
      }
      // 如果问题数量持平或下降且数量少也接受 —— 评估器过于严格，
      // 不要在无法解决的表面问题上浪费 token。
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

    // 6) 最终审查被拒绝 —— 没有安全的修复目标
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

    // 7) 最终审查发现重大问题 —— 尝试按任务修复
    // 即使 finalReviewCurrent 为 false 也会触发：如果评估器发现了重大问题，
    // 我们应该在重新运行评估之前尝试修复。
    // 当 skipEvaluation 为 true 时跳过（无评估 → 无重大问题）。
    if (!this.budget.skipEvaluation && snapshot.majorPendingTaskIds.length > 0) {
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

    // 8) 当前最终审查被拒绝，但没有安全的自动修复方案。
    //    当 skipEvaluation 为 true 时跳过。
    if (!this.budget.skipEvaluation && snapshot.finalReviewCurrent && !snapshot.finalReviewPassed) {
      return createStrategyDecision({
        strategy: "pause_for_user",
        reason: "final review rejected and no automatic repair target remains",
      });
    }

    // 9) 输出已保存 -> 完成
    if (snapshot.outputSaved) {
      return createStrategyDecision({
        strategy: "finish",
        reason: "outputs already saved",
      });
    }

    // 10) 工作仍在运行 -> 等待
    if (snapshot.runningTasks.length > 0 || snapshot.evaluatorRunning) {
      return createStrategyDecision({
        strategy: "wait_for_running",
        reason: "work is still running",
      });
    }

    // 11) 尚未有计划 -> 将初始路由委托给 LLM (StrategyBrain)
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
      // 让 StrategyBrain 决定：start_planning 还是 route_direct_diagrams
      return null;
    }

    // 12) 就绪任务在等待 -> 推进它们
    if (snapshot.readyTasks.length > 0) {
      return createStrategyDecision({
        strategy: "advance_ready_work",
        affectedTaskIds: [...snapshot.readyTasks],
        reason: `${snapshot.readyTasks.length} task(s) are ready`,
      });
    }

    // 13) 最终审查已就绪
    //    当 skipEvaluation 为 true 时跳过（canRunFinalReview 始终返回 false）。
    if (!this.budget.skipEvaluation && this.guard.canRunFinalReview(snapshot)) {
      return createStrategyDecision({
        strategy: "run_final_review",
        reason: "final full review is required",
      });
    }

    // 14) 机会性审查
    //    当 skipEvaluation 为 true 时跳过。
    if (!this.budget.skipEvaluation) {
      const reviewPlan = this.reviewScheduler.nextScope(snapshot);
      if (reviewPlan.hasScope) {
        return createStrategyDecision({
          strategy: "run_opportunistic_review",
          affectedTaskIds: [...reviewPlan.scopeTaskIds],
          reason: reviewPlan.reason,
        });
      }
    }

    // 15) 质量门和保存门都已通过
    if (this.guard.canSave(snapshot)) {
      return createStrategyDecision({
        strategy: "save_outputs",
        reason: "quality and save gates passed",
      });
    }

    // 16) 没有加载任何内容 -> 完成
    if (!snapshot.requirementLoaded && !snapshot.hasArtifacts) {
      return createStrategyDecision({
        strategy: "finish",
        reason: "nothing has been loaded",
      });
    }

    // 需要 LLM 判断
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
