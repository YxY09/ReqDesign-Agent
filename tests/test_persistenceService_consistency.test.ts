import { describe, it, expect } from "vitest";
import { PersistenceService } from "../src/runtime/persistenceService.js";
import type { PersistenceServiceDeps } from "../src/runtime/persistenceService.js";
import type { WorkflowState } from "../src/state.js";

/**
 * Minimal stub deps — findOutputConsistencyIssues doesn't call any deps,
 * so we just need something that satisfies the type.
 */
function makeDeps(): PersistenceServiceDeps {
  return {
    outputManagerCtor: class {
      saveSystemDesign() {}
      saveDiagrams() {}
      saveTestCases() {}
      saveArtifactByTask() {}
      saveTraceJson() {}
      saveReviewReport() {}
      saveQualityScore() {}
    } as unknown as PersistenceServiceDeps["outputManagerCtor"],
    trace: { log: () => {}, child: () => ({ log: () => {} }) } as unknown as PersistenceServiceDeps["trace"],
    mailbox: { send: () => {}, receive: () => [] } as unknown as PersistenceServiceDeps["mailbox"],
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as PersistenceServiceDeps["logger"],
    onEmitRuntimeEvent: () => {},
    onSnapshotState: () => ({}),
  };
}

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  const state = {
    requirementJson: {
      functions: [
        { id: "FUN_ADVANCED_SEARCH", displayId: "F001", name: "Advanced Search" },
        { id: "FUN_USER_AUTH", displayId: "F002", name: "User Authentication" },
      ],
    },
    designText: "The system uses F001 for advanced search and F002 for auth.",
    testCases: "Test F001: verify search works. Test F002: verify login.",
    diagrams: {},
  } as unknown as WorkflowState;
  return Object.assign(state, overrides);
}

describe("findOutputConsistencyIssues", () => {
  it("should not flag displayId references (e.g. F001) as undefined when both id and displayId are defined", () => {
    const service = new PersistenceService(makeDeps());
    const state = makeState();
    const issues = service.findOutputConsistencyIssues(state);
    expect(issues).toEqual([]);
  });

  it("should still flag truly undefined displayId references", () => {
    const service = new PersistenceService(makeDeps());
    const state = makeState({
      designText: "This uses F999 which is not defined anywhere.",
      testCases: "",
      diagrams: {},
    });
    const issues = service.findOutputConsistencyIssues(state);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("F999");
  });

  it("should return empty when no functions are defined", () => {
    const service = new PersistenceService(makeDeps());
    const state = makeState({
      requirementJson: {},
    });
    const issues = service.findOutputConsistencyIssues(state);
    expect(issues).toEqual([]);
  });
});
