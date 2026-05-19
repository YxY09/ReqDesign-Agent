/**
 * Compile engineering strategies into concrete runtime actions.
 *
 * Ported from reqdesign/orchestration/compiler.py.
 */

import { createRuntimeAction, type RuntimeAction } from "../agent/types.js";
import type { OrchestratorSnapshot } from "./snapshot.js";
import type { StrategyDecision } from "./strategy.js";

// ---------------------------------------------------------------------------
// ActionCompiler
// ---------------------------------------------------------------------------

export class ActionCompiler {
  /** Convert a strategy-level decision into a runtime action. */
  compile(
    decision: StrategyDecision,
    snapshot: OrchestratorSnapshot,
  ): RuntimeAction {
    const strategy = decision.strategy;
    const reason = decision.reason;

    if (strategy === "start_planning") {
      return createRuntimeAction({
        action: "spawn",
        taskId: "planner",
        reason,
      });
    }

    if (strategy === "route_direct_diagrams") {
      return createRuntimeAction({
        action: "spawn",
        taskId: "direct_diagrams",
        reason,
      });
    }

    if (strategy === "advance_ready_work") {
      const ready =
        decision.affectedTaskIds.length > 0
          ? decision.affectedTaskIds
          : snapshot.readyTasks;
      if (ready.length === 1) {
        return createRuntimeAction({
          action: "spawn",
          taskId: ready[0],
          reason,
        });
      }
      return createRuntimeAction({ action: "spawn_all_ready", reason });
    }

    if (strategy === "run_opportunistic_review") {
      const scope =
        decision.affectedTaskIds.length > 0
          ? decision.affectedTaskIds
          : snapshot.reviewCandidates.length > 0
            ? snapshot.reviewCandidates
            : snapshot.unevaluatedArtifacts;
      return createRuntimeAction({
        action: "spawn",
        taskId: "evaluator",
        reason,
        evaluateScope: [...scope],
      });
    }

    if (strategy === "run_final_review") {
      return createRuntimeAction({
        action: "spawn",
        taskId: "evaluator",
        reason,
      });
    }

    if (
      strategy === "repair_local_artifact" ||
      strategy === "repair_upstream_artifact"
    ) {
      return createRuntimeAction({
        action: "repair",
        taskId: decision.targetTaskId,
        reason,
      });
    }

    if (strategy === "regenerate_downstream") {
      const taskId =
        decision.affectedTaskIds.length > 0
          ? decision.affectedTaskIds[0]
          : decision.targetTaskId;
      return createRuntimeAction({
        action: "regenerate",
        taskId,
        reason,
      });
    }

    if (strategy === "escalate_to_replan") {
      return createRuntimeAction({
        action: "replan",
        taskId: "planner",
        reason,
      });
    }

    if (strategy === "save_outputs") {
      return createRuntimeAction({ action: "save", reason });
    }

    if (strategy === "finish") {
      return createRuntimeAction({ action: "finish", reason });
    }

    if (strategy === "pause_for_user") {
      return createRuntimeAction({ action: "pause", reason });
    }

    if (strategy === "wait_for_running") {
      return createRuntimeAction({
        action: "inspect",
        taskId: "all",
        reason,
      });
    }

    return createRuntimeAction({
      action: "pause",
      reason: reason || "orchestrator paused",
    });
  }
}
