import type { WorkflowState } from "../state.js";
import type { Verdict } from "../shared/types.js";
import { ConvergenceTracker } from "../orchestration/snapshot.js";

/**
 * Manages verdict processing and review status queries.
 *
 * Extracted from WorkflowState to reduce the god-class footprint.
 * All state is read/mutated through the owning WorkflowState reference.
 */
export class ReviewManager {
  constructor(private readonly _state: WorkflowState) {}

  // ------------------------------------------------------------------
  // Verdict management
  // ------------------------------------------------------------------

  /** Record a verdict. */
  addVerdict(verdict: Verdict): void {
    const blockerTaskIds = new Set<string>();
    const majorTaskIds = new Set<string>();
    for (const issue of verdict.issues) {
      if (issue.severity === "blocker" && issue.targetTaskId) {
        blockerTaskIds.add(issue.targetTaskId);
      }
      if (issue.severity === "major" && issue.targetTaskId) {
        majorTaskIds.add(issue.targetTaskId);
      }
    }
    const cleanPassed = verdict.passed && majorTaskIds.size === 0;

    for (const [taskId, revision] of Object.entries(verdict.evaluatedRevisions)) {
      const current = this._state.evaluatedRevisionsByTask[taskId] ?? 0;
      if (revision >= current) {
        // Don't downgrade an already-accepted revision to "rejected"
        const acceptedRev = this._state.acceptedRevisionsByTask[taskId] ?? 0;
        if (revision <= acceptedRev) {
          continue;
        }
        this._state.evaluatedRevisionsByTask[taskId] = revision;
        const status: string = blockerTaskIds.has(taskId) ? "rejected" : "passed";
        this._state.reviewStatusByTask[taskId] = status;
        if (status === "passed") {
          this._state.acceptedRevisionsByTask[taskId] = revision;
        }
      }
    }

    // Track tasks with major issues that passed (no blockers)
    // so the coordinator can attempt one repair round
    this._state.majorPendingTaskIds = new Set(
      [...majorTaskIds].filter((id) => !blockerTaskIds.has(id)),
    );
    if (this._state.majorPendingTaskIds.size > 0) {
      // Reset major repair tracking in progress (mirrors Python's _counters)
      this._state.progress.recordNoProgress();
    }

    this._state.verdicts.push(verdict);

    // Update convergence tracker with latest evaluation issues
    if (verdict.issues.length > 0) {
      this._state.convergence.addRound({
        issues: verdict.issues.map((issue) => ({
          fingerprint: ConvergenceTracker.fingerprint(issue.description),
          severity: issue.severity,
        })),
      });
    }

    this._state.reviewResult = {
      passed: cleanPassed,
      acceptedNoBlockers: verdict.passed,
      isFinalReview: verdict.isFinalReview,
      evaluatedTaskIds: [...verdict.evaluatedTaskIds],
      evaluatedRevisions: { ...verdict.evaluatedRevisions },
      reviewStatusByTask: { ...this._state.reviewStatusByTask },
      issues: verdict.issues.map((i) => ({
        severity: i.severity,
        target: i.targetTaskId,
        targetType: i.targetTaskType,
        description: i.description,
        suggestion: i.suggestion,
        scope: i.scope,
      })),
    };

    if (verdict.isFinalReview) {
      this._state.finalReviewDone = true;
      this._state.finalReviewPassed = cleanPassed;
      this._state.finalReviewRevisions = { ...verdict.evaluatedRevisions };
      this._state.qualityStatus = cleanPassed ? "passed" : "rejected";
    }

    // Track evaluator activity
    if (cleanPassed) {
      this._state.progress.recordScore(1.0);
      for (const taskId of Object.keys(
        this._state.progress.rejectionStreakByTask,
      )) {
        this._state.progress.recordAcceptance(taskId);
      }
    } else {
      this._state.progress.recordScore(0.0);
    }
  }

  // ------------------------------------------------------------------
  // Review status queries
  // ------------------------------------------------------------------

  /** The most recently added verdict, or `null`. */
  get latestVerdict(): Verdict | null {
    return this._state.verdicts.length > 0 ? this._state.verdicts[this._state.verdicts.length - 1] : null;
  }

  /** Latest revision that has been evaluated by the reviewer (0 if none). */
  latestEvaluatedRevision(taskId: string): number {
    return this._state.evaluatedRevisionsByTask[taskId] ?? 0;
  }

  /**
   * Review status of a task's current artifact revision.
   * Returns `"unknown"` if the current revision hasn't been evaluated yet.
   */
  currentReviewStatus(taskId: string): string {
    const currentRevision = this._state.currentArtifactRevision(taskId);
    if (currentRevision === 0) return "unknown";
    if (this.latestEvaluatedRevision(taskId) !== currentRevision) return "unknown";
    return this._state.reviewStatusByTask[taskId] ?? "unknown";
  }

  /** Whether the current artifact revision for a task has been accepted. */
  isCurrentArtifactAccepted(taskId: string): boolean {
    const currentRevision = this._state.currentArtifactRevision(taskId);
    if (currentRevision === 0) return false;
    return (
      this.latestEvaluatedRevision(taskId) === currentRevision &&
      this._state.reviewStatusByTask[taskId] === "passed" &&
      this._state.acceptedRevisionsByTask[taskId] === currentRevision
    );
  }

  /** Task IDs whose latest artifact revision has not been evaluated yet. */
  getUnevaluatedArtifactTaskIds(): string[] {
    return Object.keys(this._state.artifacts)
      .filter(
        (taskId) =>
          this._state.currentArtifactRevision(taskId) > this.latestEvaluatedRevision(taskId),
      )
      .sort();
  }

  /** Task IDs whose current artifact was rejected. */
  getRejectedArtifactTaskIds(): string[] {
    return Object.keys(this._state.artifacts)
      .filter((taskId) => this.currentReviewStatus(taskId) === "rejected")
      .sort();
  }

  /** Task IDs whose current artifact has not been accepted. */
  getUnacceptedArtifactTaskIds(): string[] {
    return Object.keys(this._state.artifacts)
      .filter((taskId) => !this.isCurrentArtifactAccepted(taskId))
      .sort();
  }

  /** Tasks that passed (no blockers) but have major issues worth fixing. */
  getMajorPendingTaskIds(): string[] {
    return [...this._state.majorPendingTaskIds]
      .filter((tid) => tid in this._state.artifacts)
      .sort();
  }

  /** Clear the set of major-pending task IDs. */
  clearMajorPending(): void {
    this._state.majorPendingTaskIds.clear();
  }
}
