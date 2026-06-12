/**
 * Tests for systemic issue routing: evaluator classifies issues by scope,
 * coordinator follows different paths based on snapshot state.
 *
 * Ported from ../tests/test_systemic_routing.py.
 */

import { describe, it, expect } from "vitest";

import { EvaluationTool } from "../src/tools/evaluation.js";
import { AgentOrchestrator } from "../src/orchestration/orchestrator.js";
import { BudgetManager } from "../src/orchestration/budget.js";
import { createIssue, createTask, createExecutionPlan, createArtifact } from "../src/shared/types.js";
import { WorkflowState } from "../src/state.js";
import { TaskMailbox, createTaskNotification } from "../src/messaging.js";

// ---------------------------------------------------------------------------
// EvaluationTool scope classification tests
// ---------------------------------------------------------------------------

describe("EvaluationTool._classifyIssueScope", () => {
  it("classifies an analyze blocker as systemic", () => {
    const issue = createIssue({
      severity: "blocker",
      targetTaskId: "analyze-1",
      targetTaskType: "analyze",
      description: "missing all functions",
    });
    const scope = EvaluationTool._classifyIssueScope(issue);
    expect(scope).toBe("systemic");
  });

  it("classifies a minor field issue as local", () => {
    const issue = createIssue({
      severity: "minor",
      targetTaskId: "design-1",
      targetTaskType: "design",
      targetField: "design_text",
      description: "formatting issue",
    });
    const scope = EvaluationTool._classifyIssueScope(issue);
    expect(scope).toBe("local");
  });

  it("classifies a missing requirement field as upstream for analyze tasks", () => {
    const issue = createIssue({
      severity: "major",
      targetTaskId: "analyze-1",
      targetTaskType: "analyze",
      targetField: "requirement_json.actors",
      description: "缺少 actors field",
    });
    const scope = EvaluationTool._classifyIssueScope(issue);
    expect(scope).toBe("upstream");
  });

  it("classifies a requirement field reference as local for non-analyze tasks", () => {
    const issue = createIssue({
      severity: "major",
      targetTaskId: "design-1",
      targetTaskType: "design",
      targetField: "requirement_json.actors",
      description: "设计未覆盖需求中的 actors",
    });
    const scope = EvaluationTool._classifyIssueScope(issue);
    expect(scope).toBe("local");
  });

  it("sets scope in-place on the issue object", () => {
    const issues = [
      createIssue({
        severity: "blocker",
        targetTaskId: "analyze-1",
        targetTaskType: "analyze",
        description: "root error",
      }),
      createIssue({
        severity: "minor",
        targetTaskId: "design-1",
        targetTaskType: "design",
        description: "formatting",
      }),
    ];
    for (const issue of issues) {
      EvaluationTool._classifyIssueScope(issue);
    }
    expect(issues[0].scope).toBe("systemic");
    expect(issues[1].scope).toBe("local");
  });
});

// ---------------------------------------------------------------------------
// Coordinator routing tests
// ---------------------------------------------------------------------------

describe("AgentOrchestrator routing via decide()", () => {
  it("finishes when no requirement and no artifacts are loaded", async () => {
    const coordinator = new AgentOrchestrator(null, new BudgetManager(undefined));
    const state = new WorkflowState();
    // No requirementText set → requirementLoaded = false
    const mailbox = new TaskMailbox();

    const action = await coordinator.decide(state, mailbox);
    expect(action.action).toBe("finish");
  });

  it("routes to spawn when exactly one task is ready", async () => {
    const coordinator = new AgentOrchestrator(null, new BudgetManager(undefined));
    const state = new WorkflowState();
    state.requirementText = "Some requirement";
    state.plan = createExecutionPlan({
      tasks: [
        createTask({ id: "design-1", type: "design", description: "design" }),
      ],
    });
    // No artifacts, not persisted, no running tasks
    const mailbox = new TaskMailbox();

    const action = await coordinator.decide(state, mailbox);
    expect(action.action).toBe("spawn");
    expect(action.taskId).toBe("design-1");
  });

  it("routes to finish when output is saved", async () => {
    const coordinator = new AgentOrchestrator(null, new BudgetManager(undefined));
    const state = new WorkflowState();
    state.requirementText = "Some requirement";
    state.plan = createExecutionPlan({
      tasks: [
        createTask({ id: "design-1", type: "design", description: "design" }),
      ],
    });
    state.artifacts["design-1"] = createArtifact({
      taskId: "design-1",
      type: "design",
      content: "artifact content",
    });
    state.persisted = true;
    const mailbox = new TaskMailbox();

    const action = await coordinator.decide(state, mailbox);
    expect(action.action).toBe("finish");
  });

  it("routes to spawn when plan still has ready pending tasks", async () => {
    const coordinator = new AgentOrchestrator(null, new BudgetManager(undefined));
    const state = new WorkflowState();
    state.requirementText = "Some requirement";
    state.plan = createExecutionPlan({
      tasks: [
        createTask({ id: "design-1", type: "design", description: "design" }),
      ],
    });
    state.artifacts["design-1"] = createArtifact({
      taskId: "design-1",
      type: "design",
      content: "artifact content",
    });
    // Not persisted, has artifacts, no running tasks
    const mailbox = new TaskMailbox();

    const action = await coordinator.decide(state, mailbox);
    expect(action.action).toBe("spawn");
    expect(action.taskId).toBe("design-1");
  });
});
