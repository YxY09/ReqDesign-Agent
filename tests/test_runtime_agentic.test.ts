import { describe, it, expect } from "vitest";

import {
  TaskMailbox,
  createTaskMessage,
  createTaskNotification,
  isTerminal,
  TERMINAL_EVENTS,
} from "../src/messaging.js";

import {
  WorkflowState,
} from "../src/state.js";

import {
  createArtifact,
  createVerdict,
  createTask,
  createExecutionPlan,
  createIssue,
} from "../src/shared/types.js";

// ---------------------------------------------------------------------------
// Mailbox
// ---------------------------------------------------------------------------

describe("Mailbox", () => {
  it("poll consumes items; subsequent polls return empty", () => {
    const mailbox = new TaskMailbox();

    mailbox.sendNotification(
      createTaskNotification({ taskId: "t1", sessionId: "s1", status: "completed" }),
    );
    expect(mailbox.hasNotifications()).toBe(true);

    const batch = mailbox.pollNotifications();
    expect(batch).toHaveLength(1);
    expect(batch[0].taskId).toBe("t1");

    // Consumed — second poll is empty
    expect(mailbox.hasNotifications()).toBe(false);
    expect(mailbox.pollNotifications()).toHaveLength(0);
  });

  it("filters messages by sessionId", () => {
    const mailbox = new TaskMailbox();
    mailbox.sendMessage(createTaskMessage({ type: "spawn", taskId: "t1", sessionId: "s1" }));
    mailbox.sendMessage(createTaskMessage({ type: "spawn", taskId: "t2", sessionId: "s2" }));

    // pollMessages with a sessionId filter advances the cursor past ALL
    // pending messages but only returns those matching the filter.
    const s1 = mailbox.pollMessages("s1");
    expect(s1).toHaveLength(1);
    expect(s1[0].taskId).toBe("t1");

    // The non-matching messages are consumed but not returned by the
    // filtered poll. Use peekAllMessages / resetCursors if you need them.
    expect(mailbox.hasMessages()).toBe(false);
  });

  it("peekAllMessages allows inspecting before consuming", () => {
    const mailbox = new TaskMailbox();
    mailbox.sendMessage(createTaskMessage({ type: "spawn", taskId: "t1", sessionId: "s1" }));
    mailbox.sendMessage(createTaskMessage({ type: "spawn", taskId: "t2", sessionId: "s2" }));
    mailbox.sendMessage(createTaskMessage({ type: "spawn", taskId: "t3", sessionId: "s1" }));

    // peekAllMessages returns everything regardless of session, without consuming
    const peeked = mailbox.peekAllMessages();
    expect(peeked).toHaveLength(3);
    expect(mailbox.hasMessages()).toBe(true);

    // Now consume with filter — only s1 messages returned
    const s1 = mailbox.pollMessages("s1");
    expect(s1.map((m) => m.taskId)).toEqual(["t1", "t3"]);
  });

  it("generateSessionId returns unique IDs containing the task id", () => {
    const sid1 = TaskMailbox.generateSessionId("task-1");
    const sid2 = TaskMailbox.generateSessionId("task-1");
    expect(sid1).not.toBe(sid2);
    expect(sid1).toContain("task-1");
    expect(sid2).toContain("task-1");
  });

  it("peekLatestNotification returns last without consuming", () => {
    const mailbox = new TaskMailbox();
    mailbox.sendNotification(
      createTaskNotification({ taskId: "t1", sessionId: "s1", status: "completed" }),
    );
    mailbox.sendNotification(
      createTaskNotification({ taskId: "t2", sessionId: "s2", status: "failed" }),
    );

    const latest = mailbox.peekLatestNotification();
    expect(latest).not.toBeNull();
    expect(latest!.taskId).toBe("t2");
    expect(latest!.status).toBe("failed");

    // Not consumed
    expect(mailbox.hasNotifications()).toBe(true);
  });

  it("pollNotifications can filter by taskId and status", () => {
    const mailbox = new TaskMailbox();
    mailbox.sendNotification(
      createTaskNotification({ taskId: "t1", sessionId: "s1", status: "completed" }),
    );
    mailbox.sendNotification(
      createTaskNotification({ taskId: "t2", sessionId: "s2", status: "failed" }),
    );
    mailbox.sendNotification(
      createTaskNotification({ taskId: "t1", sessionId: "s1b", status: "failed" }),
    );

    // peekAllNotifications to verify all three are present
    expect(mailbox.peekAllNotifications()).toHaveLength(3);

    // Filtered poll consumes all but returns only matches
    const t1Completed = mailbox.pollNotifications("t1", "completed");
    expect(t1Completed).toHaveLength(1);
    expect(t1Completed[0].sessionId).toBe("s1");

    // All notifications consumed by the poll — nothing left
    expect(mailbox.hasNotifications()).toBe(false);
  });

  it("resetCursors allows re-reading previously consumed items", () => {
    const mailbox = new TaskMailbox();
    mailbox.sendNotification(
      createTaskNotification({ taskId: "t1", sessionId: "s1", status: "completed" }),
    );
    mailbox.pollNotifications(); // consume
    expect(mailbox.hasNotifications()).toBe(false);

    mailbox.resetCursors();
    expect(mailbox.hasNotifications()).toBe(true);
    expect(mailbox.pollNotifications()).toHaveLength(1);
  });

  it("clear removes all messages and notifications", () => {
    const mailbox = new TaskMailbox();
    mailbox.sendMessage(createTaskMessage({ type: "spawn", taskId: "t1", sessionId: "s1" }));
    mailbox.sendNotification(
      createTaskNotification({ taskId: "t1", sessionId: "s1", status: "completed" }),
    );

    mailbox.clear();
    expect(mailbox.hasMessages()).toBe(false);
    expect(mailbox.hasNotifications()).toBe(false);
  });

  it("messages are sorted by descending priority", () => {
    const mailbox = new TaskMailbox();
    mailbox.sendMessage(createTaskMessage({ type: "spawn", taskId: "low", sessionId: "s1", priority: 1 }));
    mailbox.sendMessage(createTaskMessage({ type: "spawn", taskId: "high", sessionId: "s1", priority: 10 }));
    mailbox.sendMessage(createTaskMessage({ type: "spawn", taskId: "mid", sessionId: "s1", priority: 5 }));

    const msgs = mailbox.pollMessages();
    expect(msgs.map((m) => m.taskId)).toEqual(["high", "mid", "low"]);
  });
});

