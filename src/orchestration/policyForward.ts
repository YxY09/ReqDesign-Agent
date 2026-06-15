import type { BudgetManager } from "./budget.js";
import type { ReviewScheduler } from "./reviewScheduler.js";
import type { OrchestratorSnapshot } from "./snapshot.js";
import { createStrategyDecision, type StrategyDecision } from "./strategy.js";

export interface ForwardProgressDeps {
  budget: BudgetManager;
  reviewScheduler: ReviewScheduler;
  canRunFinalReview(snapshot: OrchestratorSnapshot): boolean;
  canSave(snapshot: OrchestratorSnapshot): boolean;
}

/**
 * Shared deterministic forward-progress ladder used by normal policy rules and
 * guard fallback after an unsafe LLM strategy is rejected.
 */
export function nextForwardProgressStrategy(
  snapshot: OrchestratorSnapshot,
  deps: ForwardProgressDeps,
  reason = "",
): StrategyDecision | null {
  if (snapshot.outputSaved) {
    return createStrategyDecision({
      strategy: "finish",
      reason: reason || "outputs already saved",
    });
  }

  if (snapshot.readyTasks.length > 0) {
    return createStrategyDecision({
      strategy: "advance_ready_work",
      affectedTaskIds: [...snapshot.readyTasks],
      reason: reason || `${snapshot.readyTasks.length} task(s) are ready`,
    });
  }

  if (!deps.budget.skipEvaluation && deps.canRunFinalReview(snapshot)) {
    return createStrategyDecision({
      strategy: "run_final_review",
      reason: reason || "final full review is required",
    });
  }

  if (!deps.budget.skipEvaluation) {
    const reviewPlan = deps.reviewScheduler.nextScope(snapshot);
    if (reviewPlan.hasScope && !snapshot.evaluatorRunning) {
      return createStrategyDecision({
        strategy: "run_opportunistic_review",
        affectedTaskIds: [...reviewPlan.scopeTaskIds],
        reason: reason || reviewPlan.reason,
      });
    }
  }

  if (deps.canSave(snapshot)) {
    return createStrategyDecision({
      strategy: "save_outputs",
      reason: reason || "quality and save gates passed",
    });
  }

  return null;
}
