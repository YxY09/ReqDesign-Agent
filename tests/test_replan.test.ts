/**
 * Tests for the replan integration:
 *   - Plan mutation (add/drop/update tasks, cycle detection)
 *   - Coordinator replan fallback
 *   - Planner replan
 *
 * Ported from tests/test_replan.py.
 */
import { describe, it, expect } from "vitest";
import { WorkflowState } from "../src/state.js";
import {
  type ExecutionPlan,
  type PlanMutation,
  type Task,
  type Issue,
  createTask,
  createExecutionPlan,
  createPlanMutation,
  createIssue,
} from "../src/shared/types.js";
import { AgentOrchestrator } from "../src/orchestration/orchestrator.js";
import { BudgetManager } from "../src/orchestration/budget.js";
import { PlanningTool } from "../src/tools/planning.js";
import {
  createTaskMessage,
  TaskMailbox,
  type TaskNotification,
} from "../src/messaging.js";
import { PlanningSession } from "../src/tools/sessions.js";
import {
  SessionContext,
  WorkerSession,
} from "../src/session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** LLM stub that returns a canned JSON response. */
class FakeLLM {
  private _response: Record<string, unknown>;
  calls: Array<{ prompt: string; system: string }> = [];

  constructor(response?: Record<string, unknown>) {
    this._response = response ?? {};
  }

  async generateJson(prompt: string, system = ""): Promise<unknown> {
    this.calls.push({ prompt, system });
    return this._response;
  }

  streamTag = "";
}

/** Build a minimal plan with given tasks. */
function makePlan(tasks: Task[], goal = "design"): ExecutionPlan {
  return createExecutionPlan({ tasks, goal });
}

/** Build a task with defaults. */
function makeTask(
  id: string,
  type: Task["type"] = "analyze",
  description = id,
  dependsOn: string[] = [],
): Task {
  return createTask({ id, type, description, dependsOn });
}

// ---------------------------------------------------------------------------
// Plan mutation tests
// ---------------------------------------------------------------------------

