/**
 * 阶段感知的审查调度器 — 用于编排控制平面。
 *
 * 源自 reqdesign/orchestration/review_scheduler.py。
 */

import type { OrchestratorSnapshot } from "./snapshot.js";

// ---------------------------------------------------------------------------
// ReviewPlan
// ---------------------------------------------------------------------------

export interface ReviewPlan {
  scopeTaskIds: string[];
  stage: string;
  reason: string;
  hasScope: boolean;
}

// ---------------------------------------------------------------------------
// ReviewScheduler
// ---------------------------------------------------------------------------

export class ReviewScheduler {
  /** 审查阶段的边界顺序。 */
  static readonly STAGE_ORDER: readonly string[] = [
    "analyze",
    "design",
    "output",
    "direct",
  ];

  /** 在阶段边界处选择下一个审查范围。 */
  nextScope(snapshot: OrchestratorSnapshot): ReviewPlan {
    const noScope: ReviewPlan = {
      scopeTaskIds: [],
      stage: "",
      reason: "no unevaluated artifacts",
      hasScope: false,
    };

    if (snapshot.unevaluatedArtifacts.length === 0) {
      return noScope;
    }

    const unevaluated = new Set(snapshot.unevaluatedArtifacts);

    // -- 直连模式 -------------------------------------------------------
    if (snapshot.isDirectMode) {
      const directScope = snapshot.directModeArtifacts.filter((tid) =>
        unevaluated.has(tid),
      );
      if (
        directScope.length > 0 &&
        ReviewScheduler._allCompleted(snapshot, snapshot.directModeArtifacts)
      ) {
        return {
          scopeTaskIds: directScope,
          stage: "direct",
          reason: "direct artifacts are ready for batch review",
          hasScope: true,
        };
      }
      return { ...noScope, reason: "direct stage is not complete" };
    }

    // -- 无计划 —— 机会性审查 ------------------------------------
    if (!snapshot.planReady) {
      const candidateIds =
        snapshot.reviewCandidates.length > 0
          ? snapshot.reviewCandidates
          : snapshot.artifactTaskIds;
      const scope = candidateIds.filter((tid) => unevaluated.has(tid)).sort();
      if (scope.length > 0) {
        return {
          scopeTaskIds: scope,
          stage: "unplanned",
          reason: "unplanned artifacts have new revisions ready for review",
          hasScope: true,
        };
      }
      return { ...noScope, reason: "no plan stage is available for review" };
    }

    const stageTasks = snapshot.planTaskIdsByType;

    // -- 分析阶段 -----------------------------------------------------
    const analyzeScope = (stageTasks["analyze"] ?? []).filter((tid) =>
      unevaluated.has(tid),
    );
    if (
      analyzeScope.length > 0 &&
      ReviewScheduler._allCompleted(snapshot, stageTasks["analyze"] ?? [])
    ) {
      return {
        scopeTaskIds: analyzeScope,
        stage: "analyze",
        reason: "analyze stage is complete",
        hasScope: true,
      };
    }

    // -- 设计阶段 ------------------------------------------------------
    const designScope = (stageTasks["design"] ?? []).filter((tid) =>
      unevaluated.has(tid),
    );
    if (
      designScope.length > 0 &&
      ReviewScheduler._allCompleted(snapshot, stageTasks["design"] ?? [])
    ) {
      return {
        scopeTaskIds: designScope,
        stage: "design",
        reason: "design stage is complete",
        hasScope: true,
      };
    }

    // -- 输出阶段（图表 + 测试） -----------------------------------
    const outputTaskIds = [
      ...(stageTasks["diagrams"] ?? []),
      ...(stageTasks["tests"] ?? []),
    ];
    const outputScope = outputTaskIds
      .filter((tid) => unevaluated.has(tid))
      .sort();
    if (
      outputScope.length > 0 &&
      ReviewScheduler._allCompleted(snapshot, outputTaskIds)
    ) {
      return {
        scopeTaskIds: outputScope,
        stage: "output",
        reason: "output stage is complete",
        hasScope: true,
      };
    }

    return { ...noScope, reason: "no review stage boundary is ready" };
  }

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

  /** 所有给定的任务 ID 均存在于已完成集合中。 */
  private static _allCompleted(
    snapshot: OrchestratorSnapshot,
    taskIds: string[],
  ): boolean {
    if (taskIds.length === 0) return false;
    const completed = new Set(snapshot.completedPlanTasks);
    if (taskIds.every((tid) => tid.startsWith("direct_"))) {
      for (const tid of snapshot.artifactTaskIds) {
        completed.add(tid);
      }
    }
    return taskIds.every((tid) => completed.has(tid));
  }
}
