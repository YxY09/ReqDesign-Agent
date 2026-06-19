/**
 * Tests for the progress model: artifact-revision change detection and plan
 * mutation counting. (The legacy no-progress / rejection-streak / score-trend
 * machinery was removed — termination is owned by the convergence hard cap and
 * the finalMajor repair-futility gate, not a separate global-stall signal.)
 */

import { describe, it, expect } from "vitest";
import { ProgressSnapshot } from "../src/progress.js";
import { createArtifact } from "../src/shared/types.js";
import { WorkflowState } from "../src/state.js";

// ---------------------------------------------------------------------------
// ProgressSnapshot unit tests
// ---------------------------------------------------------------------------

describe("ProgressSnapshot", () => {
  it("should treat first artifact for a task as progress", () => {
    const progress = new ProgressSnapshot();
    const result = progress.recordArtifact("analyze-1", { actors: ["a"] });

    expect(result).toBe(true);
    expect(progress.artifactRevisionCount["analyze-1"]).toBe(1);
    expect(progress.lastProgressAt).toBeGreaterThan(0);
  });

  it("should not count same content hash as progress", () => {
    const progress = new ProgressSnapshot();
    const content = { actors: ["user"] };
    progress.recordArtifact("t1", content);

    const result = progress.recordArtifact("t1", content);
    expect(result).toBe(false);
  });

  it("should treat changed content as progress", () => {
    const progress = new ProgressSnapshot();
    progress.recordArtifact("t1", "short content");

    const result = progress.recordArtifact(
      "t1",
      "this is much longer content that should be different",
    );
    expect(result).toBe(true);
  });

  it("should increment plan_revision_count on recordPlanMutation", () => {
    const progress = new ProgressSnapshot();
    progress.recordPlanMutation();
    progress.recordPlanMutation();

    expect(progress.planRevisionCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Integration with WorkflowState
// ---------------------------------------------------------------------------

describe("WorkflowState progress integration", () => {
  it("should track progress when artifacts are added", () => {
    const state = new WorkflowState();
    state.goal = "design";

    const art1 = createArtifact({
      taskId: "analyze-1",
      type: "analyze",
      content: { actors: ["a"], functions: ["f"], entities: ["e"] },
    });
    state.addArtifact(art1);

    expect(state.progress.artifactRevisionCount["analyze-1"]).toBe(1);
  });

  it("should deduplicate scalar lists in aggregate requirement_json", () => {
    const state = new WorkflowState();
    state.goal = "design";

    state.addArtifact(
      createArtifact({
        taskId: "analyze-1",
        type: "analyze",
        content: { actors: ["Student"], functions: ["Login"], entities: ["User"] },
      }),
    );
    state.addArtifact(
      createArtifact({
        taskId: "analyze-2",
        type: "analyze",
        content: {
          actors: ["Student", "Admin"],
          functions: ["Login"],
          entities: ["User"],
        },
      }),
    );

    expect(state.requirementJson["actors"]).toEqual(["Student", "Admin"]);
    expect(state.requirementJson["functions"]).toEqual(["Login"]);
    expect(state.requirementJson["entities"]).toEqual(["User"]);
  });

  it("should rebuild aggregate requirement_json when an analyze task is regenerated", () => {
    const state = new WorkflowState();
    state.goal = "design";

    state.addArtifact(
      createArtifact({
        taskId: "analyze-1",
        type: "analyze",
        content: { actors: ["Student"], functions: ["Login"], entities: ["User"] },
      }),
    );
    state.addArtifact(
      createArtifact({
        taskId: "analyze-2",
        type: "analyze",
        content: { actors: ["Admin"], constraints: ["Audit"] },
      }),
    );
    state.addArtifact(
      createArtifact({
        taskId: "analyze-1",
        type: "analyze",
        content: { actors: ["Teacher"], functions: ["Review"] },
      }),
    );

    expect(state.requirementJson["actors"]).toEqual(["Teacher", "Admin"]);
    expect(state.requirementJson["functions"]).toEqual(["Review"]);
    expect(state.requirementJson["entities"]).toBeUndefined();
    expect(state.requirementJson["constraints"]).toEqual(["Audit"]);
  });
});
