import { describe, it, expect, vi } from "vitest";
import { AgentOrchestrator } from "../src/agent/orchestrator.js";
import { WorkflowState } from "../src/state.js";
import { TaskMailbox } from "../src/messaging.js";
import {
  createTask,
  createExecutionPlan,
  createArtifact,
  createVerdict,
  createIssue,
} from "../src/agent/types.js";
import type { LLMClient } from "../src/llmClient.js";
import { getMemory, MemoryStore, setMemory } from "../src/memory/store.js";
import { BudgetManager } from "../src/orchestration/budget.js";
import { OrchestrationConfig } from "../src/orchestration/config.js";
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

function finalReviewRevisions(state: WorkflowState): Record<string, number> {
  const revisions: Record<string, number> = {};
  for (const [taskId, snapshot] of Object.entries(state.finalArtifactSnapshots())) {
    revisions[taskId] = Number(snapshot.revision ?? 0);
    const sourceRevisions = snapshot.sourceRevisions;
    if (
      sourceRevisions &&
      typeof sourceRevisions === "object" &&
      !Array.isArray(sourceRevisions)
    ) {
      for (const [sourceTaskId, sourceRevision] of Object.entries(
        sourceRevisions as Record<string, unknown>,
      )) {
        revisions[sourceTaskId] = Number(sourceRevision ?? 0);
      }
    }
  }
  return revisions;
}

