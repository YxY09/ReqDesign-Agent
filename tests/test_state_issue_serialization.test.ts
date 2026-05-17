import { describe, it, expect } from "vitest";
import { WorkflowState } from "../src/state.js";
import { createIssue, createVerdict } from "../src/agents/types.js";

describe("WorkflowState verdict serialization", () => {
  it("addVerdict serializes target task type into reviewResult", () => {
    const state = new WorkflowState();
    state.goal = "design";

    const verdict = createVerdict({
      passed: false,
      issues: [
        createIssue({
          severity: "major",
          targetTaskId: "design-1",
          targetTaskType: "design",
          targetField: "design_text",
          description: "missing design section",
          suggestion: "add design section",
        }),
      ],
    });

    state.addVerdict(verdict);

    const issues = state.reviewResult["issues"] as Array<Record<string, unknown>>;
    expect(issues[0]["target"]).toBe("design-1");
    expect(issues[0]["targetType"]).toBe("design");
  });
});
