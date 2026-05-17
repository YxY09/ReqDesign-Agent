/**
 * Stage-aware review scheduling for the orchestration control plane.
 *
 * Ported from reqdesign/orchestration/review_scheduler.py.
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
  /** Stage boundaries in review order. */
  static readonly STAGE_ORDER: readonly string[] = [
    "analyze",
    "design",
    "output",
    "direct",
  ];

  /** Choose the next review scope at stage boundaries. */
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

    // -- Direct mode -------------------------------------------------------
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

    // -- No plan — opportunistic review ------------------------------------
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

    // -- Analyze stage -----------------------------------------------------
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

    // -- Design stage ------------------------------------------------------
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

    // -- Output stage (diagrams + tests) -----------------------------------
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

  /** All given task IDs are present in the completed set. */
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
