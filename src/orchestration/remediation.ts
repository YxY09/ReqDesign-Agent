/**
 * RemediationLadder — 统一的修复降级阶梯。
 *
 * 此前 DeterministicPolicy（主决策路径）和 PolicyGuard._nextSafeStrategy
 * （策略被否决后的兜底路径）各自实现了一套
 * regenerate → repair → replan → pause 的降级逻辑，细节存在出入
 * （兜底路径不跳过运行中的目标、不检查 stalled），随时间漂移的风险高。
 * 本模块是两条路径共享的唯一实现。
 */

import { BudgetManager } from "./budget.js";
import type { OrchestratorSnapshot } from "./snapshot.js";
import { createStrategyDecision, type StrategyDecision } from "./strategy.js";

export function isTaskRunning(
  snapshot: OrchestratorSnapshot,
  taskId: string,
): boolean {
  return taskId !== "" && snapshot.runningTasks.includes(taskId);
}

export class RemediationLadder {
  constructor(private readonly budget: BudgetManager) {}

  /**
   * final-major 问题是否能安全地本地修复。
   * scope 为 upstream/systemic 的问题不能在本产物内修掉；
   * analyze 之外的任务还要求 issue 的目标类型与任务类型一致。
   */
  isSafeFinalMajorRepairTarget(
    snapshot: OrchestratorSnapshot,
    target: string,
  ): boolean {
    const taskType = this.budget.taskType(snapshot, target);
    const targetIssues = snapshot.latestIssues.filter(
      (issue) => issue["target_task_id"] === target,
    );
    // Only verifiable DEFECTS are repair targets; advisory majors are recorded,
    // not repaired.
    const majorIssues = targetIssues.filter(
      (issue) => issue["severity"] === "major" && issue["kind"] === "defect",
    );
    if (majorIssues.length === 0) return false;

    if (taskType === "analyze") {
      return majorIssues.some((issue) => {
        const scope = String(issue["scope"] ?? "");
        return scope !== "upstream" && scope !== "systemic";
      });
    }

    return majorIssues.some((issue) => {
      const scope = String(issue["scope"] ?? "");
      if (scope === "upstream" || scope === "systemic") return false;
      const targetType = String(issue["target_task_type"] ?? "");
      return !targetType || !taskType || targetType === taskType;
    });
  }

  /**
   * 被拒产物的降级阶梯：
   * 运行中 → wait；修复多次 → regenerate；stalled/预算尽 → replan 或 pause；
   * 否则 → 本地修复。
   *
   * @param reason 覆盖默认 reason（兜底路径会传入否决原因）；空串使用默认描述。
   * @returns null 表示当前没有被拒产物需要处理。
   */
  rejectedArtifact(
    snapshot: OrchestratorSnapshot,
    reason = "",
  ): StrategyDecision | null {
    if (snapshot.rejectedArtifacts.length === 0) return null;

    const target = snapshot.rejectedArtifacts.find(
      (taskId) => !isTaskRunning(snapshot, taskId),
    );
    if (!target) {
      const first = snapshot.rejectedArtifacts[0];
      return createStrategyDecision({
        strategy: "wait_for_running",
        targetTaskId: first,
        reason: reason || `${first} repair is already running`,
      });
    }

    if (this.budget.shouldRegenerate(snapshot, target)) {
      const taskType = this.budget.taskType(snapshot, target);
      return createStrategyDecision({
        strategy: "regenerate_downstream",
        targetTaskId: target,
        affectedTaskIds: [target],
        reason:
          reason ||
          `${target} is a ${taskType || "artifact"} artifact after repeated repair; regenerate`,
      });
    }

    if (!this.budget.canRepair(snapshot, target)) {
      if (this.budget.canReplan(snapshot)) {
        return createStrategyDecision({
          strategy: "escalate_to_replan",
          targetTaskId: target,
          reason: reason || `${target} exhausted repair budget`,
        });
      }
      return createStrategyDecision({
        strategy: "pause_for_user",
        targetTaskId: target,
        reason:
          reason ||
          `${target} cannot be repaired safely and replan budget is exhausted`,
      });
    }

    return createStrategyDecision({
      strategy: "repair_local_artifact",
      targetTaskId: target,
      reason: reason || `current artifact revision is rejected: ${target}`,
    });
  }

