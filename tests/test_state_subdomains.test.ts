import { describe, expect, it } from "vitest";
import { createArtifact, createIssue, createVerdict } from "../src/agents/types.js";
import { WorkflowState } from "../src/state.js";

describe("WorkflowState subdomain views", () => {
  it("keeps artifacts view and legacy fields synchronized", () => {
    const state = new WorkflowState();
    const artifactsState = state.artifactsState;

    state.requirementJson = { actors: ["student"] };
    expect(artifactsState.requirementJson).toEqual({ actors: ["student"] });

    artifactsState.designText = "design-v1";
    artifactsState.testCases = "test-v1";
    expect(state.designText).toBe("design-v1");
    expect(state.testCases).toBe("test-v1");
    expect(state.artifactsState).toBe(artifactsState);
  });

  it("keeps execution view and legacy fields synchronized", () => {
    const state = new WorkflowState();
    const executionState = state.executionState;

    state.goal = "review";
    state.taskStatuses["design-1"] = "running";
    expect(executionState.goal).toBe("review");
    expect(executionState.taskStatuses["design-1"]).toBe("running");

    executionState.runStatus = "failed";
    executionState.decisionCount = 7;
    expect(state.runStatus).toBe("failed");
    expect(state.decisionCount).toBe(7);
    expect(state.executionState).toBe(executionState);
  });

  it("keeps review view and legacy fields synchronized", () => {
    const state = new WorkflowState();
    const reviewState = state.reviewState;

    state.majorPendingTaskIds.add("design-1");
    expect(reviewState.majorPendingTaskIds.has("design-1")).toBe(true);

    reviewState.finalReviewDone = true;
    reviewState.finalReviewPassed = true;
    reviewState.finalReviewRevisions = { "design-1": 2 };
    expect(state.finalReviewDone).toBe(true);
    expect(state.finalReviewPassed).toBe(true);
    expect(state.finalReviewRevisions["design-1"]).toBe(2);
    expect(state.reviewState).toBe(reviewState);
  });

  it("preserves addArtifact/addVerdict compatibility with subdomain views", () => {
    const state = new WorkflowState();

    state.addArtifact(
      createArtifact({
        taskId: "design-1",
        type: "design",
        content: "first design",
      }),
    );
    expect(state.artifacts["design-1"]).toBeDefined();
    expect(state.artifactsState.artifacts["design-1"]).toBe(state.artifacts["design-1"]);
    expect(state.artifactRevisionsByTask["design-1"]).toBe(1);

    state.addVerdict(
      createVerdict({
        passed: false,
        evaluatedTaskIds: ["design-1"],
        evaluatedRevisions: { "design-1": 1 },
        issues: [
          createIssue({
            severity: "blocker",
            targetTaskId: "design-1",
            targetTaskType: "design",
            description: "missing architecture",
          }),
        ],
      }),
    );

    expect(state.reviewStatusByTask["design-1"]).toBe("rejected");
    expect(state.reviewState.reviewStatusByTask["design-1"]).toBe("rejected");
    expect(state.verdicts).toHaveLength(1);
    expect(state.reviewState.verdicts).toHaveLength(1);
    expect(state.reviewState.reviewStatusByTask).toBe(state.reviewStatusByTask);
    expect(state.reviewState.verdicts).toBe(state.verdicts);
    expect(state.reviewState.evaluatedRevisionsByTask).toBe(state.evaluatedRevisionsByTask);
    expect(state.reviewState.acceptedRevisionsByTask).toBe(state.acceptedRevisionsByTask);
  });

  it("resets final review flags through review subdomain on addArtifact", () => {
    const state = new WorkflowState();
    const reviewState = state.reviewState;

    reviewState.finalReviewDone = true;
    reviewState.finalReviewPassed = true;
    reviewState.finalReviewRevisions = { "design-1": 2 };

    state.addArtifact(
      createArtifact({
        taskId: "design-1",
        type: "design",
        content: "updated design",
      }),
    );

    expect(reviewState.finalReviewDone).toBe(false);
    expect(reviewState.finalReviewPassed).toBe(false);
    expect(reviewState.finalReviewRevisions).toEqual({});
    expect(state.finalReviewDone).toBe(false);
    expect(state.finalReviewPassed).toBe(false);
    expect(state.finalReviewRevisions).toEqual({});
    expect(state.finalReviewRevisions).toBe(reviewState.finalReviewRevisions);
  });

  it("routes markTaskStatus through execution subdomain view", () => {
    const state = new WorkflowState();
    const executionState = state.executionState;
    const statusesRef = executionState.taskStatuses;
    const sessionsRef = executionState.taskSessions;

    state.markTaskStatus("design-1", "running", "session-1", { phase: "draft" });

    expect(executionState.taskStatuses["design-1"]).toBe("running");
    expect(executionState.taskSessions["design-1"]).toBe("session-1");
    expect(state.taskStatuses).toBe(statusesRef);
    expect(state.taskSessions).toBe(sessionsRef);
    expect(state.executionState.taskStatuses).toBe(statusesRef);
    expect(state.executionState.taskSessions).toBe(sessionsRef);
    expect(state.taskHistory).toHaveLength(1);
    expect(state.taskHistory[0]).toMatchObject({
      taskId: "design-1",
      status: "running",
      sessionId: "session-1",
      details: { phase: "draft" },
    });
  });
});
