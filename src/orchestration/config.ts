/**
 * Orchestration configuration — runtime-tunable limits for the control plane.
 */

export interface OrchestrationConfigRaw {
  max_repair_per_task?: number;
  diagram_repair_before_regenerate?: number;
  design_repair_before_regenerate?: number;
  max_regenerate_per_task?: number;
  max_replan_count?: number;
  max_runtime_seconds?: number;
  max_decision_count?: number;
  max_planner_failures?: number;
  max_evaluator_timeouts?: number;
  max_save_failures?: number;
  max_final_major_issues?: number;
  max_final_major_repair_per_task?: number;
  max_concurrent_evaluators?: number;
}

export class OrchestrationConfig {
  maxRepairPerTask = 4;
  diagramRepairBeforeRegenerate = 2;
  designRepairBeforeRegenerate = 2;
  maxRegeneratePerTask = 1;
  maxReplanCount = 2;
  maxRuntimeSeconds = 1800;
  maxDecisionCount = 500;
  maxPlannerFailures = 3;
  maxEvaluatorTimeouts = 3;
  maxSaveFailures = 3;
  maxFinalMajorIssues = 0;
  maxFinalMajorRepairPerTask = 1;
  maxConcurrentEvaluators = 2;

  static fromRaw(raw: OrchestrationConfigRaw): OrchestrationConfig {
    const cfg = new OrchestrationConfig();
    if (raw.max_repair_per_task !== undefined) cfg.maxRepairPerTask = raw.max_repair_per_task;
    if (raw.diagram_repair_before_regenerate !== undefined) cfg.diagramRepairBeforeRegenerate = raw.diagram_repair_before_regenerate;
    if (raw.design_repair_before_regenerate !== undefined) cfg.designRepairBeforeRegenerate = raw.design_repair_before_regenerate;
    if (raw.max_regenerate_per_task !== undefined) cfg.maxRegeneratePerTask = raw.max_regenerate_per_task;
    if (raw.max_replan_count !== undefined) cfg.maxReplanCount = raw.max_replan_count;
    if (raw.max_runtime_seconds !== undefined) cfg.maxRuntimeSeconds = raw.max_runtime_seconds;
    if (raw.max_decision_count !== undefined) cfg.maxDecisionCount = raw.max_decision_count;
    if (raw.max_planner_failures !== undefined) cfg.maxPlannerFailures = raw.max_planner_failures;
    if (raw.max_evaluator_timeouts !== undefined) cfg.maxEvaluatorTimeouts = raw.max_evaluator_timeouts;
    if (raw.max_save_failures !== undefined) cfg.maxSaveFailures = raw.max_save_failures;
    if (raw.max_final_major_issues !== undefined) cfg.maxFinalMajorIssues = raw.max_final_major_issues;
    if (raw.max_final_major_repair_per_task !== undefined) cfg.maxFinalMajorRepairPerTask = raw.max_final_major_repair_per_task;
    if (raw.max_concurrent_evaluators !== undefined) cfg.maxConcurrentEvaluators = raw.max_concurrent_evaluators;
    return cfg;
  }
}
