import { describe, expect, it } from "vitest";
import { PolicyGuard, DeterministicPolicy } from "../src/orchestration/policy.js";
import { createStrategyDecision } from "../src/orchestration/strategy.js";
import type { OrchestratorSnapshot } from "../src/orchestration/snapshot.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<OrchestratorSnapshot> = {}): OrchestratorSnapshot {
  return {
    runningTasks: [],
    readyTasks: [],
    failedTasks: [],
    rejectedArtifacts: [],
    unacceptedArtifacts: [],
    majorPendingTaskIds: [],
    latestIssues: [],
    requirementLoaded: false,
    hasArtifacts: false,
    planReady: false,
    planAllCompleted: false,
    outputSaved: false,
    evaluatorRunning: false,
    finalReviewCurrent: false,
    finalReviewPassed: false,
    globallyStalled: false,
    convergenceStalled: false,
    convergenceRoundCount: 0,
    convergenceTrend: null,
    convergenceStalledFingerprints: [],
    planRevisionCount: 0,
    plannerFailures: 0,
    stalledTaskIds: [],
    regenerateCountsByTask: {},
    repairCountsByTask: {},
    artifactTypesByTask: {},
    planTaskTypesById: {},
    unevaluatedArtifacts: [],
    artifactTaskIds: [],
    completedPlanTasks: [],
    isDirectMode: false,
    directModeArtifacts: [],
    planTaskIdsByType: {},
    reviewCandidates: [],
    ...overrides,
  } as OrchestratorSnapshot;
}

// ---------------------------------------------------------------------------
// PolicyGuard
// ---------------------------------------------------------------------------

describe("PolicyGuard", () => {
  it("canSave returns true when all gates satisfied", () => {
    const guard = new PolicyGuard();
    const snapshot = makeSnapshot({
      finalReviewCurrent: true,
      finalReviewPassed: true,
      hasArtifacts: true,
      planReady: true,
      planAllCompleted: true,
    });
    expect(guard.canSave(snapshot)).toBe(true);
  });

  it("canSave returns false when tasks still running", () => {
    const guard = new PolicyGuard();
    const snapshot = makeSnapshot({
      runningTasks: ["design-1"],
      finalReviewCurrent: true,
      finalReviewPassed: true,
    });
    expect(guard.canSave(snapshot)).toBe(false);
  });

  it("canSave returns false when evaluator running", () => {
    const guard = new PolicyGuard();
    const snapshot = makeSnapshot({
      evaluatorRunning: true,
      finalReviewCurrent: true,
      finalReviewPassed: true,
    });
    expect(guard.canSave(snapshot)).toBe(false);
  });

  it("canSave returns false when unaccepted artifacts remain", () => {
    const guard = new PolicyGuard();
    const snapshot = makeSnapshot({
      unacceptedArtifacts: ["design-1"],
      finalReviewCurrent: true,
      finalReviewPassed: true,
    });
    expect(guard.canSave(snapshot)).toBe(false);
  });

  it("canSave returns false when output already saved", () => {
    const guard = new PolicyGuard();
    const snapshot = makeSnapshot({
      outputSaved: true,
      finalReviewCurrent: true,
      finalReviewPassed: true,
    });
    expect(guard.canSave(snapshot)).toBe(false);
  });

  it("canRunFinalReview returns true when all conditions met", () => {
    const guard = new PolicyGuard();
    const snapshot = makeSnapshot({
      hasArtifacts: true,
      planReady: true,
      planAllCompleted: true,
    });
    expect(guard.canRunFinalReview(snapshot)).toBe(true);
  });

  it("canRunFinalReview returns false when rejected artifacts exist", () => {
    const guard = new PolicyGuard();
    const snapshot = makeSnapshot({
      hasArtifacts: true,
      planReady: true,
      planAllCompleted: true,
      rejectedArtifacts: ["design-1"],
    });
    expect(guard.canRunFinalReview(snapshot)).toBe(false);
  });

  it("canRunFinalReview returns false when evaluator running", () => {
    const guard = new PolicyGuard();
    const snapshot = makeSnapshot({
      hasArtifacts: true,
      planReady: true,
      planAllCompleted: true,
      evaluatorRunning: true,
    });
    expect(guard.canRunFinalReview(snapshot)).toBe(false);
  });

  it("canRunFinalReview returns false when final review already current", () => {
    const guard = new PolicyGuard();
    const snapshot = makeSnapshot({
      hasArtifacts: true,
      planReady: true,
      planAllCompleted: true,
      finalReviewCurrent: true,
    });
    expect(guard.canRunFinalReview(snapshot)).toBe(false);
  });

  it("validate passes through save_outputs when gate satisfied", () => {
    const guard = new PolicyGuard();
    const snapshot = makeSnapshot({
      finalReviewCurrent: true,
      finalReviewPassed: true,
      hasArtifacts: true,
      planReady: true,
      planAllCompleted: true,
    });
    const decision = createStrategyDecision({ strategy: "save_outputs" });
    const result = guard.validate(decision, snapshot);
    expect(result.strategy).toBe("save_outputs");
  });

  it("validate downgrades save_outputs when gate not satisfied", () => {
    const guard = new PolicyGuard();
    const snapshot = makeSnapshot({
      finalReviewCurrent: false,
      finalReviewPassed: false,
    });
    const decision = createStrategyDecision({ strategy: "save_outputs" });
    const result = guard.validate(decision, snapshot);
    expect(result.strategy).not.toBe("save_outputs");
  });

  it("validate passes through finish when outputSaved", () => {
    const guard = new PolicyGuard();
    const snapshot = makeSnapshot({ outputSaved: true });
    const decision = createStrategyDecision({ strategy: "finish" });
    const result = guard.validate(decision, snapshot);
    expect(result.strategy).toBe("finish");
  });

  it("validate passes through finish when nothing loaded", () => {
    const guard = new PolicyGuard();
    const snapshot = makeSnapshot();
    const decision = createStrategyDecision({ strategy: "finish" });
    const result = guard.validate(decision, snapshot);
    expect(result.strategy).toBe("finish");
  });

  it("validate passes through route_direct_diagrams when gate satisfied", () => {
    const guard = new PolicyGuard();
    const snapshot = makeSnapshot({ requirementLoaded: true });
    const decision = createStrategyDecision({ strategy: "route_direct_diagrams" });
    const result = guard.validate(decision, snapshot);
    expect(result.strategy).toBe("route_direct_diagrams");
  });

  it("validate downgrades route_direct_diagrams when artifacts exist", () => {
    const guard = new PolicyGuard();
    const snapshot = makeSnapshot({ requirementLoaded: true, hasArtifacts: true });
    const decision = createStrategyDecision({ strategy: "route_direct_diagrams" });
    const result = guard.validate(decision, snapshot);
    expect(result.strategy).not.toBe("route_direct_diagrams");
  });

  it("validate repairs rejected artifact when budget allows", () => {
    const guard = new PolicyGuard();
    const snapshot = makeSnapshot({ rejectedArtifacts: ["design-1"] });
    const decision = createStrategyDecision({ strategy: "repair_local_artifact", targetTaskId: "design-1" });
    const result = guard.validate(decision, snapshot);
    expect(result.strategy).toBe("repair_local_artifact");
    expect(result.targetTaskId).toBe("design-1");
  });

  it("validate redirects repair to wait when target already running", () => {
    const guard = new PolicyGuard();
    const snapshot = makeSnapshot({
      rejectedArtifacts: ["design-1"],
      runningTasks: ["design-1"],
    });
    const decision = createStrategyDecision({ strategy: "repair_local_artifact", targetTaskId: "design-1" });
    const result = guard.validate(decision, snapshot);
    expect(result.strategy).toBe("wait_for_running");
  });
});

