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
import { createTaskMessage } from "../src/messaging.js";
import {
  createArtifact,
  createExecutionPlan,
  createIssue,
  createTask,
  createVerdict,
} from "../src/shared/types.js";
import { GenerationSession, RepairSession } from "../src/tools/sessions.js";

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

  it("roundtrips task metadata and context provenance", () => {
    const issue = createIssue({
      severity: "major",
      targetTaskId: "design-1",
      targetTaskType: "design",
      description: "patch selected section",
    });
    const ctx = new SessionContext({
      task: createTask({
        id: "analyze-domain",
        type: "analyze",
        description: "domain analysis",
        dependsOn: [],
        contextHints: { assignedSections: ["S1"] },
        analysisMode: "domain",
        targeted: true,
        targetIssues: [issue],
        patchContext: {
          targetArtifactId: "analysis",
          targetSections: ["entities"],
        },
      }),
      taskId: "analyze-domain",
      taskType: "analyze",
      taskDescription: "domain analysis",
      registry: { entities: [], actors: [], functions: [] },
      previousIssues: [{ severity: "major", description: "old issue" }],
      provenance: {
        scope: "task",
        contentKind: "effective",
        sourceTaskIds: ["analyze-domain"],
        sourceRevisions: { "analyze-domain": 2 },
      },
    });

    const restored = SessionContext.fromDict(ctx.toDict());

    expect(restored.task?.analysisMode).toBe("domain");
    expect(restored.task?.dependsOn).toEqual([]);
    expect(restored.task?.targeted).toBe(true);
    expect(restored.task?.patchContext?.targetSections).toEqual(["entities"]);
    expect(restored.provenance).toEqual({
      scope: "task",
      contentKind: "effective",
      sourceTaskIds: ["analyze-domain"],
      sourceRevisions: { "analyze-domain": 2 },
    });
    expect(restored.registry?.entities).toEqual([]);
    expect(restored.previousIssues[0].description).toBe("old issue");
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

describe("Worker sessions", () => {
  it("passes task metadata but only analyze-relevant context into GenerationTool", async () => {
    const captured: Record<string, unknown> = {};
    const agent = {
      execute: async (task: unknown, context: unknown) => {
        captured.task = task;
        captured.context = context;
        return createArtifact({
          taskId: "analyze-domain",
          type: "analyze",
          content: { entities: [] },
        });
      },
    };
    const ctx = new SessionContext({
      task: createTask({
        id: "analyze-domain",
        type: "analyze",
        description: "domain analysis",
        analysisMode: "domain",
        contextHints: { availableConstraints: [] },
      }),
      taskId: "analyze-domain",
      taskType: "analyze",
      taskDescription: "domain analysis",
      requirementText: "req",
      diagrams: { sequence: "diagram" },
      testCases: "TC-001",
      artifactSummary: { "analyze-domain": { revision: 1 } },
      artifactSnapshots: { "analyze-domain": { revision: 1, content: {} } },
      provenance: {
        scope: "task",
        contentKind: "effective",
        sourceTaskIds: ["analyze-domain"],
        sourceRevisions: { "analyze-domain": 1 },
      },
    });
    const session = new GenerationSession("s1", ctx, null, null, agent as never);

    await session.run(createTaskMessage({ type: "spawn", taskId: "analyze-domain" }));

    const task = captured.task as ReturnType<typeof createTask>;
    const toolContext = captured.context as Record<string, unknown>;
    expect(task.analysisMode).toBe("domain");
    expect(toolContext.requirement_text).toBe("req");
    expect(toolContext.diagrams).toBeUndefined();
    expect(toolContext.test_cases).toBeUndefined();
    expect(toolContext.artifact_snapshots).toBeUndefined();
    expect(toolContext._provenance).toEqual({
      scope: "task",
      contentKind: "effective",
      sourceTaskIds: ["analyze-domain"],
      sourceRevisions: { "analyze-domain": 1 },
    });
  });

  it("sends diagram tasks filtered requirement fields and lossless design text", async () => {
    const captured: Record<string, unknown> = {};
    const agent = {
      execute: async (task: unknown, context: unknown) => {
        captured.task = task;
        captured.context = context;
        return createArtifact({
          taskId: "diagrams-class",
          type: "diagrams",
          content: { class_diagram: "classDiagram" },
        });
      },
    };
    const ctx = new SessionContext({
      task: createTask({
        id: "diagrams-class",
        type: "diagrams",
        description: "class diagram",
        contextHints: { diagram_kind: "class_diagram" },
      }),
      taskId: "diagrams-class",
      taskType: "diagrams",
      taskDescription: "class diagram",
      requirementJson: {
        actors: [{ id: "A_USER", name: "User" }],
        entities: [{ name: "Order", attributes: [{ name: "id", type: "string" }] }],
        functions: [{ id: "F001", name: "CreateOrder" }],
        constraints: [{ id: "C001", description: "must not leak into class context" }],
      },
      designText: [
        "# Design",
        "## 核心类设计",
        "Order class details",
        "## 接口设计",
        "API details that are not needed for class diagram",
      ].join("\n"),
      testCases: "TC-001",
      artifactSnapshots: { "design-1": { revision: 1, content: "large design" } },
    });
    const session = new GenerationSession("s-diagram", ctx, null, null, agent as never);

    await session.run(createTaskMessage({ type: "spawn", taskId: "diagrams-class" }));

    const toolContext = captured.context as Record<string, unknown>;
    expect(toolContext.requirement_json).toEqual({
      actors: [{ id: "A_USER", name: "User" }],
      entities: [{ name: "Order", attributes: [{ name: "id", type: "string" }] }],
    });
    expect(String(toolContext.design_text)).toContain("核心类设计");
    expect(String(toolContext.design_text)).toContain("接口设计");
    expect(toolContext.test_cases).toBeUndefined();
    expect(toolContext.artifact_snapshots).toBeUndefined();
  });

  it("keeps repair artifact revision and existing hints in repair context", async () => {
    const captured: Record<string, unknown> = {};
    const agent = {
      llm: {},
      repair: async (
        task: unknown,
        previousContent: unknown,
        fixInstructions: unknown,
        context: unknown,
      ) => {
        captured.task = task;
        captured.previousContent = previousContent;
        captured.fixInstructions = fixInstructions;
        captured.context = context;
        return "fixed design";
      },
    };
    const ctx = new SessionContext({
      task: createTask({
        id: "design-1",
        type: "design",
        description: "design",
        contextHints: { keep: "yes" },
      }),
      taskId: "design-1",
      taskType: "design",
      taskDescription: "design",
      requirementJson: { functions: [{ id: "FUN_A" }] },
      hints: {
        keep: "yes",
        previous_artifact_content: "old design",
        previous_artifact_type: "design",
        previous_artifact_revision: 3,
      },
      provenance: {
        scope: "repair",
        contentKind: "raw",
        sourceTaskIds: ["design-1"],
        sourceRevisions: { "design-1": 3 },
      },
    });
    const session = new RepairSession("s2", ctx, null, {}, agent as never);

    await session.run(createTaskMessage({
      type: "repair",
      taskId: "design-1",
      payload: {
        fix_instructions: [{ description: "fix it" }],
      },
    }));

    const repairContext = captured.context as Record<string, unknown>;
    const hints = repairContext._hints as Record<string, unknown>;
    expect(captured.previousContent).toBe("old design");
    expect(repairContext.previous_artifact_revision).toBe(3);
    expect(repairContext.artifact_snapshots).toBeUndefined();
    expect(repairContext.requirement_text).toBeUndefined();
    expect(hints.keep).toBe("yes");
    expect(hints.fix_instructions).toEqual([{ description: "fix it" }]);
    expect(repairContext._provenance).toEqual({
      scope: "repair",
      contentKind: "raw",
      sourceTaskIds: ["design-1"],
      sourceRevisions: { "design-1": 3 },
    });
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
