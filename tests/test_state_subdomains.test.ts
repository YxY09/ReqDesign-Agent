import { describe, expect, it } from "vitest";
import {
  createArtifact,
  createExecutionPlan,
  createIssue,
  createPlanMutation,
  createTask,
  createVerdict,
} from "../src/shared/types.js";
import { WorkflowState } from "../src/state.js";
import { RunSummaryBuilder } from "../src/orchestration/runManager.js";

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

  it("preserves final review state on addArtifact (repair should not reset review)", () => {
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

    // Repair adding an artifact should NOT reset the final review state.
    // Resetting finalReviewDone on every addArtifact causes the orchestrator
    // to skip repair and re-trigger evaluation instead.
    expect(reviewState.finalReviewDone).toBe(true);
    expect(reviewState.finalReviewPassed).toBe(true);
    expect(reviewState.finalReviewRevisions).toEqual({ "design-1": 2 });
    expect(state.finalReviewDone).toBe(true);
    expect(state.finalReviewPassed).toBe(true);
    expect(state.finalReviewRevisions).toEqual({ "design-1": 2 });
    expect(state.finalReviewRevisions).toBe(reviewState.finalReviewRevisions);
  });

  // --- Task lifecycle / plan mutation tests ---

  it("tracks task lifecycle: pending → running → completed", () => {
    const state = new WorkflowState();
    state.setPlan(
      createExecutionPlan({
        tasks: [
          createTask({ id: "analyze-1", type: "analyze", description: "Analyze" }),
          createTask({ id: "design-1", type: "design", description: "Design", dependsOn: ["analyze-1"] }),
        ],
      }),
    );

    expect(state.taskStatus("analyze-1")).toBe("pending");
    expect(state.taskStatus("design-1")).toBe("pending");
    expect(state.getReadyTaskIds()).toEqual(["analyze-1"]);
    expect(state.getBlockedTaskIds()).toEqual(["design-1"]);

    state.markTaskStatus("analyze-1", "running");
    expect(state.isTaskRunning("analyze-1")).toBe(true);
    expect(state.getRunningTaskIds()).toEqual(["analyze-1"]);

    state.markTaskStatus("analyze-1", "completed");
    expect(state.isTaskCompleted("analyze-1")).toBe(true);
    expect(state.getCompletedTaskIds()).toEqual(["analyze-1"]);
    // design-1 is now unblocked
    expect(state.getReadyTaskIds()).toEqual(["design-1"]);
    expect(state.getBlockedTaskIds()).toEqual([]);
  });

  it("mutatePlan adds and drops tasks with DAG validation", () => {
    const state = new WorkflowState();
    state.setPlan(
      createExecutionPlan({
        tasks: [
          createTask({ id: "analyze-1", type: "analyze", description: "Analyze" }),
          createTask({ id: "design-1", type: "design", description: "Design", dependsOn: ["analyze-1"] }),
        ],
      }),
    );

    // Add a new task
    const errors = state.mutatePlan(
      createPlanMutation({
        addTasks: [createTask({ id: "tests-1", type: "tests", description: "Tests", dependsOn: ["design-1"] })],
        dropTaskIds: [],
        updateTasks: [],
        reorderEdges: {},
        reasoning: "add tests",
      }),
    );
    expect(errors).toEqual([]);
    expect(state.getPlanTaskIds()).toContain("tests-1");
    expect(state.taskStatus("tests-1")).toBe("pending");

    // Drop the new task
    const dropErrors = state.mutatePlan(
      createPlanMutation({
        addTasks: [],
        dropTaskIds: ["tests-1"],
        updateTasks: [],
        reorderEdges: {},
        reasoning: "drop tests",
      }),
    );
    expect(dropErrors).toEqual([]);
    expect(state.getPlanTaskIds()).not.toContain("tests-1");
  });

  it("mutatePlan protects artifact-backed tasks that are still depended on", () => {
    const state = new WorkflowState();
    state.setPlan(
      createExecutionPlan({
        tasks: [
          createTask({ id: "analyze-1", type: "analyze", description: "Analyze" }),
          createTask({ id: "design-1", type: "design", description: "Design", dependsOn: ["analyze-1"] }),
          createTask({ id: "diagrams-activity", type: "diagrams", description: "Activity", dependsOn: ["design-1"] }),
        ],
      }),
    );
    state.addArtifact(createArtifact({ taskId: "design-1", type: "design", content: "design" }));

    const errors = state.mutatePlan(
      createPlanMutation({
        addTasks: [
          createTask({ id: "design-2", type: "design", description: "Repair design", dependsOn: ["analyze-1"] }),
        ],
        dropTaskIds: ["design-1"],
        reasoning: "replace rejected design",
      }),
    );

    expect(errors).toEqual([]);
    expect(state.getPlanTaskIds()).toContain("design-1");
    expect(state.getPlanTaskIds()).toContain("design-2");
    expect(state.getTaskById("diagrams-activity")!.dependsOn).toContain("design-1");
  });

  it("mutatePlan rejects cycle and completed task drop", () => {
    const state = new WorkflowState();
    state.setPlan(
      createExecutionPlan({
        tasks: [
          createTask({ id: "analyze-1", type: "analyze", description: "A" }),
          createTask({ id: "design-1", type: "design", description: "D", dependsOn: ["analyze-1"] }),
        ],
      }),
    );

    // Mark analyze-1 as completed
    state.markTaskStatus("analyze-1", "completed");

    // Cannot drop completed task
    const dropErrors = state.mutatePlan(
      createPlanMutation({
        addTasks: [],
        dropTaskIds: ["analyze-1"],
        updateTasks: [],
        reorderEdges: {},
        reasoning: "bad drop",
      }),
    );
    expect(dropErrors.length).toBeGreaterThan(0);

    // Cannot create cycle: design-1 → analyze-1 → design-1
    // Both tasks still pending for reorderEdges to take effect
    const state2 = new WorkflowState();
    state2.setPlan(
      createExecutionPlan({
        tasks: [
          createTask({ id: "a", type: "analyze", description: "A" }),
          createTask({ id: "d", type: "design", description: "D", dependsOn: ["a"] }),
        ],
      }),
    );
    const cycleErrors = state2.mutatePlan(
      createPlanMutation({
        addTasks: [],
        dropTaskIds: [],
        updateTasks: [],
        reorderEdges: { a: ["d"], d: ["a"] },
        reasoning: "bad cycle",
      }),
    );
    expect(cycleErrors.length).toBeGreaterThan(0);
    expect(cycleErrors[0]).toContain("cycle");
  });

  // --- Artifact management tests ---

  it("addArtifact increments revision and syncs design aggregate", () => {
    const state = new WorkflowState();
    state.addArtifact(createArtifact({ taskId: "design-1", type: "design", content: "v1" }));
    expect(state.artifactsState.artifactRevisionsByTask["design-1"]).toBe(1);
    expect(state.artifactsState.designText).toBe("v1");

    state.addArtifact(createArtifact({ taskId: "design-1", type: "design", content: "v2" }));
    expect(state.artifactsState.artifactRevisionsByTask["design-1"]).toBe(2);
    expect(state.artifactsState.designText).toBe("v2");
  });

  it("addArtifact syncs test_cases and diagrams aggregates", () => {
    const state = new WorkflowState();
    state.addArtifact(createArtifact({ taskId: "tests-1", type: "tests", content: "TC-001" }));
    expect(state.artifactsState.testCases).toBe("TC-001");

    state.addArtifact(
      createArtifact({ taskId: "diag-1", type: "diagrams", content: { classDiagram: "class A{}" } }),
    );
    expect(state.artifactsState.diagrams).toEqual({ classDiagram: "class A{}" });

    // Second diagram merges
    state.addArtifact(
      createArtifact({ taskId: "diag-2", type: "diagrams", content: { sequenceDiagram: "A->B" } }),
    );
    expect(state.artifactsState.diagrams).toEqual({ classDiagram: "class A{}", sequenceDiagram: "A->B" });
  });

  it("flattens nested diagram content into aggregate state", () => {
    const state = new WorkflowState();

    state.addArtifact(createArtifact({
      taskId: "diagrams-activity",
      type: "diagrams",
      content: {
        diagrams: {
          activity_diagram: "flowchart TD\nA-->B",
        },
      },
    }));

    expect(state.diagrams.activity_diagram).toBe("flowchart TD\nA-->B");
    expect(state.diagrams.diagrams).toBeUndefined();
  });

  it("addArtifact clears majorPendingTaskIds and resets qualityStatus", () => {
    const state = new WorkflowState();
    state.majorPendingTaskIds.add("design-1");
    state.qualityStatus = "passed";

    state.addArtifact(createArtifact({ taskId: "design-1", type: "design", content: "fixed" }));
    expect(state.majorPendingTaskIds.size).toBe(0);
    expect(state.qualityStatus).toBe("unknown");
  });

  // --- Verdict / review status tests ---

  it("addVerdict marks task as passed when no blocker", () => {
    const state = new WorkflowState();
    state.addArtifact(createArtifact({ taskId: "design-1", type: "design", content: "v1" }));

    state.addVerdict(
      createVerdict({
        passed: true,
        evaluatedTaskIds: ["design-1"],
        evaluatedRevisions: { "design-1": 1 },
        issues: [],
      }),
    );

    expect(state.reviewStatusByTask["design-1"]).toBe("passed");
    expect(state.acceptedRevisionsByTask["design-1"]).toBe(1);
    expect(state.currentReviewStatus("design-1")).toBe("passed");
    expect(state.isCurrentArtifactAccepted("design-1")).toBe(true);
  });

  it("addVerdict records major pending for non-blocker major issues", () => {
    const state = new WorkflowState();
    state.addArtifact(createArtifact({ taskId: "design-1", type: "design", content: "v1" }));

    state.addVerdict(
      createVerdict({
        passed: false,
        evaluatedTaskIds: ["design-1"],
        evaluatedRevisions: { "design-1": 1 },
        issues: [
          createIssue({
            severity: "major",
            targetTaskId: "design-1",
            targetTaskType: "design",
            description: "minor style issue",
          }),
        ],
      }),
    );

    // Major but not blocker → passed but tracked in majorPending
    expect(state.reviewStatusByTask["design-1"]).toBe("passed");
    expect(state.majorPendingTaskIds.has("design-1")).toBe(true);
    expect(state.getMajorPendingTaskIds()).toEqual(["design-1"]);
  });

  it("final review sets finalReviewDone/Passed and qualityStatus", () => {
    const state = new WorkflowState();
    state.addArtifact(createArtifact({ taskId: "design-1", type: "design", content: "v1" }));

    state.addVerdict(
      createVerdict({
        passed: true,
        evaluatedTaskIds: ["design-1"],
        evaluatedRevisions: { "design-1": 1 },
        issues: [],
        isFinalReview: true,
      }),
    );

    expect(state.reviewState.finalReviewDone).toBe(true);
    expect(state.reviewState.finalReviewPassed).toBe(true);
    expect(state.qualityStatus).toBe("passed");
  });

  it("final review with major issues rejects quality but keeps repair routing", () => {
    const state = new WorkflowState();
    state.addArtifact(createArtifact({ taskId: "design-1", type: "design", content: "v1" }));

    state.addVerdict(
      createVerdict({
        passed: true,
        evaluatedTaskIds: ["design-1"],
        evaluatedRevisions: { "design-1": 1 },
        issues: [
          createIssue({
            severity: "major",
            targetTaskId: "design-1",
            targetTaskType: "design",
            description: "设计缺少关键约束",
          }),
        ],
        isFinalReview: true,
      }),
    );

    expect(state.reviewState.finalReviewDone).toBe(true);
    expect(state.reviewState.finalReviewPassed).toBe(false);
    expect(state.qualityStatus).toBe("rejected");
    expect(state.reviewResult.passed).toBe(false);
    expect(state.reviewResult.acceptedNoBlockers).toBe(true);
    expect(state.reviewStatusByTask["design-1"]).toBe("passed");
    expect(state.getMajorPendingTaskIds()).toEqual(["design-1"]);
  });

  it("run summary reports rejected quality after failed final review", () => {
    const state = new WorkflowState();
    state.finalReviewDone = true;
    state.finalReviewPassed = false;
    state.qualityStatus = "unknown";
    state.persistStatus = "partial_saved";

    const summary = RunSummaryBuilder.build(state);

    expect(summary.quality_status).toBe("rejected");
    expect(summary.failure_categories).toContain("quality_rejected");
  });

  it("getUnevaluatedArtifactTaskIds tracks pending evaluations", () => {
    const state = new WorkflowState();
    state.addArtifact(createArtifact({ taskId: "design-1", type: "design", content: "v1" }));
    state.addArtifact(createArtifact({ taskId: "tests-1", type: "tests", content: "t1" }));

    // Neither evaluated yet
    expect(state.getUnevaluatedArtifactTaskIds()).toEqual(["design-1", "tests-1"]);

    // Evaluate design-1
    state.addVerdict(
      createVerdict({
        passed: true,
        evaluatedTaskIds: ["design-1"],
        evaluatedRevisions: { "design-1": 1 },
        issues: [],
      }),
    );

    expect(state.getUnevaluatedArtifactTaskIds()).toEqual(["tests-1"]);
    expect(state.getRejectedArtifactTaskIds()).toEqual([]);
  });

  // --- Notification / repair tracking tests ---

  it("recordNotification and recordRepairAttempt track correctly", () => {
    const state = new WorkflowState();
    state.recordNotification({ type: "task_start", taskId: "design-1" });
    state.recordNotification({ type: "task_complete", taskId: "design-1" });

    expect(state.notifications).toHaveLength(2);
    expect(state.executionState.notifications).toHaveLength(2);

    state.recordRepairAttempt("design-1");
    state.recordRepairAttempt("design-1");
    expect(state.progress._counters["repair_count:design-1"]).toBe(2);
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
