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

/** Rule 4: Workflow globally stalled — replan if budget allows. */
function globallyStalled(
  snapshot: OrchestratorSnapshot,
  policy: DeterministicPolicy,
): StrategyDecision | null {
  if (snapshot.globallyStalled && policy.guard.canReplan(snapshot)) {
    return createStrategyDecision({
      strategy: "escalate_to_replan",
      reason: "workflow is globally stalled",
    });
  }
  return null;
}

/** Rule 5: Convergence stalled — accept if trend is tolerable, otherwise pause. */
function convergenceStalled(
  snapshot: OrchestratorSnapshot,
  policy: DeterministicPolicy,
): StrategyDecision | null {
  if (!snapshot.convergenceStalled || snapshot.convergenceRoundCount < 3) return null;

  // --- Step 7: Termination guarantee. ---
  // If convergence rounds are exhausted, force a pause regardless of issue
  // count or trend so the orchestrator cannot loop forever. This runs before
  // the accept branches so a low blocker-free issue count cannot keep us
  // from stopping. The 3 independent runtime exits
  // (runtimeExhausted / decisionExhausted / consecutiveNoAction) remain intact.
  if (policy.budget.convergenceRoundsExhausted(snapshot.convergenceRoundCount)) {
    return createStrategyDecision({
      strategy: "pause_for_user",
      reason: `convergence rounds exhausted: reached max ${policy.budget.maxConvergenceRounds} rounds`,
    });
  }

  const trend = snapshot.convergenceTrend ?? "flat";
  // --- Step 5: Severity gate. ---
  // Only auto-accept convergence when there are no blocker-severity issues in
  // the latest round; otherwise fall through to the pause path even if the
  // issue count is low and the trend is tolerable.
  const hasBlocker = snapshot.latestIssues.some(
    (issue) => issue["severity"] === "blocker",
  );
  if (
    !hasBlocker &&
    trend === "decreasing" &&
    snapshot.latestIssues.length <= policy.budget.convergenceAcceptMaxIssuesDecreasing
  ) {
    return createStrategyDecision({
      strategy: "finish",
      reason: `convergence accepted despite stall: 0 blockers, ${snapshot.latestIssues.length} issues, trend decreasing`,
    });
  }
  if (
    !hasBlocker &&
    trend !== "increasing" &&
    snapshot.latestIssues.length <= policy.budget.convergenceAcceptMaxIssuesFlat
  ) {
    return createStrategyDecision({
      strategy: "finish",
      reason: `convergence accepted: 0 blockers, ${snapshot.latestIssues.length} issues, trend ${trend}, low enough`,
    });
  }
  return createStrategyDecision({
    strategy: "pause_for_user",
    reason: `convergence stalled: ${snapshot.convergenceStalledFingerprints.length} issue(s) unchanged across ${snapshot.convergenceRoundCount} rounds`,
  });
}

/** Rule 6: Final review rejected with no repairable targets — pause. */
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

/** Rule 7: Final major issues — try per-task repair via shared ladder. */
function finalMajorIssues(
  snapshot: OrchestratorSnapshot,
  policy: DeterministicPolicy,
): StrategyDecision | null {
  if (policy.budget.skipEvaluation) return null;
  return policy.ladder.finalMajor(snapshot) ?? null;
}

/** Rule 8: Final review rejected with no auto-repair remaining — pause. */
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

/** Rule 9: Outputs already saved — finish. */
function outputSaved(snapshot: OrchestratorSnapshot): StrategyDecision | null {
  if (snapshot.outputSaved) {
    return createStrategyDecision({
      strategy: "finish",
      reason: "outputs already saved",
    });
  }
  return null;
}

/** Rule 10: Work still running — wait. */
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
 * Rule 11: No plan yet — return null to let StrategyBrain make the initial
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

/** Rule 12: Shared forward-progress ladder after all blocking gates are clear. */
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

/** Rule 13: Nothing has been loaded — finish. */
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
  globallyStalled,
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