// ---------------------------------------------------------------------------
// WorkflowState — task status marking & ready task IDs
// ---------------------------------------------------------------------------

describe("WorkflowState — task status", () => {
  it("markTaskStatus / taskStatus round-trip", () => {
    const state = new WorkflowState();
    expect(state.taskStatus("analyze-1")).toBe("pending");

    state.markTaskStatus("analyze-1", "running", "session-1");
    expect(state.taskStatus("analyze-1")).toBe("running");

    state.markTaskStatus("analyze-1", "completed");
    expect(state.taskStatus("analyze-1")).toBe("completed");
    expect(state.isTaskCompleted("analyze-1")).toBe(true);
  });

  it("getReadyTaskIds returns tasks whose dependencies are complete", () => {
    const state = new WorkflowState();
    state.plan = createExecutionPlan({
      tasks: [
        createTask({ id: "analyze-1", type: "analyze" }),
        createTask({ id: "design-1", type: "design", dependsOn: ["analyze-1"] }),
        createTask({ id: "diagrams-1", type: "diagrams", dependsOn: ["design-1"] }),
      ],
    });

    // Initially only analyze-1 is ready
    expect(state.getReadyTaskIds()).toEqual(["analyze-1"]);

    state.markTaskStatus("analyze-1", "completed");
    expect(state.getReadyTaskIds()).toEqual(["design-1"]);

    state.markTaskStatus("design-1", "completed");
    expect(state.getReadyTaskIds()).toEqual(["diagrams-1"]);
  });

  it("getReadyTaskIds excludes terminal statuses", () => {
    const state = new WorkflowState();
    state.plan = createExecutionPlan({
      tasks: [
        createTask({ id: "t1", type: "analyze" }),
        createTask({ id: "t2", type: "design" }),
      ],
    });

    state.markTaskStatus("t1", "failed");
    state.markTaskStatus("t2", "running");
    // Both are in terminal-status set for "ready" purposes
    expect(state.getReadyTaskIds()).toEqual([]);
  });

  it("getCompletedPlanTaskIds only returns plan tasks that are completed", () => {
    const state = new WorkflowState();
    state.plan = createExecutionPlan({
      tasks: [
        createTask({ id: "a", type: "analyze" }),
        createTask({ id: "b", type: "design" }),
      ],
    });
    state.markTaskStatus("a", "completed");
    state.markTaskStatus("b", "running");
    // Non-plan task that is completed should be excluded
    state.markTaskStatus("extra", "completed");

    expect(state.getCompletedPlanTaskIds()).toEqual(["a"]);
  });

  it("getRunningTaskIds / getFailedTaskIds", () => {
    const state = new WorkflowState();
    state.markTaskStatus("a", "running");
    state.markTaskStatus("b", "running");
    state.markTaskStatus("c", "failed");

    expect(state.getRunningTaskIds().sort()).toEqual(["a", "b"]);
    expect(state.getFailedTaskIds()).toEqual(["c"]);
  });

  it("recordRepairAttempt increments per-task repair budget counters", () => {
    const state = new WorkflowState();

    state.recordRepairAttempt("design-1");
    state.recordRepairAttempt("design-1");
    state.recordRepairAttempt("tests-1");

    expect(state.progress._counters["repair_count:design-1"]).toBe(2);
    expect(state.progress._counters["repair_count:tests-1"]).toBe(1);
  });

  it("getPendingTaskIds / getBlockedTaskIds", () => {
    const state = new WorkflowState();
    state.plan = createExecutionPlan({
      tasks: [
        createTask({ id: "a", type: "analyze" }),
        createTask({ id: "b", type: "design", dependsOn: ["a"] }),
      ],
    });
    // Both pending, b is blocked
    expect(state.getPendingTaskIds()).toEqual(["a", "b"]);
    expect(state.getBlockedTaskIds()).toEqual(["b"]);

    state.markTaskStatus("a", "completed");
    expect(state.getPendingTaskIds()).toEqual(["b"]);
    expect(state.getBlockedTaskIds()).toEqual([]);
  });

  it("getTaskById returns task info from plan", () => {
    const state = new WorkflowState();
    state.plan = createExecutionPlan({
      tasks: [
        createTask({
          id: "analyze-1",
          type: "analyze",
          description: "Analyze requirements",
          contextHints: { focusAreas: ["security"] },
        }),
      ],
    });

    const info = state.getTaskById("analyze-1");
    expect(info).not.toBeNull();
    expect(info!.id).toBe("analyze-1");
    expect(info!.type).toBe("analyze");
    expect((info!.contextHints as Record<string, unknown>).focusAreas).toEqual(["security"]);

    expect(state.getTaskById("unknown")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WorkflowState — artifact tracking
// ---------------------------------------------------------------------------

describe("WorkflowState — artifacts", () => {
  it("addArtifact stores artifact, increments revision, syncs aggregate", () => {
    const state = new WorkflowState();
    const art = createArtifact({
      taskId: "analyze-1",
      type: "analyze",
      content: { actors: [], functions: [], entities: [] },
    });
    state.addArtifact(art);

    expect(state.totalArtifacts).toBe(1);
    expect(state.artifacts["analyze-1"]).toBeDefined();
    expect(state.artifactRevisionsByTask["analyze-1"]).toBe(1);
    expect(state.requirementJson).toEqual({ actors: [], functions: [], entities: [] });
  });

  it("artifactSummary returns metadata per artifact", () => {
    const state = new WorkflowState();
    state.addArtifact(
      createArtifact({ taskId: "t1", type: "analyze", content: { actors: [] } }),
    );
    const summary = state.artifactSummary();

    expect(summary["t1"]).toBeDefined();
    expect(summary["t1"].type).toBe("analyze");
    expect(summary["t1"].revision).toBe(1);
    expect(summary["t1"].selfCheckPassed).toBe(true);
  });

  it("re-adding an artifact bumps revision", () => {
    const state = new WorkflowState();
    state.addArtifact(createArtifact({ taskId: "t1", type: "design", content: "v1" }));
    state.addArtifact(createArtifact({ taskId: "t1", type: "design", content: "v2" }));

    expect(state.artifactRevisionsByTask["t1"]).toBe(2);
    expect(state.artifacts["t1"].content).toBe("v2");
  });

  it("addVerdict does NOT auto-set finished", () => {
    const state = new WorkflowState();
    const verdict = createVerdict({ passed: true });
    state.addVerdict(verdict);

    expect(state.finished).toBe(false);
    expect(state.latestVerdict).not.toBeNull();
    expect(state.latestVerdict!.passed).toBe(true);
  });

  it("currentArtifactRevision / latestEvaluatedRevision", () => {
    const state = new WorkflowState();
    expect(state.currentArtifactRevision("t1")).toBe(0);
    expect(state.latestEvaluatedRevision("t1")).toBe(0);

    state.addArtifact(createArtifact({ taskId: "t1", type: "design", content: "v1" }));
    expect(state.currentArtifactRevision("t1")).toBe(1);
    expect(state.latestEvaluatedRevision("t1")).toBe(0);

    state.addVerdict(
      createVerdict({ passed: true, evaluatedTaskIds: ["t1"], evaluatedRevisions: { t1: 1 } }),
    );
    expect(state.latestEvaluatedRevision("t1")).toBe(1);
  });

  it("getUnevaluatedArtifactTaskIds", () => {
    const state = new WorkflowState();
    state.addArtifact(createArtifact({ taskId: "a", type: "design", content: "x" }));
    state.addArtifact(createArtifact({ taskId: "b", type: "design", content: "y" }));
    // Evaluate a
    state.addVerdict(
      createVerdict({ passed: true, evaluatedTaskIds: ["a"], evaluatedRevisions: { a: 1 } }),
    );

    expect(state.getUnevaluatedArtifactTaskIds()).toEqual(["b"]);
  });

  it("verdict tracks review status per task", () => {
    const state = new WorkflowState();
    state.addArtifact(createArtifact({ taskId: "d1", type: "design", content: "draft" }));
    state.addVerdict(
      createVerdict({
        passed: false,
        evaluatedTaskIds: ["d1"],
        evaluatedRevisions: { d1: 1 },
        issues: [
          createIssue({ severity: "blocker", targetTaskId: "d1", targetTaskType: "design" }),
        ],
      }),
    );

    expect(state.reviewStatusByTask["d1"]).toBe("rejected");
    expect(state.currentReviewStatus("d1")).toBe("rejected");

    // New artifact revision resets the review status
    state.addArtifact(createArtifact({ taskId: "d1", type: "design", content: "fixed" }));
    expect(state.currentReviewStatus("d1")).toBe("unknown");
  });

  it("final review sets quality status", () => {
    const state = new WorkflowState();
    state.addArtifact(createArtifact({ taskId: "d1", type: "design", content: "draft" }));
    state.addVerdict(
      createVerdict({
        passed: true,
        evaluatedTaskIds: ["d1"],
        evaluatedRevisions: { d1: 1 },
        isFinalReview: true,
      }),
    );

    expect(state.finalReviewDone).toBe(true);
    expect(state.finalReviewPassed).toBe(true);
    expect(state.qualityStatus).toBe("passed");
  });

  it("artifact snapshots", () => {
    const state = new WorkflowState();
    state.addArtifact(createArtifact({ taskId: "t1", type: "design", content: "hello" }));
    state.addArtifact(createArtifact({ taskId: "t2", type: "analyze", content: { actors: [] } }));

    const snap = state.artifactSnapshots(["t1"]);
    expect(Object.keys(snap)).toEqual(["t1"]);
    expect(snap["t1"].content).toBe("hello");
  });

  it("final artifact snapshots use aggregate analysis and latest single-output artifacts", () => {
    const state = new WorkflowState();
    state.addArtifact(createArtifact({ taskId: "analyze-1", type: "analyze", content: { actors: ["A"], functions: [{ id: "F001" }] } }));
    state.addArtifact(createArtifact({ taskId: "design-1", type: "design", content: "old design" }));
    state.addArtifact(createArtifact({ taskId: "design-2", type: "design", content: "new design" }));
    state.addArtifact(createArtifact({ taskId: "tests-1", type: "tests", content: "old tests" }));
    state.addArtifact(createArtifact({ taskId: "tests-2", type: "tests", content: "new tests" }));

    const snap = state.finalArtifactSnapshots();

    expect(snap["analyze-final"].content).toEqual({ actors: ["A"], functions: [{ id: "F001" }] });
    expect(snap["design-1"]).toBeUndefined();
    expect(snap["design-2"].content).toBe("new design");
    expect(snap["tests-1"]).toBeUndefined();
    expect(snap["tests-2"].content).toBe("new tests");
  });
});

// ---------------------------------------------------------------------------
// Notification creation helpers
// ---------------------------------------------------------------------------

describe("Notification helpers", () => {
  it("createTaskMessage applies defaults and overrides", () => {
    const msg = createTaskMessage({ taskId: "t1", type: "spawn" });

    expect(msg.taskId).toBe("t1");
    expect(msg.type).toBe("spawn");
    expect(msg.sessionId).toBe("");
    expect(msg.payload).toEqual({});
    expect(msg.priority).toBe(0);
  });

  it("createTaskMessage applies custom overrides", () => {
    const msg = createTaskMessage({
      taskId: "t1",
      type: "repair",
      sessionId: "s1",
      payload: { fixInstructions: ["add detail"] },
      priority: 5,
      cause: "evaluator rejected",
    });

    expect(msg.sessionId).toBe("s1");
    expect(msg.payload.fixInstructions).toEqual(["add detail"]);
    expect(msg.priority).toBe(5);
    expect(msg.cause).toBe("evaluator rejected");
  });

  it("createTaskNotification applies defaults and overrides", () => {
    const notif = createTaskNotification({
      taskId: "t1",
      sessionId: "s1",
      status: "completed",
    });

    expect(notif.taskId).toBe("t1");
    expect(notif.sessionId).toBe("s1");
    expect(notif.status).toBe("completed");
    expect(notif.result).toBeNull();
    expect(notif.suggestions).toEqual([]);
    expect(notif.event).toBe("result");
  });

  it("createTaskNotification preserves custom fields", () => {
    const notif = createTaskNotification({
      taskId: "t1",
      sessionId: "s1",
      status: "rejected",
      summary: "bad quality",
      suggestions: [{ taskId: "t1", taskType: "design", suggestion: "fix" }],
      event: "result",
    });

    expect(notif.summary).toBe("bad quality");
    expect(notif.suggestions).toHaveLength(1);
    expect((notif.suggestions[0] as Record<string, unknown>).taskType).toBe("design");
  });

  it("isTerminal returns true for terminal events", () => {
    const terminal = createTaskNotification({
      taskId: "t1",
      sessionId: "s1",
      status: "completed",
      event: "result",
    });
    expect(isTerminal(terminal)).toBe(true);

    const timeout = createTaskNotification({
      taskId: "t1",
      sessionId: "s1",
      status: "failed",
      event: "timeout",
    });
    expect(isTerminal(timeout)).toBe(true);
  });

  it("isTerminal returns true when terminal flag is set", () => {
    const flagged = createTaskNotification({
      taskId: "t1",
      sessionId: "s1",
      status: "running",
      terminal: true,
    });
    expect(isTerminal(flagged)).toBe(true);
  });

  it("isTerminal returns false for non-terminal events", () => {
    for (const event of ["started", "heartbeat", "resumed", "inspect"] as const) {
      const notif = createTaskNotification({
        taskId: "t1",
        sessionId: "s1",
        status: "running",
        event,
      });
      expect(isTerminal(notif)).toBe(false);
    }
  });

  it("TERMINAL_EVENTS contains expected events", () => {
    expect(TERMINAL_EVENTS.has("result")).toBe(true);
    expect(TERMINAL_EVENTS.has("timeout")).toBe(true);
    expect(TERMINAL_EVENTS.has("cancel_requested")).toBe(true);
    expect(TERMINAL_EVENTS.has("started")).toBe(false);
    expect(TERMINAL_EVENTS.has("heartbeat")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// State DAG — cycle detection
// ---------------------------------------------------------------------------

describe("State DAG — checkDag", () => {
  it("returns empty array for a valid DAG", () => {
    const graph = new Map<string, Set<string>>([
      ["a", new Set()],
      ["b", new Set(["a"])],
      ["c", new Set(["b"])],
    ]);
    expect(WorkflowState.checkDag(graph)).toEqual([]);
  });

  it("detects a simple cycle", () => {
    const graph = new Map<string, Set<string>>([
      ["a", new Set(["b"])],
      ["b", new Set(["a"])],
    ]);
    const errors = WorkflowState.checkDag(graph);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("cycle");
  });

  it("detects a self-loop", () => {
    const graph = new Map<string, Set<string>>([
      ["a", new Set(["a"])],
    ]);
    const errors = WorkflowState.checkDag(graph);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("cycle");
  });

  it("detects a longer cycle", () => {
    const graph = new Map<string, Set<string>>([
      ["a", new Set(["c"])],
      ["b", new Set(["a"])],
      ["c", new Set(["b"])],
    ]);
    const errors = WorkflowState.checkDag(graph);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("cycle");
  });

  it("handles disconnected components", () => {
    const graph = new Map<string, Set<string>>([
      ["a", new Set()],
      ["b", new Set()],
      ["c", new Set(["a"])],
    ]);
    expect(WorkflowState.checkDag(graph)).toEqual([]);
  });

  it("handles empty graph", () => {
    const graph = new Map<string, Set<string>>();
    expect(WorkflowState.checkDag(graph)).toEqual([]);
  });

  it("ignores dependencies on nodes not in the graph", () => {
    const graph = new Map<string, Set<string>>([
      ["a", new Set(["external"])],
      ["b", new Set(["a"])],
    ]);
    // external is not a key in the graph — should be ignored, no cycle
    expect(WorkflowState.checkDag(graph)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Plan mutation (uses DAG check internally)
// ---------------------------------------------------------------------------

describe("WorkflowState — mutatePlan", () => {
  it("rejects invalid task types", () => {
    const state = new WorkflowState();
    state.plan = createExecutionPlan({ tasks: [createTask({ id: "a", type: "analyze" })] });

    const errors = state.mutatePlan({
      addTasks: [createTask({ id: "bad", type: "unknown" as any })],
      updateTasks: [],
      dropTaskIds: [],
      reorderEdges: {},
      reasoning: "test",
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("invalid task type");
  });

  it("rejects dropping a completed task", () => {
    const state = new WorkflowState();
    state.plan = createExecutionPlan({ tasks: [createTask({ id: "a", type: "analyze" })] });
    state.markTaskStatus("a", "completed");

    const errors = state.mutatePlan({
      addTasks: [],
      updateTasks: [],
      dropTaskIds: ["a"],
      reorderEdges: {},
      reasoning: "drop done",
    });
    expect(errors).toEqual([expect.stringContaining("cannot drop completed task")]);
  });

  it("adds new tasks successfully", () => {
    const state = new WorkflowState();
    state.plan = createExecutionPlan({ tasks: [createTask({ id: "a", type: "analyze" })] });
    state.markTaskStatus("a", "completed");

    const errors = state.mutatePlan({
      addTasks: [createTask({ id: "b", type: "design", dependsOn: ["a"] })],
      updateTasks: [],
      dropTaskIds: [],
      reorderEdges: {},
      reasoning: "add design",
    });
    expect(errors).toEqual([]);
    expect(state.plan!.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(state.taskStatus("b")).toBe("pending");
  });

  it("rejects new task id that conflicts with existing", () => {
    const state = new WorkflowState();
    state.plan = createExecutionPlan({ tasks: [createTask({ id: "a", type: "analyze" })] });

    const errors = state.mutatePlan({
      addTasks: [createTask({ id: "a", type: "design" })],
      updateTasks: [],
      dropTaskIds: [],
      reorderEdges: {},
      reasoning: "dupe",
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("conflicts with existing");
  });

  it("rejects dangling dependencies", () => {
    const state = new WorkflowState();
    state.plan = createExecutionPlan({ tasks: [createTask({ id: "a", type: "analyze" })] });

    const errors = state.mutatePlan({
      addTasks: [createTask({ id: "b", type: "design", dependsOn: ["nonexistent"] })],
      updateTasks: [],
      dropTaskIds: [],
      reorderEdges: {},
      reasoning: "dangling",
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("non-existent");
  });
});
