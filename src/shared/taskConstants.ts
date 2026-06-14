/**
 * IDs for synthetic aggregator tasks that don't correspond to individual
 * work items in the ExecutionPlan. These are created by ArtifactManager
 * to hold merged/final snapshots for evaluation.
 */
export const SYNTHETIC_TASK_IDS = {
  ANALYZE_FINAL: "analyze-final",
  ANALYZE_COMPREHENSIVE: "analyze-comprehensive",
  DIAGRAMS_FINAL: "diagrams-final",
} as const;
