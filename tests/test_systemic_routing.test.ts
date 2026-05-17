/**
 * Tests for systemic issue routing: evaluator classifies issues by scope,
 * coordinator follows different paths based on snapshot state.
 *
 * Ported from ../tests/test_systemic_routing.py.
 */

import { describe, it, expect } from "vitest";

import { EvaluatorAgent } from "../src/agents/evaluator.js";
import { CoordinatorAgent } from "../src/agents/coordinator.js";
import { createIssue, createTask, createExecutionPlan, createArtifact } from "../src/agents/types.js";
import { WorkflowState } from "../src/state.js";
import { TaskMailbox, createTaskNotification } from "../src/messaging.js";

// ---------------------------------------------------------------------------
// EvaluatorAgent scope classification tests
// ---------------------------------------------------------------------------

describe("EvaluatorAgent._classifyIssueScope", () => {
  it("classifies an analyze blocker as systemic", () => {
    const issue = createIssue({
      severity: "blocker",
      targetTaskId: "analyze-1",
      targetTaskType: "analyze",
      description: "missing all functions",
    });
    const scope = EvaluatorAgent._classifyIssueScope(issue);
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
    const scope = EvaluatorAgent._classifyIssueScope(issue);
    expect(scope).toBe("local");
  });

  it("classifies a missing requirement field as upstream", () => {
    const issue = createIssue({
      severity: "major",
      targetTaskId: "design-1",
      targetTaskType: "design",
      targetField: "requirement_json.actors",
      description: "缺少 actors field导致设计不完整",
    });
    const scope = EvaluatorAgent._classifyIssueScope(issue);
    expect(scope).toBe("upstream");
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
      EvaluatorAgent._classifyIssueScope(issue);
    }
    expect(issues[0].scope).toBe("systemic");
    expect(issues[1].scope).toBe("local");
  });
});

// ---------------------------------------------------------------------------
// Coordinator routing tests
// ---------------------------------------------------------------------------

describe("CoordinatorAgent routing via decide()", () => {
  it("finishes when no requirement and no artifacts are loaded", async () => {
    const coordinator = new CoordinatorAgent(null);
    const state = new WorkflowState();
    // No requirementText set → requirementLoaded = false
    const mailbox = new TaskMailbox();

    const action = await coordinator.decide(state, mailbox);
    expect(action.action).toBe("finish");
  });

  it("routes to spawn when exactly one task is ready", async () => {
    const coordinator = new CoordinatorAgent(null);
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
    const coordinator = new CoordinatorAgent(null);
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
    const coordinator = new CoordinatorAgent(null);
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
