/**
 * 顶层编排的稳定状态快照。
 *
 * 源自 reqdesign/orchestration/snapshot.py。
 */

import type { WorkflowState } from "../state.js";
import type { TaskMailbox } from "../messaging.js";

// ---------------------------------------------------------------------------
// OrchestratorSnapshot
// ---------------------------------------------------------------------------

/** 面向协调器的调度快照（降噪后）。 */
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
  /**
   * Tasks repaired at least once whose SAME structural issue fingerprint
   * persists across the two most recent evaluations. Repairing them again is
   * futile (the LLM cannot move the issue), so the ladder accepts instead.
   */
  repairFutileTaskIds: string[];
  majorPendingTaskIds: string[];
  recentErrors: string[];

  /** 计算得出：评估历史中的收敛状态。 */
  convergenceStalled: boolean;
  convergenceStalledFingerprints: string[];
  convergenceTrend: string;
  convergenceRoundCount: number;

  /** 计算得出：所有计划任务均已完成。 */
  planAllCompleted: boolean;
  /** 计算得出：至少存在一个产物。 */
  hasArtifacts: boolean;
}

// ---------------------------------------------------------------------------
// StateReader
// ---------------------------------------------------------------------------

/** 从运行时状态构建编排快照。 */
export class StateReader {
  static fromState(
    state: WorkflowState,
    _mailbox: TaskMailbox,
  ): OrchestratorSnapshot {
    const currentRevisions = StateReader._finalReviewRevisions(state);
    const finalCurrent =
      Object.keys(currentRevisions).length > 0 &&
      state.finalReviewDone &&
      Object.keys(currentRevisions).length === Object.keys(state.finalReviewRevisions).length &&
      Object.entries(currentRevisions).every(([k, v]) => state.finalReviewRevisions[k] === v);

    const latestIssues: Record<string, unknown>[] = [];
    if (state.verdicts.length > 0) {
      for (const issue of state.verdicts[state.verdicts.length - 1].issues) {
      latestIssues.push({
          severity: issue.severity,
          kind: issue.kind,
          target_task_id: issue.targetTaskId,
          target_task_type: issue.targetTaskType,
          target_field: issue.targetField,
          scope: issue.scope,
          description: issue.description,
        });
      }
    }

    const unevaluatedSet = new Set(state.getUnevaluatedArtifactTaskIds());
    const reviewCandidates = state
      .getCompletedTaskIds()
      .filter((taskId) => unevaluatedSet.has(taskId))
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
    for (const [taskId, artifact] of Object.entries(state.artifacts).sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      artifactTypesByTask[taskId] =
        artifact.type || planTaskTypesById[taskId] || "";
    }

    // 从计数器中提取修复次数
    const repairCountsByTask: Record<string, number> = {};
    const regenerateCountsByTask: Record<string, number> = {};
    for (const [key, val] of Object.entries(counters)) {
      if (key.startsWith("repair_count:")) {
        repairCountsByTask[key.slice("repair_count:".length)] = val;
      } else if (key.startsWith("regenerate_count:")) {
        regenerateCountsByTask[key.slice("regenerate_count:".length)] = val;
      }
    }

    // Repair futility: a task already repaired at least once whose same
    // structural issue fingerprint appears in BOTH of the two most recent
    // evaluations. The intervening repair did not move the issue, so further
    // repair is futile and the ladder should accept rather than loop.
    const repairFutileTaskIds: string[] = [];
    if (state.verdicts.length >= 2) {
      const latest = state.verdicts[state.verdicts.length - 1];
      const prev = state.verdicts[state.verdicts.length - 2];
      const fingerprintsForTask = (
        verdict: typeof latest,
        taskId: string,
      ): Set<string> =>
        new Set(
          verdict.issues
            .filter((issue) => issue.kind === "defect" && issue.targetTaskId === taskId)
            .map((issue) => ConvergenceTracker.fingerprint(issue)),
        );
      const candidateTaskIds = new Set(
        latest.issues
          .filter((issue) => issue.kind === "defect")
          .map((issue) => issue.targetTaskId)
          .filter((taskId) => taskId !== ""),
      );
      for (const taskId of candidateTaskIds) {
        if ((repairCountsByTask[taskId] ?? 0) < 1) continue;
        const latestFps = fingerprintsForTask(latest, taskId);
        const prevFps = fingerprintsForTask(prev, taskId);
        if ([...latestFps].some((fp) => prevFps.has(fp))) {
          repairFutileTaskIds.push(taskId);
        }
      }
      repairFutileTaskIds.sort();
    }

    const planTaskIds = state.getPlanTaskIds();
    const completedPlanTasks = state.getCompletedPlanTaskIds();

    return {
      goal: state.goal,
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
      artifactTaskIds: Object.keys(state.artifacts).sort(),
      artifactTypesByTask,
      unacceptedArtifacts: state.getUnacceptedArtifactTaskIds(),
      unevaluatedArtifacts: state.getUnevaluatedArtifactTaskIds(),
      rejectedArtifacts: state.getRejectedArtifactTaskIds(),
      reviewCandidates,
      latestIssues,
      finalReviewDone: state.finalReviewDone,
      finalReviewPassed: state.finalReviewPassed,
      finalReviewCurrent: finalCurrent,
      outputSaved: state.persisted,
      isDirectMode: state.isDirectMode,
      directModeArtifacts: Object.keys(state.artifacts)
        .filter((tid) => tid.startsWith("direct_"))
        .sort(),
      evaluatorRunning: state.taskStatus("evaluator") === "running",
      plannerFailures: counters["planner_spawn_fail"] ?? 0,
      planRevisionCount: state.progress.planRevisionCount,
      repairCountsByTask,
      regenerateCountsByTask,
      repairFutileTaskIds,
      majorPendingTaskIds: state.getMajorPendingTaskIds(),
      recentErrors: state.errors.slice(-5),
      convergenceStalled: state.convergence.isStalled(),
      convergenceStalledFingerprints: state.convergence.stalledFingerprints(),
      convergenceTrend: state.convergence.trend(),
      convergenceRoundCount: state.convergence.roundCount,
      planAllCompleted:
        planTaskIds.length > 0 &&
        completedPlanTasks.length === planTaskIds.length,
      hasArtifacts: Object.keys(state.artifacts).length > 0,
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

// ---------------------------------------------------------------------------
// ConvergenceTracker — detect stalled repair loops
// ---------------------------------------------------------------------------

interface IssueFingerprint {
  fingerprint: string;
  severity: string;
}

/** Minimal shape needed to compute a structural issue fingerprint. */
export interface FingerprintableIssue {
  targetTaskId?: string;
  targetField?: string;
  severity?: string;
  description?: string;
}

export interface EvaluationRound {
  issues: IssueFingerprint[];
}

export type Trend = "decreasing" | "flat" | "increasing" | "unknown";

export class ConvergenceTracker {
  private readonly rounds: EvaluationRound[] = [];
  private readonly stallThreshold: number;

  constructor(stallThreshold = 3) { this.stallThreshold = stallThreshold; }

  addRound(round: EvaluationRound): void { this.rounds.push(round); }
  get roundCount(): number { return this.rounds.length; }

  /**
   * Identity of an issue for stall / futility detection.
   *
   * Prefers a STRUCTURAL identity — `taskId::field::severity` — so that the
   * same defect reworded across rounds still matches (a reworded-but-identical
   * issue is the signal that repair is not moving it). Falls back to the
   * description prefix when no structural fields are present (e.g. a systemic
   * issue with no target field, or a bare string passed by older callers).
   */
  static fingerprint(issue: FingerprintableIssue | string): string {
    const obj: FingerprintableIssue =
      typeof issue === "string" ? { description: issue } : issue;
    const task = String(obj.targetTaskId ?? "").trim().toLowerCase();
    const field = String(obj.targetField ?? "").trim().toLowerCase();
    const severity = String(obj.severity ?? "").trim().toLowerCase();
    if (task !== "" || field !== "") {
      return `${task}::${field}::${severity}`;
    }
    return String(obj.description ?? "").trim().slice(0, 80).toLowerCase();
  }

  isStalled(): boolean {
    if (this.rounds.length < this.stallThreshold) return false;
    if (this.stalledFingerprints().length === 0) return false;
    if (this.trend() === "decreasing") return false;
    return true;
  }

  stalledFingerprints(): string[] {
    if (this.rounds.length < this.stallThreshold) return [];
    const recent = this.rounds.slice(-this.stallThreshold);
    const firstSet = new Set(recent[0].issues.map((i) => i.fingerprint));
    return [...firstSet].filter((fp) =>
      recent.every((round) => round.issues.some((i) => i.fingerprint === fp)),
    );
  }

  trend(): Trend {
    if (this.rounds.length < 2) return "unknown";
    const counts = this.rounds.slice(-3).map((r) => r.issues.length);
    const strictlyDecreasing = counts.every((c, i) => i === 0 || c < counts[i - 1]);
    const strictlyIncreasing = counts.every((c, i) => i === 0 || c > counts[i - 1]);
    if (strictlyDecreasing) return "decreasing";
    if (strictlyIncreasing) return "increasing";
    return "flat";
  }

  get latestMajorCount(): number {
    if (this.rounds.length === 0) return 0;
    return this.rounds[this.rounds.length - 1].issues.filter((i) => i.severity === "major").length;
  }

  reset(): void { this.rounds.length = 0; }
}
