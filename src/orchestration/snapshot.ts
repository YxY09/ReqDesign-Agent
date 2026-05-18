/**
 * Stable state snapshots for top-level orchestration.
 *
 * Ported from reqdesign/orchestration/snapshot.py.
 */

import type { WorkflowState } from "../state.js";
import type { TaskMailbox } from "../messaging.js";

// Re-export for convenience
export { ConvergenceTracker } from "./convergence.js";

// ---------------------------------------------------------------------------
// OrchestratorSnapshot
// ---------------------------------------------------------------------------

/** Coordinator-facing scheduling snapshot (noise-reduced). */
export interface OrchestratorSnapshot {
  goal: string;
  requirementLoaded: boolean;
  requirementPreview: string;
  planReady: boolean;
  planTaskIdsByType: Record<string, string[]>;
  planTaskTypesById: Record<string, string>;
  readyTasks: string[];
  runningTasks: string[];
  failedTasks: string[];
  completedPlanTasks: string[];
  artifactTaskIds: string[];
  artifactTypesByTask: Record<string, string>;
  unacceptedArtifacts: string[];
  unevaluatedArtifacts: string[];
  rejectedArtifacts: string[];
  reviewCandidates: string[];
  latestIssues: Record<string, unknown>[];
  finalReviewDone: boolean;
  finalReviewPassed: boolean;
  finalReviewCurrent: boolean;
  outputSaved: boolean;
  isDirectMode: boolean;
  directModeArtifacts: string[];
  evaluatorRunning: boolean;
  plannerFailures: number;
  planRevisionCount: number;
  repairCountsByTask: Record<string, number>;
  regenerateCountsByTask: Record<string, number>;
  stalledTaskIds: string[];
  majorPendingTaskIds: string[];
  globallyStalled: boolean;
  recentErrors: string[];

  /** Computed: convergence state from evaluation history. */
  convergenceStalled: boolean;
  convergenceStalledFingerprints: string[];
  convergenceTrend: string;
  convergenceRoundCount: number;

  /** Computed: all plan tasks are completed. */
  planAllCompleted: boolean;
  /** Computed: at least one artifact exists. */
  hasArtifacts: boolean;
}

// ---------------------------------------------------------------------------
// StateReader
// ---------------------------------------------------------------------------