describe("Plan mutation", () => {
  it("should correctly add/drop tasks and maintain DAG", () => {
    const state = new WorkflowState();
    state.plan = makePlan([
      makeTask("analyze-1", "analyze"),
      makeTask("design-1", "design", "design", ["analyze-1"]),
    ]);
    state.markTaskStatus("analyze-1", "completed");

    const mutation = createPlanMutation({
      dropTaskIds: ["design-1"],
      addTasks: [makeTask("design-2", "design", "fresh design", ["analyze-1"])],
      reasoning: "test replan",
    });

    const errors = state.mutatePlan(mutation);

    expect(errors).toEqual([]);
    expect(state.plan).not.toBeNull();
    const taskIds = state.plan!.tasks.map((t) => t.id);
    expect(taskIds).not.toContain("design-1");
    expect(taskIds).toContain("design-2");
    expect(taskIds).toContain("analyze-1");
    expect(state.progress.planRevisionCount).toBe(1);
  });

  it("should reject dropping completed tasks", () => {
    const state = new WorkflowState();
    state.plan = makePlan([
      makeTask("analyze-1", "analyze"),
      makeTask("design-1", "design", "design", ["analyze-1"]),
    ]);
    state.markTaskStatus("analyze-1", "completed");

    const mutation = createPlanMutation({
      dropTaskIds: ["analyze-1"],
      reasoning: "try to drop completed",
    });

    const errors = state.mutatePlan(mutation);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("completed"))).toBe(true);
  });

  it("ignores completed drops when a replan also adds executable remediation tasks", () => {
    const state = new WorkflowState();
    state.plan = makePlan([
      makeTask("analyze-1", "analyze"),
      makeTask("design-1", "design", "design", ["analyze-1"]),
      makeTask("tests-1", "tests", "tests", ["design-1"]),
    ]);
    state.markTaskStatus("analyze-1", "completed");
    state.markTaskStatus("design-1", "completed");
    state.markTaskStatus("tests-1", "completed");

    const mutation = createPlanMutation({
      dropTaskIds: ["design-1", "tests-1"],
      addTasks: [
        makeTask("analyze-2", "analyze", "redo analysis"),
        makeTask("design-2", "design", "redo design", ["analyze-2"]),
        makeTask("tests-2", "tests", "redo tests", ["design-2"]),
      ],
      reasoning: "replace bad completed artifacts with a new remediation chain",
    });

    const errors = state.mutatePlan(mutation);

    expect(errors).toEqual([]);
    expect(state.getPlanTaskIds()).toEqual([
      "analyze-1",
      "design-1",
      "tests-1",
      "analyze-2",
      "design-2",
      "tests-2",
    ]);
    expect(state.getReadyTaskIds()).toEqual(["analyze-2"]);
    expect(state.progress.planRevisionCount).toBe(1);
  });

  it("should reject mutations that create cycles", () => {
    const state = new WorkflowState();
    state.plan = makePlan([
      makeTask("a", "analyze", "a"),
      makeTask("b", "design", "b", ["a"]),
      makeTask("c", "tests", "c", ["b"]),
    ]);

    // a depends on c → c depends on b → b depends on a → cycle
    const mutation = createPlanMutation({
      reorderEdges: { a: ["c"] },
      reasoning: "create cycle",
    });

    const errors = state.mutatePlan(mutation);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.toLowerCase().includes("cycle"))).toBe(true);
  });

  it("should update task descriptions and hints", () => {
    const state = new WorkflowState();
    state.plan = makePlan([
      makeTask("analyze-1", "analyze", "original"),
    ]);

    const mutation = createPlanMutation({
      updateTasks: [
        createTask({
          id: "analyze-1",
          type: "analyze",
          description: "updated description",
          contextHints: { focus: "security" },
        }),
      ],
      reasoning: "update task",
    });

    const errors = state.mutatePlan(mutation);
    expect(errors).toEqual([]);
    const taskInfo = state.getTaskById("analyze-1");
    expect(taskInfo).not.toBeNull();
    expect(taskInfo!.description).toBe("updated description");
  });

  it("should ignore immutable changes to completed tasks while applying other replan mutations", () => {
    const state = new WorkflowState();
    state.plan = makePlan([
      makeTask("analyze-1", "analyze"),
      makeTask("design-1", "design", "original design", ["analyze-1"]),
    ]);
    state.markTaskStatus("analyze-1", "completed");
    state.markTaskStatus("design-1", "completed");

    const mutation = createPlanMutation({
      updateTasks: [
        createTask({
          id: "design-1",
          type: "tests",
          description: "annotated completed task",
          dependsOn: [],
          contextHints: { note: "keep artifact, do not rerun" },
        }),
      ],
      addTasks: [
        makeTask("tests-help-audit", "tests", "add missing help and audit tests", ["design-1"]),
      ],
      reasoning: "repair remaining final review issues",
    });

    const errors = state.mutatePlan(mutation);

    expect(errors).toEqual([]);
    const design = state.plan!.tasks.find((task) => task.id === "design-1")!;
    expect(design.type).toBe("design");
    expect(design.dependsOn).toEqual(["analyze-1"]);
    expect(design.description).toBe("annotated completed task");
    expect(design.contextHints.note).toBe("keep artifact, do not rerun");
    expect(state.plan!.tasks.map((task) => task.id)).toContain("tests-help-audit");
    expect(state.taskStatus("tests-help-audit")).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Coordinator fallback decision tests
// ---------------------------------------------------------------------------

describe("Coordinator replan fallback", () => {
  it("handles a rejected artifact via the remediation ladder", async () => {
    const coordinator = new AgentOrchestrator(null, new BudgetManager(undefined));
    const state = new WorkflowState();
    state.plan = makePlan([makeTask("analyze-1", "analyze")]);

    // Artifact exists, was evaluated, and is rejected.
    state.artifacts["analyze-1"] = {
      taskId: "analyze-1",
      type: "analyze",
      revision: 1,
      content: "some content",
      selfCheckPassed: true,
      selfCheckIssues: [],
      generationDuration: 0,
    };
    state.artifactRevisionsByTask["analyze-1"] = 1;
    state.evaluatedRevisionsByTask["analyze-1"] = 1;
    state.reviewStatusByTask["analyze-1"] = "rejected";

    const mailbox = new TaskMailbox();
    const decision = await coordinator.decide(state, mailbox);
    expect(decision).toBeDefined();
    expect(decision.action).toBeDefined();
  });

  it("waits when the planner is already running", async () => {
    const coordinator = new AgentOrchestrator(null, new BudgetManager(undefined));
    const state = new WorkflowState();
    state.plan = makePlan([makeTask("design-1", "design")]);
    state.markTaskStatus("planner", "running");

    const decision = await coordinator.decide(state, new TaskMailbox());
    expect(decision.action).toBe("inspect");
  });

  it("should stop replanning after repeated planner failures", async () => {
    const coordinator = new AgentOrchestrator(null, new BudgetManager(undefined));
    const state = new WorkflowState();
    state.plan = makePlan([makeTask("design-1", "design")]);
    state.recordPlannerFailure();
    state.recordPlannerFailure();
    state.recordPlannerFailure();

    const decision = await coordinator.decide(state, new TaskMailbox());
    expect(decision.action).not.toBe("replan");
  });

  it("should handle exhausted replan budget", async () => {
    const coordinator = new AgentOrchestrator(null, new BudgetManager(undefined));
    const state = new WorkflowState();
    state.plan = makePlan([makeTask("design-1", "design")]);
    state.progress.planRevisionCount = 3; // at max

    state.artifacts["design-1"] = {
      taskId: "design-1",
      type: "design",
      revision: 1,
      content: "some content",
      selfCheckPassed: true,
      selfCheckIssues: [],
      generationDuration: 0,
    };
    state.artifactRevisionsByTask["design-1"] = 1;
    state.evaluatedRevisionsByTask["design-1"] = 1;
    state.reviewStatusByTask["design-1"] = "rejected";

    const mailbox = new TaskMailbox();
    const decision = await coordinator.decide(state, mailbox);
    expect(decision).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Planner replan tests
// ---------------------------------------------------------------------------

describe("Planner replan", () => {
  it("should produce a valid PlanMutation from LLM response", async () => {
    const fakeLLM = new FakeLLM({
      reasoning: "analyze was wrong",
      add_tasks: [{ id: "analyze-2", type: "analyze", description: "re-analyze" }],
      drop_task_ids: ["analyze-1"],
      update_tasks: [],
      reorder_edges: {},
    });

    const planner = new PlanningTool(fakeLLM as unknown as import("../src/llmClient.js").LLMClient);

    const currentPlan = makePlan([
      makeTask("analyze-1", "analyze", "original analyze"),
      makeTask("design-1", "design", "design", ["analyze-1"]),
    ]);

    const mutation = await planner.replan(
      "test requirement",
      currentPlan,
      [],
      ["analyze-1"],
      [createIssue({
        severity: "blocker",
        targetTaskId: "analyze-1",
        description: "missing core entities",
      })],
      null,
      "analyze-1 has fundamental errors",
    );

    expect(mutation).toBeDefined();
    expect(mutation.addTasks.length).toBe(1);
    expect(mutation.addTasks[0].id).toBe("analyze-2");
    expect(mutation.dropTaskIds).toContain("analyze-1");
  });

  it("PlanningSession replan requires current_plan payload and uses it when provided", async () => {
    const fakeLLM = new FakeLLM({
      reasoning: "split failed design",
      add_tasks: [{ id: "design-2", type: "design", description: "redo design" }],
      drop_task_ids: ["design-1"],
      update_tasks: [],
      reorder_edges: {},
    });
    const planner = new PlanningTool(fakeLLM as unknown as import("../src/llmClient.js").LLMClient);
    const currentPlan = makePlan([
      makeTask("analyze-1", "analyze"),
      makeTask("design-1", "design", "design", ["analyze-1"]),
    ]);
    const session = new PlanningSession(
      "planner-session",
      new SessionContext({
        taskId: "planner",
        taskType: "planner",
        requirementText: "test requirement",
      }),
      null,
      null,
      planner,
    );

    const missing = await session.run(createTaskMessage({
      type: "replan",
      taskId: "planner",
    }));
    expect(missing.status).toBe("failed");
    expect(missing.error).toContain("no plan to mutate");

    const completed = await session.run(createTaskMessage({
      type: "replan",
      taskId: "planner",
      payload: {
        current_plan: currentPlan,
        completed_task_ids: ["analyze-1"],
        failed_task_ids: ["design-1"],
        replan_reason: "design failed",
      },
    }));
    expect(completed.status).toBe("completed");
    const mutation = completed.result as PlanMutation;
    expect(mutation.dropTaskIds).toContain("design-1");
    expect(mutation.addTasks[0]?.id).toBe("design-2");
  });

  it("_parseResponse should add all analyze deps to design", () => {
    const fakeLLM = new FakeLLM({});
    const planner = new PlanningTool(fakeLLM as unknown as import("../src/llmClient.js").LLMClient);

    const plan = planner._parseResponse(
      {
        reasoning: "multi-domain",
        tasks: [
          { id: "analyze-1", type: "analyze", description: "users" },
          { id: "analyze-2", type: "analyze", description: "orders" },
          {
            id: "design-1",
            type: "design",
            description: "system design",
            depends_on: ["analyze-1"],
          },
        ],
      },
      "design",
    );

    const design = plan.tasks.find((t) => t.id === "design-1");
    expect(design).toBeDefined();
    expect(design!.dependsOn).toEqual(
      expect.arrayContaining(["analyze-1", "analyze-2"]),
    );
  });

  it("should produce fallback mutation on LLM failure", async () => {
    const fakeLLM = new FakeLLM();
    // Make generateJson throw
    fakeLLM.generateJson = async () => {
      throw new Error("LLM unavailable");
    };

    const planner = new PlanningTool(fakeLLM as unknown as import("../src/llmClient.js").LLMClient);

    const currentPlan = makePlan([
      makeTask("analyze-1", "analyze", "analyze"),
      makeTask("design-1", "design", "design", ["analyze-1"]),
    ]);

    const mutation = await planner.replan(
      "test requirement",
      currentPlan,
      ["analyze-1"],
      ["design-1"],
      null,
      null,
      "design-1 failed",
    );

    expect(mutation).toBeDefined();
    expect(mutation.dropTaskIds).toContain("design-1");
    expect(mutation.addTasks.length).toBeGreaterThan(0);
    expect(mutation.reasoning).toContain("fallback");
  });

  it("adds concrete remediation tasks for final aggregate activity and test issues", async () => {
    const fakeLLM = new FakeLLM({
      reasoning: "only fixed design, missed downstream targets",
      add_tasks: [{ id: "design-2", type: "design", description: "redo design", depends_on: ["analyze-1"] }],
      update_tasks: [],
      drop_task_ids: [],
      reorder_edges: {},
    });
    const planner = new PlanningTool(fakeLLM as unknown as import("../src/llmClient.js").LLMClient);
    const currentPlan = makePlan([
      makeTask("analyze-1", "analyze"),
      makeTask("design-1", "design", "design", ["analyze-1"]),
      makeTask("diagrams-activity", "diagrams", "activity", ["design-1"]),
      makeTask("tests-1", "tests", "tests", ["design-1"]),
    ]);

    const mutation = await planner.replan(
      "refund requirement",
      currentPlan,
      ["analyze-1", "design-1", "diagrams-activity", "tests-1"],
      [],
      [
        createIssue({
          severity: "major",
          scope: "local",
          targetTaskId: "diagrams-final",
          targetTaskType: "diagrams",
          targetField: "activity_diagram",
          description: "活动图缺少退货退款流程",
          suggestion: "补充退货退款活动分支",
        }),
        createIssue({
          severity: "major",
          scope: "local",
          targetTaskId: "tests-1",
          targetTaskType: "tests",
          targetField: "test_cases",
          description: "测试缺少完整退货退款正常场景",
          suggestion: "补充退款到账正常流",
        }),
      ],
      {},
      "final review rejected",
    );

    expect(mutation.addTasks.some((task) =>
      task.type === "diagrams" &&
      task.contextHints.diagram_kind === "activity_diagram",
    )).toBe(true);
    expect(mutation.addTasks.some((task) => task.type === "tests")).toBe(true);
    const activityTask = mutation.addTasks.find((task) =>
      task.type === "diagrams" &&
      task.contextHints.diagram_kind === "activity_diagram",
    );
    expect(activityTask?.dependsOn).toContain("design-2");
  });
});