// ---------------------------------------------------------------------------
// DeterministicPolicy
// ---------------------------------------------------------------------------

describe("DeterministicPolicy", () => {
  it("advances ready remediation tasks after replan", () => {
    const policy = new DeterministicPolicy();
    const snapshot = makeSnapshot({
      planRevisionCount: 1,
      readyTasks: ["design-2"],
    });
    const result = policy.decide(snapshot);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("advance_ready_work");
    expect(result!.affectedTaskIds).toContain("design-2");
  });

  it("regenerates failed task when budget allows", () => {
    const policy = new DeterministicPolicy();
    const snapshot = makeSnapshot({
      failedTasks: ["design-1"],
      regenerateCountsByTask: { "design-1": 0 },
    });
    const result = policy.decide(snapshot);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("regenerate_downstream");
    expect(result!.targetTaskId).toBe("design-1");
  });

  it("waits when failed task is already running", () => {
    const policy = new DeterministicPolicy();
    const snapshot = makeSnapshot({
      failedTasks: ["design-1"],
      runningTasks: ["design-1"],
    });
    const result = policy.decide(snapshot);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("wait_for_running");
  });

  it("waits when failed task needs replan but planner is already running", () => {
    const policy = new DeterministicPolicy();
    const snapshot = makeSnapshot({
      planReady: true,
      failedTasks: ["design-1"],
      runningTasks: ["planner"],
      regenerateCountsByTask: { "design-1": 1 },
    });
    const result = policy.decide(snapshot);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("wait_for_running");
  });

  // Livelock regression: terminal-failed + replan budget exhausted + other tasks running
  // must NOT loop on wait_for_running forever.
  it("pauses (not livelock) when failed task has exhausted both regeneration and replan budgets while other tasks are running", () => {
    const policy = new DeterministicPolicy();
    const snapshot = makeSnapshot({
      planReady: true,
      failedTasks: ["design-1"],
      runningTasks: ["tests-3"],           // some other task still inflight
      regenerateCountsByTask: { "design-1": 1 }, // maxRegeneratePerTask=1, exhausted
      planRevisionCount: 2,                // maxReplanCount=2, also exhausted
    });
    const result = policy.decide(snapshot);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("pause_for_user");
  });

  it("still waits when failed task exhausted regeneration but replan budget remains", () => {
    const policy = new DeterministicPolicy();
    const snapshot = makeSnapshot({
      planReady: true,
      failedTasks: ["design-1"],
      runningTasks: ["tests-1"],
      regenerateCountsByTask: { "design-1": 1 }, // regenerate exhausted
      planRevisionCount: 0,                // replan budget NOT exhausted
    });
    const result = policy.decide(snapshot);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("wait_for_running"); // waiting CAN lead to replan
  });

  it("repairs rejected artifact when budget allows", () => {
    const policy = new DeterministicPolicy();
    const snapshot = makeSnapshot({
      rejectedArtifacts: ["design-1"],
    });
    const result = policy.decide(snapshot);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("repair_local_artifact");
    expect(result!.targetTaskId).toBe("design-1");
  });

  it("replans when globally stalled", () => {
    const policy = new DeterministicPolicy();
    const snapshot = makeSnapshot({
      globallyStalled: true,
      requirementLoaded: true,
      hasArtifacts: true,
      planReady: true,
    });
    const result = policy.decide(snapshot);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("escalate_to_replan");
  });

  it("finishes when outputs already saved", () => {
    const policy = new DeterministicPolicy();
    const snapshot = makeSnapshot({ outputSaved: true });
    const result = policy.decide(snapshot);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("finish");
  });

  it("waits when work is still running", () => {
    const policy = new DeterministicPolicy();
    const snapshot = makeSnapshot({ runningTasks: ["design-1"] });
    const result = policy.decide(snapshot);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("wait_for_running");
  });

  it("returns null for initial routing (LLM decides)", () => {
    const policy = new DeterministicPolicy();
    const snapshot = makeSnapshot({
      requirementLoaded: true,
      planReady: false,
      hasArtifacts: false,
    });
    const result = policy.decide(snapshot);
    expect(result).toBeNull();
  });

  it("pauses when planner failed 3 times", () => {
    const policy = new DeterministicPolicy();
    const snapshot = makeSnapshot({
      requirementLoaded: true,
      planReady: false,
      hasArtifacts: false,
      plannerFailures: 3,
    });
    const result = policy.decide(snapshot);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("pause_for_user");
  });

  it("advances ready tasks", () => {
    const policy = new DeterministicPolicy();
    const snapshot = makeSnapshot({
      readyTasks: ["design-1"],
      planReady: true,
      hasArtifacts: true,
    });
    const result = policy.decide(snapshot);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("advance_ready_work");
  });

  it("runs final review when conditions met", () => {
    const policy = new DeterministicPolicy();
    const snapshot = makeSnapshot({
      hasArtifacts: true,
      planReady: true,
      planAllCompleted: true,
    });
    const result = policy.decide(snapshot);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("run_final_review");
  });

  it("finishes when nothing loaded", () => {
    const policy = new DeterministicPolicy();
    const snapshot = makeSnapshot({
      requirementLoaded: false,
      hasArtifacts: false,
    });
    const result = policy.decide(snapshot);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("finish");
  });

  it("accepts convergence stall when issues decreasing and <= 8", () => {
    const policy = new DeterministicPolicy();
    const snapshot = makeSnapshot({
      convergenceStalled: true,
      convergenceRoundCount: 4,
      convergenceTrend: "decreasing",
      latestIssues: Array.from({ length: 5 }, (_, i) => ({
        severity: "minor",
        description: `issue-${i}`,
      })),
    });
    const result = policy.decide(snapshot);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("finish");
  });

  it("accepts convergence stall when issues flat and <= 10", () => {
    const policy = new DeterministicPolicy();
    const snapshot = makeSnapshot({
      convergenceStalled: true,
      convergenceRoundCount: 4,
      convergenceTrend: "flat",
      latestIssues: Array.from({ length: 8 }, (_, i) => ({
        severity: "minor",
        description: `issue-${i}`,
      })),
    });
    const result = policy.decide(snapshot);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("finish");
  });

  it("pauses on convergence stall when issues increasing", () => {
    const policy = new DeterministicPolicy();
    const snapshot = makeSnapshot({
      convergenceStalled: true,
      convergenceRoundCount: 4,
      convergenceTrend: "increasing",
      latestIssues: Array.from({ length: 12 }, (_, i) => ({
        severity: "major",
        description: `issue-${i}`,
      })),
      convergenceStalledFingerprints: ["fp1"],
    });
    const result = policy.decide(snapshot);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("pause_for_user");
  });

  it("pauses when final review rejected with no repair targets", () => {
    const policy = new DeterministicPolicy();
    const snapshot = makeSnapshot({
      finalReviewCurrent: true,
      finalReviewPassed: false,
      majorPendingTaskIds: [],
      rejectedArtifacts: [],
      runningTasks: [],
      evaluatorRunning: false,
    });
    const result = policy.decide(snapshot);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("pause_for_user");
  });
});
