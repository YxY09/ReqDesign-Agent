import type { WorkflowEventSink } from "../workflowEvents.js";

/** Minimal runtime surface needed by benchmark runners. */
export interface RuntimeLike {
  run(
    goal: string,
    inputPath: string,
    outputDir: string,
    options?: { onEvent?: WorkflowEventSink },
  ): Promise<{
    requirementJson: unknown;
    diagrams: unknown;
    getMajorPendingTaskIds(): string[];
    finalReviewPassed: boolean;
    persisted: boolean;
    qualityStatus: string;
    reviewResult: Record<string, unknown>;
  }>;
  cancel(reason?: string): void;
}

/** Factory that produces a RuntimeLike; injectable for tests and benchmarks. */
export type RuntimeFactory = (config: import("../config.js").AgentConfig) => RuntimeLike;
