/**
 * Strategy-level types for the engineering orchestrator.
 */

export type StrategyName =
  | "start_planning"
  | "route_direct_diagrams"
  | "advance_ready_work"
  | "wait_for_running"
  | "run_opportunistic_review"
  | "run_final_review"
  | "repair_local_artifact"
  | "repair_upstream_artifact"
  | "regenerate_downstream"
  | "escalate_to_replan"
  | "save_outputs"
  | "finish"
  | "pause_for_user";

/** Agent-level strategy before it is compiled into a runtime action. */
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
