/**
 * Tests for SessionDescriptor and SessionContext serialization roundtrip.
 *
 * Ported from tests/test_session_descriptor.py.
 */
import { describe, it, expect } from "vitest";
import {
  SessionContext,
  SessionDescriptor,
  deepToPlainObject,
} from "../src/session.js";
import {
  createArtifact,
  createExecutionPlan,
  createIssue,
  createTask,
  createVerdict,
} from "../src/agent/types.js";

// ---------------------------------------------------------------------------
// SessionContext
// ---------------------------------------------------------------------------

describe("SessionContext", () => {
  it("should survive toDict / fromDict roundtrip", () => {
    const ctx = new SessionContext({
      taskId: "design-1",
      taskType: "design",
      taskDescription: "design the system",
      goal: "design",
      requirementText: "some requirement",
      requirementJson: { actors: ["user"] },
      designText: "design content",
      hints: { focus: "security" },
    });

    const d = ctx.toDict();
    const restored = SessionContext.fromDict(d);

    expect(restored.taskId).toBe("design-1");
    expect(restored.taskType).toBe("design");
    expect(restored.requirementJson).toEqual({ actors: ["user"] });
    expect(restored.hints).toEqual({ focus: "security" });
  });

  it("should use defaults for missing keys in fromDict", () => {
    const d = { taskId: "t1", taskType: "analyze" };
    const ctx = SessionContext.fromDict(d);

    expect(ctx.taskId).toBe("t1");
    expect(ctx.goal).toBe("design");
    expect(ctx.requirementText).toBe("");
    expect(ctx.hints).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// SessionDescriptor
// ---------------------------------------------------------------------------

describe("SessionDescriptor", () => {
  it("should survive toDict / fromDict roundtrip", () => {
    const desc = new SessionDescriptor({
      sessionId: "session-test-123",
      workerType: "generator",
      context: { taskId: "t1", taskType: "design" },
      intermediateState: {
        lastArtifact: { taskId: "t1", type: "design", content: "hello" },
      },
      resumeCount: 2,
      currentSequence: 5,
      messageCount: 3,
      status: "running",
    });

    const d = desc.toDict();
    const restored = SessionDescriptor.fromDict(d);

    expect(restored.sessionId).toBe("session-test-123");
    expect(restored.workerType).toBe("generator");
    expect(restored.resumeCount).toBe(2);
    expect(restored.currentSequence).toBe(5);
    expect(restored.status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// deepToPlainObject (ported from _dataclass_to_dict tests)
// ---------------------------------------------------------------------------

describe("deepToPlainObject", () => {
  it("should serialize an Artifact with dict content", () => {
    const art = createArtifact({
      taskId: "t1",
      type: "analyze",
      content: { actors: ["a"] },
    });
    const d = deepToPlainObject(art) as Record<string, unknown>;

    expect(d.taskId).toBe("t1");
    expect(d.content).toEqual({ actors: ["a"] });
    expect(d.selfCheckPassed).toBe(true);
  });

  it("should recursively serialize an ExecutionPlan with Tasks", () => {
    const plan = createExecutionPlan({
      tasks: [
        createTask({ id: "a1", type: "analyze", description: "analyze" }),
        createTask({
          id: "d1",
          type: "design",
          description: "design",
          dependsOn: ["a1"],
        }),
      ],
      goal: "design",
      reasoning: "test",
    });
    const d = deepToPlainObject(plan) as Record<string, unknown>;

    expect(d.goal).toBe("design");
    const tasks = d.tasks as Record<string, unknown>[];
    expect(tasks).toHaveLength(2);
    expect(tasks[1].dependsOn).toEqual(["a1"]);
  });

  it("should serialize a Verdict with issues", () => {
    const verdict = createVerdict({
      passed: false,
      issues: [
        createIssue({
          severity: "blocker",
          targetTaskId: "t1",
          description: "missing",
        }),
      ],
      summary: "failed",
    });
    const d = deepToPlainObject(verdict) as Record<string, unknown>;

    expect(d.passed).toBe(false);
    const issues = d.issues as Record<string, unknown>[];
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("blocker");
  });

  it("should return null for null input", () => {
    expect(deepToPlainObject(null)).toBeNull();
  });

  it("should handle primitives", () => {
    expect(deepToPlainObject("hello")).toBe("hello");
    expect(deepToPlainObject(42)).toBe(42);
    expect(deepToPlainObject(true)).toBe(true);
  });

  it("should handle lists with mixed types", () => {
    const result = deepToPlainObject([
      createTask({ id: "t1", type: "analyze" }),
      "hello",
    ]) as unknown[];

    expect(result).toHaveLength(2);
    const first = result[0] as Record<string, unknown>;
    expect(first.id).toBe("t1");
    expect(result[1]).toBe("hello");
  });
});
