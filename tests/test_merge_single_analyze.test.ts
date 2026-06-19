import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkflowState } from "../src/state.js";
import { ResultHandler } from "../src/runtime/resultHandler.js";
import { AnalyzeMerger } from "../src/generators/merge.js";
import {
  createArtifact,
  createTask,
  createExecutionPlan,
} from "../src/shared/types.js";

// Regression: a plan with a single `analyze` task must still go through the
// merge flow so that missingConstraintCandidates are promoted to formal
// constraints. Previously `tryMergeAnalyzeResults` early-returned when
// analyzeTasks.length <= 1, so merge() was never invoked.
describe("tryMergeAnalyzeResults — single analyze task", () => {
  it("runs merge() for a single analyze task and promotes missingConstraintCandidates", async () => {
    const state = new WorkflowState();
    state.setPlan(
      createExecutionPlan({
        tasks: [createTask({ id: "analyze-1", type: "analyze" })],
      }),
    );
    state.markTaskStatus("analyze-1", "completed", "s1");
    state.requirementText = "系统应支持用户登录";
    state.addArtifact(
      createArtifact({
        taskId: "analyze-1",
        type: "analyze",
        content: {
          actors: [{ id: "User", name: "User" }],
          entities: [{ id: "Account", name: "Account" }],
          functions: [
            {
              id: "F001",
              name: "Login",
              description: "用户登录",
              related_entities: ["Account"],
            },
          ],
          constraints: [],
          missingConstraintCandidates: [
            {
              description: "密码长度至少 8 位",
              source_text: "密码长度至少 8 位",
            },
          ],
        },
      }),
    );

    const events: string[] = [];
    const handler = new ResultHandler({
      backend: {} as never,
      mailbox: {} as never,
      logger: {} as never,
      // Real merger: single-artifact branch is deterministic (no LLM call).
      analyzeMerger: new AnalyzeMerger({} as never),
      outputManagerCtor: class {
        saveRequirementAnalysis() {}
      } as never,
      getInflight: () => new Map(),
      getActiveStreamContext: () => null,
      setActiveStreamContext: () => {},
      onEmitRuntimeEvent: (kind: string) => events.push(kind),
      onSnapshotState: () => ({}),
      onSaveArtifactIncrementally: () => {},
      onPersistValidatedCoordinatorDecision: () => {},
    });

    await handler.tryMergeAnalyzeResults(state);

    // merge_started / merge_completed must fire — proves merge() ran.
    expect(events).toContain("merge_started");
    expect(events).toContain("merge_completed");

    // requirementJson must be populated by the merge result.
    const req = state.requirementJson as Record<string, unknown> | null;
    expect(req).toBeTruthy();

    // missingConstraintCandidates must be promoted into formal constraints.
    const constraints = (req!.constraints as Array<Record<string, unknown>>) ?? [];
    expect(constraints.length).toBeGreaterThan(0);
    expect(
      constraints.some((c) =>
        String(c.description ?? "").includes("密码长度至少 8 位"),
      ),
    ).toBe(true);
  });

  it("does nothing when there are zero analyze tasks", async () => {
    const state = new WorkflowState();
    state.setPlan(
      createExecutionPlan({
        tasks: [createTask({ id: "design-1", type: "design" })],
      }),
    );

    const events: string[] = [];
    const handler = new ResultHandler({
      backend: {} as never,
      mailbox: {} as never,
      logger: {} as never,
      analyzeMerger: {} as never,
      outputManagerCtor: class {
        saveRequirementAnalysis() {}
      } as never,
      getInflight: () => new Map(),
      getActiveStreamContext: () => null,
      setActiveStreamContext: () => {},
      onEmitRuntimeEvent: (kind: string) => events.push(kind),
      onSnapshotState: () => ({}),
      onSaveArtifactIncrementally: () => {},
      onPersistValidatedCoordinatorDecision: () => {},
    });

    await handler.tryMergeAnalyzeResults(state);

    expect(events).not.toContain("merge_started");
    // merge() was never called, so requirementJson is untouched (no
    // constraints promoted from any artifact).
    const req = state.requirementJson as Record<string, unknown> | null;
    const constraints =
      (req?.constraints as Array<Record<string, unknown>> | undefined) ?? [];
    expect(constraints).toHaveLength(0);
  });

  it("still uses the filesystem OutputManager outputDir without throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rh-merge-"));
    const state = new WorkflowState();
    state.outputDir = dir;
    state.setPlan(
      createExecutionPlan({
        tasks: [createTask({ id: "analyze-1", type: "analyze" })],
      }),
    );
    state.markTaskStatus("analyze-1", "completed", "s1");
    state.requirementText = "系统应支持用户登录";
    state.addArtifact(
      createArtifact({
        taskId: "analyze-1",
        type: "analyze",
        content: {
          actors: [],
          entities: [],
          functions: [],
          constraints: [],
          missingConstraintCandidates: [
            { description: "登录失败需限流", source_text: "登录失败需限流" },
          ],
        },
      }),
    );

    const { OutputManager } = await import("../src/outputManager.js");
    const handler = new ResultHandler({
      backend: {} as never,
      mailbox: {} as never,
      logger: {} as never,
      analyzeMerger: new AnalyzeMerger({} as never),
      outputManagerCtor: OutputManager as never,
      getInflight: () => new Map(),
      getActiveStreamContext: () => null,
      setActiveStreamContext: () => {},
      onEmitRuntimeEvent: () => {},
      onSnapshotState: () => ({}),
      onSaveArtifactIncrementally: () => {},
      onPersistValidatedCoordinatorDecision: () => {},
    });

    await expect(handler.tryMergeAnalyzeResults(state)).resolves.toBeUndefined();
    const req = state.requirementJson as Record<string, unknown> | null;
    expect(req).toBeTruthy();
    const constraints = (req!.constraints as Array<Record<string, unknown>>) ?? [];
    expect(constraints.length).toBeGreaterThan(0);
  });
});
