import { describe, it, expect } from "vitest";

import { WorkflowState } from "../src/state.js";
import { ResultHandler } from "../src/runtime/resultHandler.js";
import { createArtifact } from "../src/shared/types.js";
import { createTaskNotification } from "../src/messaging.js";

/**
 * Regression: a self-check FAILURE that leaves the domain_model EMPTY (0
 * concepts) must NOT be silently accepted. Previously the empty fallback
 * `{concepts:[],...}` was persisted as if valid and the task was reported
 * `completed`, poisoning every downstream consumer.
 *
 * Synthetic names (SynthAlpha / SynthBeta) only — detection is structural
 * (concept count == 0), never by name or domain.
 */

function makeHandler(opts: {
  onSaveArtifactIncrementally?: (artifactContent: unknown) => void;
  events: string[];
}) {
  return new ResultHandler({
    backend: {} as never,
    mailbox: {} as never,
    logger: {} as never,
    analyzeMerger: {} as never,
    outputManagerCtor: class {} as never,
    getInflight: () => new Map(),
    getActiveStreamContext: () => null,
    setActiveStreamContext: () => {},
    onEmitRuntimeEvent: (kind) => opts.events.push(kind),
    onSnapshotState: () => ({}),
    onSaveArtifactIncrementally: (_state, art) => {
      opts.onSaveArtifactIncrementally?.(art.content);
    },
    onPersistValidatedCoordinatorDecision: () => {},
  });
}

describe("empty domain_model rejection (self-check failure)", () => {
  it("rejects a domain_model with 0 concepts after self-check: task FAILS, no empty {concepts:[]} persisted", async () => {
    const state = new WorkflowState();
    state.requirementJson = { entities: [{ name: "SynthAlpha" }] };
    let savedDomainModel: unknown = "NOT_CALLED";
    const events: string[] = [];
    const handler = makeHandler({
      events,
      onSaveArtifactIncrementally: (content) => {
        savedDomainModel = content;
      },
    });

    const emptyModel = createArtifact({
      taskId: "dm-1",
      type: "domain_model",
      content: { concepts: [], generalizations: [], associations: [] },
      selfCheckPassed: false,
      selfCheckIssues: ["领域模型缺少 concepts"],
    });

    await handler.applyGeneratorCompletion(
      state,
      "dm-1",
      createTaskNotification({
        taskId: "dm-1",
        sessionId: "s1",
        status: "completed",
        result: emptyModel,
      }),
      "spawn",
    );

    // The task must FAIL — NOT be reported as completed.
    expect(state.taskStatus("dm-1")).toBe("failed");
    // No empty model stored in state.
    expect(state.artifacts["dm-1"]).toBeUndefined();
    // No empty {concepts:[]} persisted to disk.
    expect(savedDomainModel).toBe("NOT_CALLED");
    // No success event emitted; rejection surfaced as an error.
    expect(events).not.toContain("task_completed");
    expect(events).toContain("regenerate_rejected");
    expect(state.errors.at(-1)).toContain("0 concepts");
  });

  it("also rejects a null-content domain_model produced under self-check failure", async () => {
    const state = new WorkflowState();
    state.requirementJson = { entities: [{ name: "SynthAlpha" }] };
    let savedDomainModel: unknown = "NOT_CALLED";
    const events: string[] = [];
    const handler = makeHandler({
      events,
      onSaveArtifactIncrementally: (content) => {
        savedDomainModel = content;
      },
    });

    const nullModel = createArtifact({
      taskId: "dm-null",
      type: "domain_model",
      content: null,
      selfCheckPassed: false,
      selfCheckIssues: ["生成异常: stream truncated"],
    });

    await handler.applyGeneratorCompletion(
      state,
      "dm-null",
      createTaskNotification({
        taskId: "dm-null",
        sessionId: "s2",
        status: "completed",
        result: nullModel,
      }),
      "spawn",
    );

    expect(state.taskStatus("dm-null")).toBe("failed");
    expect(state.artifacts["dm-null"]).toBeUndefined();
    expect(savedDomainModel).toBe("NOT_CALLED");
    expect(events).not.toContain("task_completed");
    expect(state.errors.at(-1)).toContain("0 concepts");
  });

  it("does NOT hard-fail a non-empty flawed domain_model (issues flagged, task completed) — only the empty case hard-fails", async () => {
    const state = new WorkflowState();
    state.requirementJson = { entities: [{ name: "SynthAlpha" }] };
    let savedDomainModel: unknown = "NOT_CALLED";
    const events: string[] = [];
    const handler = makeHandler({
      events,
      onSaveArtifactIncrementally: (content) => {
        savedDomainModel = content;
      },
    });

    // A non-empty model with a self-check failure (one minor structural
    // issue). This is a partially-flawed but USABLE model — current behavior
    // (accept, flag issues, allow repair) must be preserved.
    const flawedModel = createArtifact({
      taskId: "dm-flawed",
      type: "domain_model",
      content: {
        concepts: [
          {
            id: "D001",
            name: "SynthBeta",
            kind: "entity",
            attributes: [{ name: "id", type: "string" }],
          },
        ],
        generalizations: [],
        associations: [],
      },
      selfCheckPassed: false,
      selfCheckIssues: ["关联端点缺失的次要警告"],
    });

    await handler.applyGeneratorCompletion(
      state,
      "dm-flawed",
      createTaskNotification({
        taskId: "dm-flawed",
        sessionId: "s3",
        status: "completed",
        result: flawedModel,
      }),
      "spawn",
    );

    // Non-empty model is accepted and persisted; task completes.
    expect(state.taskStatus("dm-flawed")).toBe("completed");
    expect(state.artifacts["dm-flawed"]).toBeDefined();
    expect(events).toContain("task_completed");
    const saved = savedDomainModel as { concepts?: unknown[] } | string;
    expect(typeof saved).toBe("object");
    expect((saved as { concepts: unknown[] }).concepts).toHaveLength(1);
  });

  it("does not reject a legitimately passing empty-free domain model", async () => {
    const state = new WorkflowState();
    state.requirementJson = { entities: [{ name: "SynthAlpha" }] };
    const events: string[] = [];
    const handler = makeHandler({ events });

    const goodModel = createArtifact({
      taskId: "dm-good",
      type: "domain_model",
      content: {
        concepts: [
          { id: "D001", name: "SynthAlpha", kind: "entity" },
          { id: "D002", name: "SynthBeta", kind: "entity" },
        ],
        generalizations: [],
        associations: [],
      },
      selfCheckPassed: true,
      selfCheckIssues: [],
    });

    await handler.applyGeneratorCompletion(
      state,
      "dm-good",
      createTaskNotification({
        taskId: "dm-good",
        sessionId: "s4",
        status: "completed",
        result: goodModel,
      }),
      "spawn",
    );

    expect(state.taskStatus("dm-good")).toBe("completed");
    expect(events).toContain("task_completed");
  });
});