  /**
   * final-major 问题的修复阶梯：
   * 有安全目标 → 本地修复；目标在跑 → wait；全局还有工作 → wait；
   * 预算允许 → replan；否则 → pause。
   *
   * @returns null 表示没有待处理的 major 问题。
   */
  finalMajor(
    snapshot: OrchestratorSnapshot,
    reason = "",
  ): StrategyDecision | null {
    if (snapshot.majorPendingTaskIds.length === 0) return null;

    for (const target of snapshot.majorPendingTaskIds) {
      if (isTaskRunning(snapshot, target)) continue;
      if (!this.budget.canRepairFinalMajor(snapshot, target)) continue;
      // Repair-effectiveness gate: if a prior repair of this task left the same
      // structural issue in place, repeating it is futile — skip so the ladder
      // falls through to accept (local) or pause (upstream/systemic).
      if (snapshot.repairFutileTaskIds.includes(target)) continue;
      if (!this.isSafeFinalMajorRepairTarget(snapshot, target)) continue;
      return createStrategyDecision({
        strategy: "repair_local_artifact",
        targetTaskId: target,
        reason: reason || `final review found local major issues in ${target}`,
      });
    }

    const runningTarget = snapshot.majorPendingTaskIds.find((taskId) =>
      isTaskRunning(snapshot, taskId),
    );
    if (runningTarget) {
      return createStrategyDecision({
        strategy: "wait_for_running",
        targetTaskId: runningTarget,
        reason:
          reason || `final review repair is already running for ${runningTarget}`,
      });
    }

    if (snapshot.runningTasks.length > 0 || snapshot.evaluatorRunning) {
      return createStrategyDecision({
        strategy: "wait_for_running",
        reason:
          reason ||
          "final review major issues remain, but workflow work is still running",
      });
    }

    // Upstream/systemic scope issues represent genuine plan-level problems
    // (e.g. missing modules, wrong decomposition). Replan if budget remains;
    // otherwise it is a structural defect we cannot fix automatically, so hand
    // it to the user rather than silently shipping a known-broken plan.
    const hasUpstreamMajor = snapshot.latestIssues.some((issue) => {
      const scope = String(issue["scope"] ?? "");
      return (
        (scope === "upstream" || scope === "systemic") &&
        issue["severity"] === "major" &&
        issue["kind"] === "defect"
      );
    });
    if (hasUpstreamMajor) {
      if (this.budget.canReplan(snapshot)) {
        return createStrategyDecision({
          strategy: "escalate_to_replan",
          targetTaskId: snapshot.majorPendingTaskIds[0],
          reason:
            reason ||
            "final review found upstream/systemic major issues that may benefit from replanning",
        });
      }
      return createStrategyDecision({
        strategy: "pause_for_user",
        targetTaskId: snapshot.majorPendingTaskIds[0],
        reason:
          reason ||
          "final review found upstream/systemic major issues but replan budget is exhausted",
      });
    }

    // Only local quality issues remain. A fresh plan with the same LLM produces
    // the same quality level, so accept the current output unless a blocker
    // defect is present (the artifact is unusable, not just imperfect).
    const hasBlocker = snapshot.latestIssues.some(
      (issue) => issue["severity"] === "blocker" && issue["kind"] === "defect",
    );
    if (!hasBlocker) {
      return createStrategyDecision({
        strategy: "finish",
        reason:
          reason ||
          `final review defects remain in ${snapshot.majorPendingTaskIds.length} task(s) but no further repair will help (budget exhausted or repair proved futile) and no blockers; accepting with annotation`,
      });
    }

    return createStrategyDecision({
      strategy: "pause_for_user",
      targetTaskId: snapshot.majorPendingTaskIds[0],
      reason:
        reason ||
        "final review has blockers and repair budget is exhausted",
    });
  }
}
