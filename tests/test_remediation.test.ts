import { describe, expect, it } from "vitest";
import { BudgetManager } from "../src/orchestration/budget.js";
import { RemediationLadder } from "../src/orchestration/remediation.js";
import type { OrchestratorSnapshot } from "../src/orchestration/snapshot.js";

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
    convergenceStalled: false,
    convergenceRoundCount: 0,
    convergenceTrend: null,
    convergenceStalledFingerprints: [],
    planRevisionCount: 0,
    plannerFailures: 0,
    regenerateCountsByTask: {},
    repairFutileTaskIds: [],
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

function makeLadder(): RemediationLadder {
  return new RemediationLadder(new BudgetManager(undefined));
}

describe("RemediationLadder.rejectedArtifact", () => {
  it("returns null when no rejected artifacts", () => {
    expect(makeLadder().rejectedArtifact(makeSnapshot())).toBeNull();
  });

  it("repairs a rejected artifact when budget allows", () => {
    const decision = makeLadder().rejectedArtifact(
      makeSnapshot({ rejectedArtifacts: ["design-1"] }),
    );
    expect(decision?.strategy).toBe("repair_local_artifact");
    expect(decision?.targetTaskId).toBe("design-1");
  });

  it("waits when the only rejected artifact is already running", () => {
    const decision = makeLadder().rejectedArtifact(
      makeSnapshot({ rejectedArtifacts: ["design-1"], runningTasks: ["design-1"] }),
    );
    expect(decision?.strategy).toBe("wait_for_running");
    expect(decision?.targetTaskId).toBe("design-1");
  });

  it("skips a running target and repairs the next rejected artifact", () => {
    const decision = makeLadder().rejectedArtifact(
      makeSnapshot({
        rejectedArtifacts: ["design-1", "tests-1"],
        runningTasks: ["design-1"],
      }),
    );
    expect(decision?.strategy).toBe("repair_local_artifact");
    expect(decision?.targetTaskId).toBe("tests-1");
  });

  it("regenerates a diagrams artifact after repeated repair", () => {
    const decision = makeLadder().rejectedArtifact(
      makeSnapshot({
        rejectedArtifacts: ["diagrams-1"],
        artifactTypesByTask: { "diagrams-1": "diagrams" },
        repairCountsByTask: { "diagrams-1": 2 },
      }),
    );
    expect(decision?.strategy).toBe("regenerate_downstream");
    expect(decision?.targetTaskId).toBe("diagrams-1");
  });

  it("escalates to replan when repair budget exhausted and replan allowed", () => {
    const decision = makeLadder().rejectedArtifact(
      makeSnapshot({
        rejectedArtifacts: ["design-1"],
        repairCountsByTask: { "design-1": 99 },
        planReady: true,
      }),
    );
    expect(decision?.strategy).toBe("escalate_to_replan");
  });

  it("pauses when repair and replan budgets are exhausted", () => {
    const decision = makeLadder().rejectedArtifact(
      makeSnapshot({
        rejectedArtifacts: ["design-1"],
        repairCountsByTask: { "design-1": 99 },
        planReady: true,
        planRevisionCount: 99,
      }),
    );
    expect(decision?.strategy).toBe("pause_for_user");
  });

  it("uses the caller-provided reason when given", () => {
    const decision = makeLadder().rejectedArtifact(
      makeSnapshot({ rejectedArtifacts: ["design-1"] }),
      "save gate is not satisfied",
    );
    expect(decision?.reason).toBe("save gate is not satisfied");
  });
});

