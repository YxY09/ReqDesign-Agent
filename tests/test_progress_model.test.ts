/**
 * Tests for the progress model: no-progress detection, rejection streaks,
 * stalled tasks, and score trends.
 *
 * Ported from tests/test_progress_model.py
 */

import { describe, it, expect } from "vitest";
import { ProgressSnapshot } from "../src/progress.js";
import { createArtifact, createVerdict } from "../src/agents/types.js";
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
    expect(progress.noProgressStreak).toBe(0);
  });

  it("should not count same content hash as progress", () => {
    const progress = new ProgressSnapshot();
    const content = { actors: ["user"] };
    progress.recordArtifact("t1", content);
    progress.noProgressStreak = 0;

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

  it("should increment rejection streak", () => {
    const progress = new ProgressSnapshot();
    progress.recordRejection("design-1");
    progress.recordRejection("design-1");
    progress.recordRejection("design-1");

    expect(progress.getRejectionStreak("design-1")).toBe(3);
    expect(progress.isTaskStalled("design-1")).toBe(true);
  });

  it("should clear rejection streak on acceptance", () => {
    const progress = new ProgressSnapshot();
    progress.recordRejection("design-1");
    progress.recordRejection("design-1");
    progress.recordAcceptance("design-1");

    expect(progress.getRejectionStreak("design-1")).toBe(0);
    expect(progress.isTaskStalled("design-1")).toBe(false);
  });

  it("should detect globally stalled when no_progress_streak >= threshold", () => {
    const progress = new ProgressSnapshot();
    expect(progress.isGloballyStalled()).toBe(false);

    progress.recordNoProgress();
    progress.recordNoProgress();
    expect(progress.isGloballyStalled()).toBe(false);

    progress.recordNoProgress();
    expect(progress.isGloballyStalled(3)).toBe(true);
  });

  it("should clear global stall on progress event", () => {
    const progress = new ProgressSnapshot();
    progress.noProgressStreak = 5;
    // _markProgress is private; we call recordPlanMutation which calls it
    progress.recordPlanMutation();
    expect(progress.noProgressStreak).toBe(0);
    expect(progress.isGloballyStalled()).toBe(false);
  });

  it("should detect improving score trend", () => {
    const progress = new ProgressSnapshot();
    progress.recordScore(0.4);
    progress.recordScore(0.6);
    progress.recordScore(0.8);

    expect(progress.scoreTrend()).toBe("improving");
    expect(progress.latestScore()).toBe(0.8);
  });

  it("should detect declining score trend", () => {
    const progress = new ProgressSnapshot();
    progress.recordScore(0.8);
    progress.recordScore(0.6);
    progress.recordScore(0.4);

    expect(progress.scoreTrend()).toBe("declining");
  });

  it("should detect flat score trend", () => {
    const progress = new ProgressSnapshot();
    progress.recordScore(0.6);
    progress.recordScore(0.6);
    progress.recordScore(0.6);

    expect(progress.scoreTrend()).toBe("flat");
  });

  it("should return unknown trend with fewer than 2 scores", () => {
    const progress = new ProgressSnapshot();
    expect(progress.scoreTrend()).toBe("unknown");
  });

  it("should treat score improvement as progress", () => {
    const progress = new ProgressSnapshot();
    progress.recordScore(0.5);

    const result = progress.recordScore(0.7);
    expect(result).toBe(true);
    expect(progress.noProgressStreak).toBe(0);
  });

  it("should not treat score non-improvement as progress", () => {
    const progress = new ProgressSnapshot();
    progress.recordScore(0.7);

    const result = progress.recordScore(0.5);
    expect(result).toBe(false);
    expect(progress.noProgressStreak).toBe(1);
  });

  it("should increment retry count on recordRetry", () => {
    const progress = new ProgressSnapshot();
    progress.recordRetry("design-1");
    progress.recordRetry("design-1");

    expect(progress.getRetryCount("design-1")).toBe(2);
  });

  it("should increment plan_revision_count on recordPlanMutation", () => {
    const progress = new ProgressSnapshot();
    progress.recordPlanMutation();
    progress.recordPlanMutation();

    expect(progress.planRevisionCount).toBe(2);
    expect(progress.noProgressStreak).toBe(0);
  });

  it("should include all relevant fields in summary()", () => {
    const progress = new ProgressSnapshot();
    progress.recordArtifact("t1", "content");
    progress.recordRejection("t1");
    progress.recordScore(0.5);

    const s = progress.summary();
    expect(s).toHaveProperty("artifactRevisionCount");
    expect(s).toHaveProperty("stalledTaskIds");
    expect(s).toHaveProperty("scoreHistory");
    expect(s).toHaveProperty("globallyStalled");
    expect(s["latestScore"]).toBe(0.5);
  });

  it("should survive toDict / fromDict roundtrip", () => {
    const original = new ProgressSnapshot();
    original.recordArtifact("t1", "content");
    original.recordRejection("t1");
    original.recordScore(0.5);
    original.recordPlanMutation();

    const data = original.toDict();
    const restored = ProgressSnapshot.fromDict(data);

    expect(restored.artifactRevisionCount).toEqual({ t1: 1 });
    expect(restored.rejectionStreakByTask).toEqual({ t1: 1 });
    expect(restored.scoreHistory).toEqual([0.5]);
    expect(restored.planRevisionCount).toBe(1);
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

  it("should track score progress on verdicts", () => {
    const state = new WorkflowState();
    state.goal = "design";

    const v1 = createVerdict({ passed: false });
    state.addVerdict(v1);

    const v2 = createVerdict({ passed: true });
    state.addVerdict(v2);

    expect(state.progress.latestScore()).toBe(1.0);
  });

  it("should track rejection streaks via runtime notification processing", () => {
    const state = new WorkflowState();
    state.goal = "design";

    state.progress.recordRejection("design-1");
    state.progress.recordRejection("design-1");
    state.progress.recordRejection("design-1");

    expect(state.progress.isTaskStalled("design-1")).toBe(true);
    expect(state.progress.getRejectionStreak("design-1")).toBe(3);
  });
});
