/**
 * Named policy rules for DeterministicPolicy.decide().
 *
 * Each rule receives the current snapshot and the policy instance.
 * Returns a StrategyDecision if the rule fires, null if it doesn't apply.
 * Rules are evaluated in order; the first non-null result wins.
 */

import { isTaskRunning } from "./remediation.js";
import type { OrchestratorSnapshot } from "./snapshot.js";
import { type StrategyDecision, createStrategyDecision } from "./strategy.js";
import type { DeterministicPolicy } from "./policy.js";
import { nextForwardProgressStrategy } from "./policyForward.js";

// ---------------------------------------------------------------------------
// Rule type
// ---------------------------------------------------------------------------

export type PolicyRule = (
  snapshot: OrchestratorSnapshot,
  policy: DeterministicPolicy,
) => StrategyDecision | null;

// ---------------------------------------------------------------------------
// Individual rules
// ---------------------------------------------------------------------------

/** Rule 1: Replan produced ready remediation tasks — advance them immediately. */
function replanRemediationReady(
  snapshot: OrchestratorSnapshot,
): StrategyDecision | null {
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
  return null;
}

/** Rule 2: Failed plan tasks — regenerate or replan. */
function failedTasksRegenerate(
  snapshot: OrchestratorSnapshot,
  policy: DeterministicPolicy,
): StrategyDecision | null {
  if (snapshot.failedTasks.length === 0) return null;

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

  if ((snapshot.regenerateCountsByTask[target] ?? 0) >= policy.budget.maxRegeneratePerTask) {
    if (policy.guard.canReplan(snapshot)) {
      return createStrategyDecision({
        strategy: "escalate_to_replan",
        targetTaskId: target,
        reason: `${target} failed after regeneration budget was exhausted`,
      });
    }
    if (snapshot.runningTasks.length > 0 || snapshot.evaluatorRunning) {
      if (policy.budget.canReplanWhenIdle(snapshot)) {
        return createStrategyDecision({
          strategy: "wait_for_running",
          targetTaskId: target,
          reason: `${target} failed after regeneration budget was exhausted, waiting for running tasks before replanning`,
        });
      }
      return createStrategyDecision({
        strategy: "pause_for_user",
        targetTaskId: target,
        reason: `${target} failed and both regeneration and replan budgets are exhausted`,
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

/** Rule 3: Rejected artifacts — repair, regenerate, or replan via shared ladder. */
function rejectedArtifacts(
  snapshot: OrchestratorSnapshot,
  policy: DeterministicPolicy,
): StrategyDecision | null {
  return policy.ladder.rejectedArtifact(snapshot) ?? null;
}

/**
 * Rule 4: Convergence stalled — accept if trend is tolerable, otherwise pause.
 *
 * Note: there is no separate "globally stalled → replan" rule. A run that keeps
 * finding non-blocker defects is not a deadlock; it is owned by this rule's hard
 * round cap plus the finalMajor repair-futility gate, both of which terminate
 * deterministically. Genuine deadlocks (planner thrash, failed/rejected tasks)
 * are handled by failedTasksRegenerate / rejectedArtifacts / the no-plan rule.
 */
function convergenceStalled(
  snapshot: OrchestratorSnapshot,
  policy: DeterministicPolicy,
): StrategyDecision | null {
  // Acceptance gates count verifiable DEFECTS, not advisories. Advisories
  // (coverage/completeness opinions) are recorded into known-limitations and
  // must not keep the run from converging.
  const defectIssues = snapshot.latestIssues.filter(
    (issue) => issue["kind"] === "defect",
  );
  const defectCount = defectIssues.length;
  const hasBlocker = defectIssues.some(
    (issue) => issue["severity"] === "blocker",
  );

  // --- Hard cap: unconditional termination guarantee. ---
  // Check BEFORE the isStalled/fingerprint guard so that replans (which change
  // all fingerprints and break stall detection) cannot bypass the round limit.
  if (policy.budget.convergenceRoundsExhausted(snapshot.convergenceRoundCount)) {
    if (!hasBlocker) {
      return createStrategyDecision({
        strategy: "finish",
        reason: `convergence rounds exhausted (${policy.budget.maxConvergenceRounds}), accepting: 0 blocker defects, ${defectCount} remaining defects`,
      });
    }
    return createStrategyDecision({
      strategy: "pause_for_user",
      reason: `convergence rounds exhausted (${policy.budget.maxConvergenceRounds}) with blocker defects still present`,
    });
  }

  // --- Fingerprint-based early exit (needs enough rounds). ---
  if (!snapshot.convergenceStalled || snapshot.convergenceRoundCount < 3) return null;

  const trend = snapshot.convergenceTrend ?? "flat";
  if (
    !hasBlocker &&
    trend === "decreasing" &&
    defectCount <= policy.budget.convergenceAcceptMaxIssuesDecreasing
  ) {
    return createStrategyDecision({
      strategy: "finish",
      reason: `convergence accepted despite stall: 0 blocker defects, ${defectCount} defects, trend decreasing`,
    });
  }
  if (
    !hasBlocker &&
    trend !== "increasing" &&
    defectCount <= policy.budget.convergenceAcceptMaxIssuesFlat
  ) {
    return createStrategyDecision({
      strategy: "finish",
      reason: `convergence accepted: 0 blocker defects, ${defectCount} defects, trend ${trend}, low enough`,
    });
  }
  return createStrategyDecision({
    strategy: "pause_for_user",
    reason: `convergence stalled: ${snapshot.convergenceStalledFingerprints.length} issue(s) unchanged across ${snapshot.convergenceRoundCount} rounds`,
  });
}

/** Rule 5: Final review rejected with no repairable targets — pause. */
function finalReviewRejectedNoTargets(
  snapshot: OrchestratorSnapshot,
): StrategyDecision | null {
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
  return null;
}

/** Rule 6: Final major issues — try per-task repair via shared ladder. */
function finalMajorIssues(
  snapshot: OrchestratorSnapshot,
  policy: DeterministicPolicy,
): StrategyDecision | null {
  if (policy.budget.skipEvaluation) return null;
  return policy.ladder.finalMajor(snapshot) ?? null;
}

/** Rule 7: Final review rejected with no auto-repair remaining — pause. */
function finalReviewRejectedNoRepair(
  snapshot: OrchestratorSnapshot,
  policy: DeterministicPolicy,
): StrategyDecision | null {
  if (
    !policy.budget.skipEvaluation &&
    snapshot.finalReviewCurrent &&
    !snapshot.finalReviewPassed
  ) {
    return createStrategyDecision({
      strategy: "pause_for_user",
      reason: "final review rejected and no automatic repair target remains",
    });
  }
  return null;
}

/** Rule 8: Outputs already saved — finish. */
function outputSaved(snapshot: OrchestratorSnapshot): StrategyDecision | null {
  if (snapshot.outputSaved) {
    return createStrategyDecision({
      strategy: "finish",
      reason: "outputs already saved",
    });
  }
  return null;
}

/** Rule 9: Work still running — wait. */
function workRunning(snapshot: OrchestratorSnapshot): StrategyDecision | null {
  if (snapshot.runningTasks.length > 0 || snapshot.evaluatorRunning) {
    return createStrategyDecision({
      strategy: "wait_for_running",
      reason: "work is still running",
    });
  }
  return null;
}

/**
 * Rule 10: No plan yet — return null to let StrategyBrain make the initial
 * routing decision. This rule is a sentinel: it only fires a hard pause when
 * the planner has failed too many times; otherwise it returns null to pass
 * control to the LLM layer rather than the deterministic ladder.
 */
function delegateInitialRoutingIfNoPlan(snapshot: OrchestratorSnapshot): StrategyDecision | null {
  if (snapshot.planReady || !snapshot.requirementLoaded || snapshot.hasArtifacts) return null;
  if (snapshot.plannerFailures >= 3) {
    return createStrategyDecision({
      strategy: "pause_for_user",
      reason: `planner failed ${snapshot.plannerFailures} times`,
    });
  }
  // Return null — StrategyBrain handles initial planning decision
  return null;
}

/** Rule 11: Shared forward-progress ladder after all blocking gates are clear. */
function forwardProgress(
  snapshot: OrchestratorSnapshot,
  policy: DeterministicPolicy,
): StrategyDecision | null {
  return nextForwardProgressStrategy(snapshot, {
    budget: policy.budget,
    reviewScheduler: policy.reviewScheduler,
    canRunFinalReview: (snap) => policy.guard.canRunFinalReview(snap),
    canSave: (snap) => policy.guard.canSave(snap),
  });
}

/** Rule 12: Nothing has been loaded — finish. */
function nothingLoaded(snapshot: OrchestratorSnapshot): StrategyDecision | null {
  if (!snapshot.requirementLoaded && !snapshot.hasArtifacts) {
    return createStrategyDecision({
      strategy: "finish",
      reason: "nothing has been loaded",
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ordered rule chain
// ---------------------------------------------------------------------------

export const POLICY_RULES: PolicyRule[] = [
  replanRemediationReady,
  failedTasksRegenerate,
  rejectedArtifacts,
  convergenceStalled,
  finalReviewRejectedNoTargets,
  finalMajorIssues,
  finalReviewRejectedNoRepair,
  outputSaved,
  workRunning,
  delegateInitialRoutingIfNoPlan,
  forwardProgress,
  nothingLoaded,
];