describe("RemediationLadder.finalMajor", () => {
  const localMajorIssue = {
    severity: "major",
    kind: "defect",
    target_task_id: "design-1",
    target_task_type: "design",
    scope: "local",
  };

  it("returns null when no major pending tasks", () => {
    expect(makeLadder().finalMajor(makeSnapshot())).toBeNull();
  });

  it("repairs a safe local major target", () => {
    const decision = makeLadder().finalMajor(
      makeSnapshot({
        majorPendingTaskIds: ["design-1"],
        latestIssues: [localMajorIssue],
        artifactTypesByTask: { "design-1": "design" },
      }),
    );
    expect(decision?.strategy).toBe("repair_local_artifact");
    expect(decision?.targetTaskId).toBe("design-1");
  });

  it("does NOT repair a local target whose repair has proven futile; accepts instead", () => {
    const decision = makeLadder().finalMajor(
      makeSnapshot({
        majorPendingTaskIds: ["design-1"],
        latestIssues: [localMajorIssue],
        artifactTypesByTask: { "design-1": "design" },
        // A prior repair left the same structural issue in place.
        repairFutileTaskIds: ["design-1"],
      }),
    );
    expect(decision?.strategy).toBe("finish");
  });

  it("does not locally repair upstream-scoped issues", () => {
    const decision = makeLadder().finalMajor(
      makeSnapshot({
        majorPendingTaskIds: ["design-1"],
        latestIssues: [{ ...localMajorIssue, scope: "upstream" }],
        artifactTypesByTask: { "design-1": "design" },
        planReady: true,
      }),
    );
    expect(decision?.strategy).toBe("escalate_to_replan");
  });

  it("accepts final-review upstream majors without replanning when there are no blockers", () => {
    const decision = makeLadder().finalMajor(
      makeSnapshot({
        majorPendingTaskIds: ["analyze-1"],
        latestIssues: [{ ...localMajorIssue, target_task_id: "analyze-1", target_task_type: "analyze", scope: "upstream" }],
        artifactTypesByTask: { "analyze-1": "analyze" },
        planReady: true,
        finalReviewCurrent: true,
        planAllCompleted: true,
      }),
    );
    expect(decision?.strategy).toBe("finish");
  });

  it("waits when the repair target is already running", () => {
    const decision = makeLadder().finalMajor(
      makeSnapshot({
        majorPendingTaskIds: ["design-1"],
        latestIssues: [localMajorIssue],
        artifactTypesByTask: { "design-1": "design" },
        runningTasks: ["design-1"],
      }),
    );
    expect(decision?.strategy).toBe("wait_for_running");
  });

  it("waits while unrelated work is still running", () => {
    const decision = makeLadder().finalMajor(
      makeSnapshot({
        majorPendingTaskIds: ["design-1"],
        latestIssues: [{ ...localMajorIssue, scope: "systemic" }],
        artifactTypesByTask: { "design-1": "design" },
        runningTasks: ["tests-1"],
      }),
    );
    expect(decision?.strategy).toBe("wait_for_running");
  });

  it("pauses when nothing can be repaired and replan is exhausted", () => {
    const decision = makeLadder().finalMajor(
      makeSnapshot({
        majorPendingTaskIds: ["design-1"],
        latestIssues: [{ ...localMajorIssue, scope: "systemic" }],
        artifactTypesByTask: { "design-1": "design" },
        planReady: true,
        planRevisionCount: 99,
      }),
    );
    expect(decision?.strategy).toBe("pause_for_user");
  });
});

describe("RemediationLadder.isSafeFinalMajorRepairTarget", () => {
  it("accepts local issues with matching task type", () => {
    const ladder = makeLadder();
    const snapshot = makeSnapshot({
      latestIssues: [
        { severity: "major", kind: "defect", target_task_id: "design-1", target_task_type: "design", scope: "local" },
      ],
      artifactTypesByTask: { "design-1": "design" },
    });
    expect(ladder.isSafeFinalMajorRepairTarget(snapshot, "design-1")).toBe(true);
  });

  it("rejects targets whose only issues are systemic", () => {
    const ladder = makeLadder();
    const snapshot = makeSnapshot({
      latestIssues: [
        { severity: "major", kind: "defect", target_task_id: "design-1", target_task_type: "design", scope: "systemic" },
      ],
      artifactTypesByTask: { "design-1": "design" },
    });
    expect(ladder.isSafeFinalMajorRepairTarget(snapshot, "design-1")).toBe(false);
  });

  it("rejects targets without major issues", () => {
    const ladder = makeLadder();
    const snapshot = makeSnapshot({
      latestIssues: [
        { severity: "minor", target_task_id: "design-1", target_task_type: "design", scope: "local" },
      ],
    });
    expect(ladder.isSafeFinalMajorRepairTarget(snapshot, "design-1")).toBe(false);
  });
});