describe("AgentOrchestrator decisions", () => {
  // -----------------------------------------------------------------------
  // 1. Spawn ready work
  // -----------------------------------------------------------------------

  it("advances ready work when plan exists with no artifacts", async () => {
    const coordinator = new AgentOrchestrator(null);
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
    const coordinator = new AgentOrchestrator(mockLLM);
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
      const coordinator = new AgentOrchestrator(mockLLM);
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
    const coordinator = new AgentOrchestrator(mockLLM);
    const state = new WorkflowState();
    state.requirementText =
      "Draw Mermaid diagrams for a simple login flow.";

    const decision = await coordinator.decide(state, makeMailbox());

    expect(state.decisionCount).toBe(1);
    expect(decision.action).toBe("spawn");
    expect(decision.taskId).toBe("direct_diagrams");
  });

  it("falls back to pause when no plan exists and no LLM available", async () => {
    const coordinator = new AgentOrchestrator(null);
    const state = new WorkflowState();
    state.requirementText =
      "Build a multi-module campus management system.";

    const decision = await coordinator.decide(state, makeMailbox());

    // No LLM -> DeterministicPolicy returns null -> resolveNonDeterministic -> pause
    expect(decision.action).toBe("pause");
  });

  // -----------------------------------------------------------------------
  // 3. Final review before save
  // -----------------------------------------------------------------------

  it("requires final review when tasks completed but review is not current", async () => {
    const coordinator = new AgentOrchestrator(null);
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
    const coordinator = new AgentOrchestrator(null);
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
    const coordinator = new AgentOrchestrator(null);
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

  it("does not rerun final review after a rejected final-output snapshot", async () => {
    const coordinator = new AgentOrchestrator(null);
    const state = new WorkflowState();
    state.requirementText = "requirement";
    state.plan = createExecutionPlan({
      tasks: [
        createTask({ id: "analyze-1", type: "analyze", description: "analysis" }),
        createTask({ id: "design-2", type: "design", description: "design", dependsOn: ["analyze-1"] }),
        createTask({ id: "diagrams-state", type: "diagrams", description: "state diagram", dependsOn: ["design-2"] }),
        createTask({ id: "tests-2", type: "tests", description: "tests", dependsOn: ["design-2"] }),
      ],
    });
    state.addArtifact(createArtifact({
      taskId: "analyze-1",
      type: "analyze",
      content: { actors: [], functions: [], entities: [] },
    }));
    state.addArtifact(createArtifact({ taskId: "design-2", type: "design", content: "design" }));
    state.addArtifact(createArtifact({
      taskId: "diagrams-state",
      type: "diagrams",
      content: { state_diagram: "stateDiagram-v2\n[*] --> A" },
    }));
    state.addArtifact(createArtifact({
      taskId: "tests-2",
      type: "tests",
      content: JSON.stringify({ test_cases: [] }),
    }));
    for (const task of state.plan.tasks) state.markTaskStatus(task.id, "completed");

    state.addVerdict(createVerdict({
      passed: false,
      issues: [
        createIssue({
          severity: "major",
          scope: "local",
          targetTaskId: "design-2",
          targetTaskType: "design",
          targetField: "design_text",
          description: "missing promotion API",
          suggestion: "add promotion API",
        }),
      ],
      evaluatedTaskIds: ["analyze-final", "design-2", "diagrams-final", "tests-2"],
      evaluatedRevisions: finalReviewRevisions(state),
      isFinalReview: true,
    }));

    const decision = await coordinator.decide(state, makeMailbox());
    expect(decision.action).toBe("repair");
    expect(decision.taskId).toBe("design-2");
  });

  it("routes analyze upstream issues to replan, not repair", async () => {
    const coordinator = new AgentOrchestrator(null);
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
        evaluatedTaskIds: ["analyze-final"],
        evaluatedRevisions: finalReviewRevisions(state),
        isFinalReview: true,
      }),
    );

    const decision = await coordinator.decide(state, makeMailbox());
    // Upstream-scoped analyze issues should still escalate to replan,
    // not attempt local repair.
    expect(decision.action).toBe("replan");
  });

  it("escalates to replan after exhausting final review repair budget", async () => {
    const coordinator = new AgentOrchestrator(null);
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
    // Exhaust repair budget (maxFinalMajorRepairPerTask = 3)
    state.recordRepairAttempt("design-1");
    state.recordRepairAttempt("design-1");
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

  it("allows final-review repair within budget (before exhaustion)", async () => {
    const coordinator = new AgentOrchestrator(null);
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
    // Only 1 repair attempt (budget allows 3)
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
    expect(decision.action).toBe("repair");
  });

  it("escalates past final-review major issues when repair budget exhausted and planner running", async () => {
    const coordinator = new AgentOrchestrator(null);
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
    state.markTaskStatus("planner", "running");
    // Exhaust repair budget
    state.recordRepairAttempt("design-1");
    state.recordRepairAttempt("design-1");
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
    expect(decision.action).toBe("inspect");
    expect(decision.reason).toContain("still running");
  });

  it("waits when the rejected repair target is already running", async () => {
    const coordinator = new AgentOrchestrator(null);
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

  it("preserves final review state when artifact is revised (repair flow)", () => {
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

    // Repair adds a new artifact revision — should NOT reset final review
    // (otherwise orchestrator skips repair and re-triggers evaluation)
    state.addArtifact(
      createArtifact({ taskId: "design-1", type: "design", content: "v2" }),
    );

    expect(state.finalReviewDone).toBe(true);
    expect(state.finalReviewPassed).toBe(true);
    // qualityStatus is reset to unknown when artifacts change
    expect(state.qualityStatus).toBe("unknown");
  });

  // -----------------------------------------------------------------------
  // 7. Diagram rejection → regenerate after repair budget threshold
  // -----------------------------------------------------------------------

  it("routes repeated diagram rejection to regenerate", async () => {
    const coordinator = new AgentOrchestrator(null);
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

  it("regenerates a failed concrete plan task before replanning downstream work", async () => {
    const coordinator = new AgentOrchestrator(null);
    const state = new WorkflowState();
    state.requirementText = "requirement";
    state.plan = createExecutionPlan({
      tasks: [
        createTask({ id: "design-3", type: "design", description: "repair design" }),
      ],
    });
    state.markTaskStatus("design-3", "failed");

    const decision = await coordinator.decide(state, makeMailbox());

    expect(decision.action).toBe("regenerate");
    expect(decision.taskId).toBe("design-3");
  });

  // -----------------------------------------------------------------------
  // 8. Replan priority — new ready tasks take priority over old rejected
  // -----------------------------------------------------------------------

  it("prefers replan-ready tasks over old rejected artifacts", () => {
    const coordinator = new AgentOrchestrator(null);
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
    const coordinator = new AgentOrchestrator(null);
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
    const coordinator = new AgentOrchestrator(null);
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

describe("BudgetManager runtime guard", () => {
  it("blocks new work when remaining runtime is below the configured reserve", () => {
    const config = new OrchestrationConfig();
    config.maxRuntimeSeconds = 1800;
    config.minRuntimeRemainingForNewWorkSeconds = 180;
    const budget = new BudgetManager(config);

    expect(budget.hasRuntimeBudgetForNewWork(0, 1619)).toBe(true);
    expect(budget.hasRuntimeBudgetForNewWork(0, 1620)).toBe(true);
    expect(budget.hasRuntimeBudgetForNewWork(0, 1621)).toBe(false);
  });

  it("parses the new-work reserve from raw orchestration config", () => {
    const config = OrchestrationConfig.fromRaw({
      min_runtime_remaining_for_new_work_seconds: 240,
    });

    expect(config.minRuntimeRemainingForNewWorkSeconds).toBe(240);
  });

  it("requires a larger runtime reserve for upstream analyze work", () => {
    const config = new OrchestrationConfig();
    config.maxRuntimeSeconds = 1800;
    const budget = new BudgetManager(config);

    expect(budget.hasRuntimeBudgetForTaskType(0, "analyze", 1199)).toBe(true);
    expect(budget.hasRuntimeBudgetForTaskType(0, "analyze", 1201)).toBe(false);
    expect(budget.hasRuntimeBudgetForTaskType(0, "diagrams", 1559)).toBe(true);
    expect(budget.hasRuntimeBudgetForTaskType(0, "diagrams", 1561)).toBe(false);
  });
});