/** Build an orchestration snapshot from runtime state. */
export class StateReader {
  static fromState(
    state: WorkflowState,
    _mailbox: TaskMailbox,
  ): OrchestratorSnapshot {
    const artifactsState = state.artifactsState;
    const executionState = state.executionState;
    const reviewState = state.reviewState;
    const currentRevisions = StateReader._finalReviewRevisions(state);
    const finalCurrent =
      Object.keys(currentRevisions).length > 0 &&
      reviewState.finalReviewDone &&
      JSON.stringify(reviewState.finalReviewRevisions) ===
        JSON.stringify(currentRevisions);

    const latestIssues: Record<string, unknown>[] = [];
    if (reviewState.verdicts.length > 0) {
      for (const issue of reviewState.verdicts[reviewState.verdicts.length - 1].issues) {
      latestIssues.push({
          severity: issue.severity,
          target_task_id: issue.targetTaskId,
          target_task_type: issue.targetTaskType,
          target_field: issue.targetField,
          scope: issue.scope,
          description: issue.description,
        });
      }
    }

    const reviewCandidates = state
      .getCompletedTaskIds()
      .filter((taskId) =>
        state.getUnevaluatedArtifactTaskIds().includes(taskId),
      )
      .sort();

    const counters: Record<string, number> =
      state.progress._counters ?? {};

    const planTaskIdsByType: Record<string, string[]> = {};
    const planTaskTypesById: Record<string, string> = {};
    if (state.plan) {
      for (const task of state.plan.tasks) {
        const arr = planTaskIdsByType[task.type];
        if (arr) {
          arr.push(task.id);
        } else {
          planTaskIdsByType[task.type] = [task.id];
        }
        planTaskTypesById[task.id] = task.type;
      }
    }

    const artifactTypesByTask: Record<string, string> = {};
    for (const [taskId, artifact] of Object.entries(artifactsState.artifacts).sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      artifactTypesByTask[taskId] =
        artifact.type || planTaskTypesById[taskId] || "";
    }

    // Extract repair counts from counters
    const repairCountsByTask: Record<string, number> = {};
    const regenerateCountsByTask: Record<string, number> = {};
    for (const [key, val] of Object.entries(counters)) {
      if (key.startsWith("repair_count:")) {
        repairCountsByTask[key.slice("repair_count:".length)] = val;
      } else if (key.startsWith("regenerate_count:")) {
        regenerateCountsByTask[key.slice("regenerate_count:".length)] = val;
      }
    }

    const planTaskIds = state.getPlanTaskIds();
    const completedPlanTasks = state.getCompletedPlanTaskIds();

    return {
      goal: executionState.goal,
      requirementLoaded: Boolean((state.requirementText ?? "").trim()),
      requirementPreview: (state.requirementText ?? "").slice(0, 2000),
      planReady: Boolean(state.plan && state.plan.tasks.length > 0),
      planTaskIdsByType,
      planTaskTypesById,
      readyTasks: state.getReadyTaskIds(),
      runningTasks: state.getRunningTaskIds(),
      failedTasks: state.getFailedTaskIds().filter((taskId) =>
        planTaskIds.includes(taskId),
      ),
      completedPlanTasks,
      artifactTaskIds: Object.keys(artifactsState.artifacts).sort(),
      artifactTypesByTask,
      unacceptedArtifacts: state.getUnacceptedArtifactTaskIds(),
      unevaluatedArtifacts: state.getUnevaluatedArtifactTaskIds(),
      rejectedArtifacts: state.getRejectedArtifactTaskIds(),
      reviewCandidates,
      latestIssues,
      finalReviewDone: reviewState.finalReviewDone,
      finalReviewPassed: reviewState.finalReviewPassed,
      finalReviewCurrent: finalCurrent,
      outputSaved: state.persisted,
      isDirectMode: state.isDirectMode,
      directModeArtifacts: Object.keys(artifactsState.artifacts)
        .filter((tid) => tid.startsWith("direct_"))
        .sort(),
      evaluatorRunning: state.taskStatus("evaluator") === "running",
      plannerFailures: counters["planner_spawn_fail"] ?? 0,
      planRevisionCount: state.progress.planRevisionCount,
      repairCountsByTask,
      regenerateCountsByTask,
      stalledTaskIds: [...state.progress.stalledTaskIds].sort(),
      majorPendingTaskIds: state.getMajorPendingTaskIds(),
      globallyStalled: state.progress.isGloballyStalled(3),
      recentErrors: executionState.errors.slice(-5),
      convergenceStalled: state.convergence.isStalled(),
      convergenceStalledFingerprints: state.convergence.stalledFingerprints(),
      convergenceTrend: state.convergence.trend(),
      convergenceRoundCount: state.convergence.roundCount,
      planAllCompleted:
        planTaskIds.length > 0 &&
        completedPlanTasks.length === planTaskIds.length,
      hasArtifacts: Object.keys(artifactsState.artifacts).length > 0,
    };
  }

  private static _finalReviewRevisions(state: WorkflowState): Record<string, number> {
    const revisions: Record<string, number> = {};
    for (const [taskId, snapshot] of Object.entries(state.finalArtifactSnapshots())) {
      revisions[taskId] = Number(snapshot.revision ?? 0);
      const sourceRevisions = snapshot.sourceRevisions;
      if (
        sourceRevisions &&
        typeof sourceRevisions === "object" &&
        !Array.isArray(sourceRevisions)
      ) {
        for (const [sourceTaskId, sourceRevision] of Object.entries(
          sourceRevisions as Record<string, unknown>,
        )) {
          revisions[sourceTaskId] = Number(sourceRevision ?? 0);
        }
      }
    }
    return revisions;
  }
}
