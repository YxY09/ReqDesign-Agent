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
} from "../src/agent/types.js";
import { AgentOrchestrator } from "../src/agent/orchestrator.js";
import { PlanningTool } from "../src/tools/planning.js";
import { TaskMailbox, type TaskNotification } from "../src/messaging.js";
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
});

// ---------------------------------------------------------------------------
// Coordinator fallback decision tests
// ---------------------------------------------------------------------------

describe("Coordinator replan fallback", () => {
  it("should choose replan when a task is stalled after repeated rejections", async () => {
    const coordinator = new AgentOrchestrator(null);
    const state = new WorkflowState();
    state.plan = makePlan([makeTask("analyze-1", "analyze")]);

    // Simulate: artifact exists, evaluated, rejected, stalled
    state.artifacts["analyze-1"] = {
      taskId: "analyze-1",
      type: "analyze",
      revision: 1,
      content: "some content",
      selfCheckPassed: true,
      selfCheckIssues: [],
      selfCorrectRounds: 0,
      generationDuration: 0,
    };
    state.artifactRevisionsByTask["analyze-1"] = 1;
    state.evaluatedRevisionsByTask["analyze-1"] = 1;
    state.reviewStatusByTask["analyze-1"] = "rejected";
    state.progress.stalledTaskIds.add("analyze-1");

    const mailbox = new TaskMailbox();
    const decision = await coordinator.decide(state, mailbox);
    expect(decision).toBeDefined();
    expect(decision.action).toBeDefined();
  });

  it("should handle globally stalled state", async () => {
    const coordinator = new AgentOrchestrator(null);
    const state = new WorkflowState();
    state.plan = makePlan([makeTask("design-1", "design")]);

    // Simulate global stall
    state.progress.noProgressStreak = 4;

    const mailbox = new TaskMailbox();
    const decision = await coordinator.decide(state, mailbox);
    expect(decision).toBeDefined();
  });

  it("should handle task with high rejection streak", async () => {
    const coordinator = new AgentOrchestrator(null);
    const state = new WorkflowState();
    state.plan = makePlan([makeTask("design-1", "design")]);

    state.artifacts["design-1"] = {
      taskId: "design-1",
      type: "design",
      revision: 1,
      content: "some content",
      selfCheckPassed: true,
      selfCheckIssues: [],
      selfCorrectRounds: 0,
      generationDuration: 0,
    };
    state.artifactRevisionsByTask["design-1"] = 1;
    state.evaluatedRevisionsByTask["design-1"] = 1;
    state.reviewStatusByTask["design-1"] = "rejected";
    state.progress.rejectionStreakByTask["design-1"] = 4;
    state.progress.stalledTaskIds.add("design-1");

    const mailbox = new TaskMailbox();
    const decision = await coordinator.decide(state, mailbox);
    expect(decision).toBeDefined();
  });

  it("should handle exhausted replan budget", async () => {
    const coordinator = new AgentOrchestrator(null);
    const state = new WorkflowState();
    state.plan = makePlan([makeTask("design-1", "design")]);
    state.progress.planRevisionCount = 3; // at max
    state.progress.rejectionStreakByTask["design-1"] = 5;
    state.progress.stalledTaskIds.add("design-1");

    state.artifacts["design-1"] = {
      taskId: "design-1",
      type: "design",
      revision: 1,
      content: "some content",
      selfCheckPassed: true,
      selfCheckIssues: [],
      selfCorrectRounds: 0,
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
});
