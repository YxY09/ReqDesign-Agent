/**
 * 工程化编排器的策略级类型。
 */

export const STRATEGY_DEFINITIONS = [
  {
    name: "start_planning",
    description: "Create an execution plan for requirements that need analysis/design/tests.",
  },
  {
    name: "route_direct_diagrams",
    description: "Use only for simple diagram-focused requests that do not need full planning.",
  },
  {
    name: "advance_ready_work",
    description: "Run tasks that are ready and unblocked.",
  },
  {
    name: "wait_for_running",
    description: "Wait when relevant work or evaluation is already running.",
  },
  {
    name: "run_opportunistic_review",
    description: "Review newly completed artifacts before final review.",
  },
  {
    name: "run_final_review",
    description: "Run the full final quality review once all plan tasks are complete.",
  },
  {
    name: "repair_local_artifact",
    description: "Patch a specific artifact when the issue is local and repair budget remains.",
  },
  {
    name: "repair_upstream_artifact",
    description: "Patch an upstream artifact when the downstream issue is caused upstream.",
  },
  {
    name: "regenerate_downstream",
    description: "Regenerate a task after failed repair or repeated local issues.",
  },
  {
    name: "escalate_to_replan",
    description: "Ask the planner to mutate the plan when local repair/regeneration is not enough.",
  },
  {
    name: "save_outputs",
    description: "Persist final outputs after quality gates are satisfied.",
  },
  {
    name: "finish",
    description: "Finish when work is complete or nothing actionable is loaded.",
  },
  {
    name: "pause_for_user",
    description: "Pause when automatic progress is unsafe or budgets are exhausted.",
  },
] as const;

export type StrategyName = typeof STRATEGY_DEFINITIONS[number]["name"];
export const VALID_STRATEGIES: ReadonlySet<string> = new Set(
  STRATEGY_DEFINITIONS.map((strategy) => strategy.name),
);

export function strategyPromptCatalog(): string {
  return STRATEGY_DEFINITIONS
    .map((strategy) => `- ${strategy.name}: ${strategy.description}`)
    .join("\n");
}

/** 编译为运行时操作之前的 Agent 级策略。 */
export interface StrategyDecision {
  strategy: StrategyName;
  targetTaskId: string;
  affectedTaskIds: string[];
  reason: string;
  confidence: number;
}

export function createStrategyDecision(overrides: Partial<StrategyDecision> & Pick<StrategyDecision, "strategy">): StrategyDecision {
  return {
    targetTaskId: "",
    affectedTaskIds: [],
    reason: "",
    confidence: 1.0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ActionCompiler —— 将策略编译为运行时操作
// ---------------------------------------------------------------------------

import { createRuntimeAction, type RuntimeAction } from "../shared/types.js";
import type { OrchestratorSnapshot } from "./snapshot.js";

export class ActionCompiler {
  compile(decision: StrategyDecision, snapshot: OrchestratorSnapshot): RuntimeAction {
    const strategy = decision.strategy;
    const reason = decision.reason;

    if (strategy === "start_planning") return createRuntimeAction({ action: "spawn", taskId: "planner", reason });
    if (strategy === "route_direct_diagrams") return createRuntimeAction({ action: "spawn", taskId: "direct_diagrams", reason });

    if (strategy === "advance_ready_work") {
      const ready = decision.affectedTaskIds.length > 0 ? decision.affectedTaskIds : snapshot.readyTasks;
      if (ready.length === 1) return createRuntimeAction({ action: "spawn", taskId: ready[0], reason });
      return createRuntimeAction({ action: "spawn_all_ready", reason });
    }

    if (strategy === "run_opportunistic_review") {
      const scope = decision.affectedTaskIds.length > 0 ? decision.affectedTaskIds : snapshot.reviewCandidates.length > 0 ? snapshot.reviewCandidates : snapshot.unevaluatedArtifacts;
      return createRuntimeAction({ action: "spawn", taskId: "evaluator", reason, evaluateScope: [...scope] });
    }

    if (strategy === "run_final_review") return createRuntimeAction({ action: "spawn", taskId: "evaluator", reason });

    if (strategy === "repair_local_artifact" || strategy === "repair_upstream_artifact") {
      return createRuntimeAction({ action: "repair", taskId: decision.targetTaskId, reason });
    }

    if (strategy === "regenerate_downstream") {
      const taskId = decision.affectedTaskIds.length > 0 ? decision.affectedTaskIds[0] : decision.targetTaskId;
      return createRuntimeAction({ action: "regenerate", taskId, reason });
    }

    if (strategy === "escalate_to_replan") return createRuntimeAction({ action: "replan", taskId: "planner", reason });
    if (strategy === "save_outputs") return createRuntimeAction({ action: "save", reason });
    if (strategy === "finish") return createRuntimeAction({ action: "finish", reason });
    if (strategy === "pause_for_user") return createRuntimeAction({ action: "pause", reason });
    if (strategy === "wait_for_running") return createRuntimeAction({ action: "inspect", taskId: "all", reason });

    return createRuntimeAction({ action: "pause", reason: reason || "orchestrator paused" });
  }
}
