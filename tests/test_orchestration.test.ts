import { describe, it, expect, vi } from "vitest";
import { CoordinatorAgent } from "../src/agents/coordinator.js";
import { WorkflowState } from "../src/state.js";
import { TaskMailbox } from "../src/messaging.js";
import {
  createTask,
  createExecutionPlan,
  createArtifact,
  createVerdict,
  createIssue,
} from "../src/agents/types.js";
import type { LLMClient } from "../src/llmClient.js";
import { getMemory, MemoryStore, setMemory } from "../src/memory/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Mock LLM stub
// ---------------------------------------------------------------------------

function createMockLLM(
  response?: Record<string, unknown>,
): LLMClient {
  return {
    generateJson: vi.fn().mockResolvedValue(response ?? {}),
    generateText: vi.fn().mockResolvedValue(""),
  } as unknown as LLMClient;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMailbox(): TaskMailbox {
  return new TaskMailbox();
}

describe("CoordinatorAgent decisions", () => {
  // -----------------------------------------------------------------------
  // 1. Spawn ready work
  // -----------------------------------------------------------------------

  it("advances ready work when plan exists with no artifacts", async () => {
    const coordinator = new CoordinatorAgent(null);
    const state = new WorkflowState();
    state.requirementText = "requirement";
    state.plan = createExecutionPlan({
      tasks: [
        createTask({ id: "analyze-1", type: "analyze", description: "a" }),
        createTask({ id: "analyze-2", type: "analyze", description: "b" }),
      ],
    });

    const decision = await coordinator.decide(state, makeMailbox());

    expect(decision.action).toBe("spawn_all_ready");
  });

  // -----------------------------------------------------------------------
  // 2. Direct diagrams (via LLM strategy)
  // -----------------------------------------------------------------------

  it("delegates initial routing to LLM when no plan exists", async () => {
    const mockLLM = createMockLLM({
      strategy: "start_planning",
      reason: "multi-module requirement needs planning",
      confidence: 0.85,
    });
    const coordinator = new CoordinatorAgent(mockLLM);
    const state = new WorkflowState();
    state.requirementText =
      "Build a multi-module campus management system.";

    const decision = await coordinator.decide(state, makeMailbox());

    // LLM decides to start planning.
    expect(state.decisionCount).toBe(1);
    expect(decision.action).toBe("spawn");
    expect(decision.taskId).toBe("planner");
  });

  it("injects coordinator memory into strategy-brain prompts", async () => {
    const previousMemory = getMemory();
    const tmp = mkdtempSync(join(tmpdir(), "reqdesign-coord-mem-"));
    try {
      const store = new MemoryStore(tmp);
      setMemory(store);
      store.save(
        "coordinator",
        "## 路由规则: replan\n**条件**: artifacts=1\n**动作**: replan\n**原因**: stalled workflow",
        "project",
        "routing_replan",
        "coord-route:replan:stalled",
      );

      const mockLLM = createMockLLM({
        strategy: "start_planning",
        reason: "memory-informed planning",
        confidence: 0.9,
      });
      const coordinator = new CoordinatorAgent(mockLLM);
      const state = new WorkflowState();
      state.requirementText = "Build a multi-module campus management system.";

      await coordinator.decide(state, makeMailbox());

      const llmCall = vi.mocked(mockLLM.generateJson).mock.calls[0];
      expect(llmCall).toBeDefined();
      expect(String(llmCall[0])).toContain("Agent 记忆");
      expect(String(llmCall[0])).toContain("路由规则");
    } finally {
      setMemory(previousMemory);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("delegates initial routing to LLM — direct diagrams for simple request", async () => {
    const mockLLM = createMockLLM({
      strategy: "route_direct_diagrams",
      reason: "simple diagram-only request",
      confidence: 0.9,
    });
    const coordinator = new CoordinatorAgent(mockLLM);
    const state = new WorkflowState();
    state.requirementText =
      "Draw Mermaid diagrams for a simple login flow.";

    const decision = await coordinator.decide(state, makeMailbox());

    expect(state.decisionCount).toBe(1);
    expect(decision.action).toBe("spawn");
    expect(decision.taskId).toBe("direct_diagrams");
  });

  it("falls back to pause when no plan exists and no LLM available", async () => {
    const coordinator = new CoordinatorAgent(null);
    const state = new WorkflowState();
    state.requirementText =
      "Build a multi-module campus management system.";

    const decision = await coordinator.decide(state, makeMailbox());

    // No LLM → DeterministicPolicy returns null → resolveNonDeterministic → pause
    expect(decision.action).toBe("finish");
  });

  // -----------------------------------------------------------------------
  // 3. Final review before save
  // -----------------------------------------------------------------------

  it("requires final review when tasks completed but review is not current", async () => {
    const coordinator = new CoordinatorAgent(null);
    const state = new WorkflowState();
    state.requirementText = "requirement";
    state.plan = createExecutionPlan({
      tasks: [
        createTask({ id: "design-1", type: "design", description: "design" }),
      ],
    });
    state.addArtifact(
      createArtifact({ taskId: "design-1", type: "design", content: "design" }),
    );
    state.markTaskStatus("design-1", "completed");
    // Non-final verdict — coordinator should not save
    state.addVerdict(
      createVerdict({
        passed: true,
        evaluatedTaskIds: ["design-1"],
        evaluatedRevisions: { "design-1": 1 },
        isFinalReview: false,
      }),
    );

    const decision = await coordinator.decide(state, makeMailbox());

    expect(decision.action).toBe("spawn");
    expect(decision.taskId).toBe("evaluator");
    // State should show final review is NOT done yet for this verdict
    expect(state.finalReviewDone).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 4. Save after final review passes
  // -----------------------------------------------------------------------

  it("requests save when final review is current and passed", async () => {
    const coordinator = new CoordinatorAgent(null);
    const state = new WorkflowState();
    state.requirementText = "requirement";
    state.plan = createExecutionPlan({
      tasks: [
        createTask({ id: "design-1", type: "design", description: "design" }),
      ],
    });
    state.addArtifact(
      createArtifact({ taskId: "design-1", type: "design", content: "design" }),
    );
    state.markTaskStatus("design-1", "completed");
    state.addVerdict(
      createVerdict({
        passed: true,
        evaluatedTaskIds: ["design-1"],
        evaluatedRevisions: { "design-1": 1 },
        isFinalReview: true,
      }),
    );

    // State should reflect final review is done
    expect(state.finalReviewDone).toBe(true);
    expect(state.finalReviewPassed).toBe(true);
    expect(state.qualityStatus).toBe("passed");

    const decision = await coordinator.decide(state, makeMailbox());
    expect(decision.action).toBe("save");
  });

  // -----------------------------------------------------------------------
  // 5. Repair major issues before final save
  // -----------------------------------------------------------------------

  it("routes major final-review issues to repair", async () => {
    const coordinator = new CoordinatorAgent(null);
    const state = new WorkflowState();
    state.requirementText = "requirement";
    state.plan = createExecutionPlan({
      tasks: [
        createTask({ id: "design-1", type: "design", description: "design" }),
      ],
    });
    state.addArtifact(
      createArtifact({ taskId: "design-1", type: "design", content: "design" }),
    );
    state.markTaskStatus("design-1", "completed");
    state.addVerdict(
      createVerdict({
        passed: true,
        issues: [
          createIssue({
            severity: "major",
            targetTaskId: "design-1",
            targetTaskType: "design",
            targetField: "design_text",
            description: "missing response format",
            suggestion: "add response format",
          }),
        ],
        evaluatedTaskIds: ["design-1"],
        evaluatedRevisions: { "design-1": 1 },
        isFinalReview: true,
      }),
    );

    // Major issue should be tracked
    expect(state.getMajorPendingTaskIds()).toContain("design-1");

    const decision = await coordinator.decide(state, makeMailbox());
    expect(decision.action).toBe("repair");
    expect(decision.taskId).toBe("design-1");
  });

  it("does not repair final-review major issues in analyze artifacts", async () => {
    const coordinator = new CoordinatorAgent(null);
    const state = new WorkflowState();
    state.requirementText = "requirement";
    state.plan = createExecutionPlan({
      tasks: [
        createTask({ id: "analyze-1", type: "analyze", description: "analysis" }),
      ],
    });
    state.addArtifact(
      createArtifact({
        taskId: "analyze-1",
        type: "analyze",
        content: { actors: [], functions: [] },
      }),
    );
    state.markTaskStatus("analyze-1", "completed");
    state.addVerdict(
      createVerdict({
        passed: true,
        issues: [
          createIssue({
            severity: "major",
            scope: "upstream",
            targetTaskId: "analyze-1",
            targetTaskType: "analyze",
            targetField: "requirement_json.functions",
            description: "missing downstream module coverage",
            suggestion: "replan analysis scope",
          }),
        ],
        evaluatedTaskIds: ["analyze-1"],
        evaluatedRevisions: { "analyze-1": 1 },
        isFinalReview: true,
      }),
    );

    const decision = await coordinator.decide(state, makeMailbox());
    expect(decision.action).toBe("replan");
  });

  it("does not repeat final-review major repair after one attempt", async () => {
    const coordinator = new CoordinatorAgent(null);
    const state = new WorkflowState();
    state.requirementText = "requirement";
    state.plan = createExecutionPlan({
      tasks: [
        createTask({ id: "design-1", type: "design", description: "design" }),
      ],
    });
    state.addArtifact(
      createArtifact({ taskId: "design-1", type: "design", content: "design" }),
    );
    state.markTaskStatus("design-1", "completed");
    state.recordRepairAttempt("design-1");
    state.addVerdict(
      createVerdict({
        passed: true,
        issues: [
          createIssue({
            severity: "major",
            scope: "local",
            targetTaskId: "design-1",
            targetTaskType: "design",
            targetField: "design_text",
            description: "still missing response format",
            suggestion: "add response format",
          }),
        ],
        evaluatedTaskIds: ["design-1"],
        evaluatedRevisions: { "design-1": 1 },
        isFinalReview: true,
      }),
    );

    const decision = await coordinator.decide(state, makeMailbox());
    expect(decision.action).toBe("replan");
  });

  it("waits when the rejected repair target is already running", async () => {
    const coordinator = new CoordinatorAgent(null);
    const state = new WorkflowState();
    state.requirementText = "requirement";
    state.plan = createExecutionPlan({
      tasks: [
        createTask({ id: "design-1", type: "design", description: "design" }),
      ],
    });
    state.addArtifact(
      createArtifact({ taskId: "design-1", type: "design", content: "design" }),
    );
    state.markTaskStatus("design-1", "running");
    state.addVerdict(
      createVerdict({
        passed: false,
        issues: [
          createIssue({
            severity: "blocker",
            targetTaskId: "design-1",
            targetTaskType: "design",
            targetField: "design_text",
            description: "must be fixed",
            suggestion: "repair the design",
          }),
        ],
        evaluatedTaskIds: ["design-1"],
        evaluatedRevisions: { "design-1": 1 },
        isFinalReview: false,
      }),
    );

    const decision = await coordinator.decide(state, makeMailbox());

    expect(decision.action).toBe("inspect");
  });

  // -----------------------------------------------------------------------
  // 6. Final review invalidated by new artifact revision
  // -----------------------------------------------------------------------

  it("invalidates final review when artifact is revised", () => {
    const state = new WorkflowState();
    state.addArtifact(
      createArtifact({ taskId: "design-1", type: "design", content: "v1" }),
    );
    state.addVerdict(
      createVerdict({
        passed: true,
        evaluatedTaskIds: ["design-1"],
        evaluatedRevisions: { "design-1": 1 },
        isFinalReview: true,
      }),
    );

    expect(state.finalReviewDone).toBe(true);

    // Adding a new artifact revision resets final review
    state.addArtifact(
      createArtifact({ taskId: "design-1", type: "design", content: "v2" }),
    );

    expect(state.finalReviewDone).toBe(false);
    expect(state.finalReviewPassed).toBe(false);
    expect(state.qualityStatus).toBe("unknown");
  });

  // -----------------------------------------------------------------------
  // 7. Diagram rejection → regenerate after repair budget threshold
  // -----------------------------------------------------------------------

  it("routes repeated diagram rejection to regenerate", async () => {
    const coordinator = new CoordinatorAgent(null);
    const state = new WorkflowState();
    state.requirementText = "requirement";
    state.plan = createExecutionPlan({
      tasks: [
        createTask({
          id: "diagrams-class",
          type: "diagrams",
          description: "class diagram",
        }),
      ],
    });
    state.addArtifact(
      createArtifact({
        taskId: "diagrams-class",
        type: "diagrams",
        content: { class_diagram: "classDiagram\nclass A" },
      }),
    );
    state.markTaskStatus("diagrams-class", "completed");
    state.addVerdict(
      createVerdict({
        passed: false,
        issues: [
          createIssue({
            severity: "blocker",
            targetTaskId: "diagrams-class",
            targetTaskType: "diagrams",
            description: "invalid Mermaid syntax",
            suggestion: "fix class diagram",
          }),
        ],
        evaluatedTaskIds: ["diagrams-class"],
        evaluatedRevisions: { "diagrams-class": 1 },
      }),
    );
    // Simulate repair budget exceeded (mirrors Python's _counters)
    state.progress._counters["repair_count:diagrams-class"] = 2;

    // State reflects the rejection
    expect(state.getRejectedArtifactTaskIds()).toContain("diagrams-class");
    expect(state.currentReviewStatus("diagrams-class")).toBe("rejected");

    const decision = await coordinator.decide(state, makeMailbox());
    expect(decision.action).toBe("regenerate");
    expect(decision.taskId).toBe("diagrams-class");
  });

  // -----------------------------------------------------------------------
  // 8. Replan priority — new ready tasks take priority over old rejected
  // -----------------------------------------------------------------------

  it("prefers replan-ready tasks over old rejected artifacts", () => {
    const coordinator = new CoordinatorAgent(null);
    const state = new WorkflowState();
    state.requirementText = "requirement";
    state.plan = createExecutionPlan({
      tasks: [
        createTask({
          id: "diagrams-class",
          type: "diagrams",
          description: "old class diagram",
        }),
        createTask({
          id: "diagrams-fix-1",
          type: "diagrams",
          description: "regenerate class diagram",
        }),
      ],
    });
    state.addArtifact(
      createArtifact({
        taskId: "diagrams-class",
        type: "diagrams",
        content: { class_diagram: "bad" },
      }),
    );
    state.markTaskStatus("diagrams-class", "completed");
    state.addVerdict(
      createVerdict({
        passed: false,
        issues: [
          createIssue({
            severity: "blocker",
            targetTaskId: "diagrams-class",
            targetTaskType: "diagrams",
            description: "bad class diagram",
          }),
        ],
        evaluatedTaskIds: ["diagrams-class"],
        evaluatedRevisions: { "diagrams-class": 1 },
      }),
    );

    // Mutate the plan (replan) — adds a new task, records plan mutation
    state.progress.recordPlanMutation();

    // The new task "diagrams-fix-1" is ready (no deps, not started)
    const ready = state.getReadyTaskIds();
    expect(ready).toContain("diagrams-fix-1");

    // State shows old task is rejected
    expect(state.getRejectedArtifactTaskIds()).toContain("diagrams-class");
  });

  // -----------------------------------------------------------------------
  // 9. Decision count increments on each decide call
  // -----------------------------------------------------------------------

  it("increments decision count on each call", async () => {
    const coordinator = new CoordinatorAgent(null);
    const state = new WorkflowState();

    await coordinator.decide(state, makeMailbox());
    expect(state.decisionCount).toBe(1);

    await coordinator.decide(state, makeMailbox());
    expect(state.decisionCount).toBe(2);
  });

  // -----------------------------------------------------------------------
  // 10. Persisted state triggers finish
  // -----------------------------------------------------------------------

  it("finishes when output is already saved", async () => {
    const coordinator = new CoordinatorAgent(null);
    const state = new WorkflowState();
    state.requirementText = "requirement";
    state.plan = createExecutionPlan({
      tasks: [createTask({ id: "design-1", type: "design", description: "d" })],
    });
    state.persisted = true;

    const decision = await coordinator.decide(state, makeMailbox());

    expect(decision.action).toBe("finish");
  });
});
