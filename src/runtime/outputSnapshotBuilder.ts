import type { WorkflowState } from "../state.js";
import type { OutputSnapshot } from "../shared/outputSnapshot.js";

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value);
}

export class OutputSnapshotBuilder {
  static fromState(state: WorkflowState): OutputSnapshot {
    const requirementJson = cloneRecord(state.requirementJson);
    const domainModelJson = cloneRecord(state.domainModelJson);
    const diagrams = cloneRecord(state.diagrams);
    const reviewResult = Object.keys(state.reviewResult).length > 0
      ? cloneRecord(state.reviewResult)
      : null;
    const designText = state.designText ?? "";
    const testCases = state.testCases ?? "";
    const hasOutput = Boolean(
      Object.keys(requirementJson).length > 0 ||
      Object.keys(domainModelJson).length > 0 ||
      designText ||
      Object.keys(diagrams).length > 0 ||
      testCases,
    );

    return {
      goal: state.goal,
      requirementJson,
      requirementText: state.requirementText ?? "",
      domainModelJson,
      designText,
      diagrams,
      testCases,
      reviewResult,
      hasOutput,
    };
  }
}
