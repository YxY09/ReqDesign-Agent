/**
 * State mutation-safety audit (test-first).
 *
 * Two distinct boundaries exist around WorkflowState:
 *
 *  1. The subdomain VIEW getters (artifactsState / executionState / reviewState)
 *     are INTENTIONAL live bidirectional proxies — writing through them updates
 *     the backing fields. That contract is documented in state.ts and locked in
 *     by test_state_subdomains. We do NOT freeze/clone those.
 *
 *  2. The OrchestratorSnapshot handed to the decision/policy layer must be a
 *     read-only projection: mutating a snapshot collection must never reach back
 *     into WorkflowState. snapshot.ts builds every collection fresh, so this
 *     holds today — these tests pin that invariant so a future "optimization"
 *     can't silently turn a copy into an alias.
 */
import { describe, it, expect } from "vitest";
import { WorkflowState } from "../src/state.js";
import { StateReader } from "../src/orchestration/snapshot.js";
import { TaskMailbox } from "../src/messaging.js";
import {
  createExecutionPlan,
  createTask,
  createArtifact,
  createVerdict,
  createIssue,
} from "../src/shared/types.js";

function populatedState(): WorkflowState {
  const state = new WorkflowState();
  state.plan = createExecutionPlan({
    tasks: [
      createTask({ id: "design-1", type: "design" }),
      createTask({ id: "tests-1", type: "tests" }),
      createTask({ id: "analyze-1", type: "analyze" }),
    ],
  });
  state.taskStatuses["design-1"] = "running";
  state.artifacts["tests-1"] = createArtifact({
    taskId: "tests-1",
    type: "tests",
    revision: 1,
    content: "tc",
  });
  state.artifactRevisionsByTask["tests-1"] = 1;
  state.evaluatedRevisionsByTask["tests-1"] = 1;
  state.reviewStatusByTask["tests-1"] = "rejected";
  state.majorPendingTaskIds.add("tests-1");
  state.verdicts.push(
    createVerdict({
      issues: [
        createIssue({
          severity: "major",
          targetTaskId: "tests-1",
          targetTaskType: "tests",
          scope: "local",
        }),
      ],
    }),
  );
  return state;
}

describe("OrchestratorSnapshot is a non-aliasing projection", () => {
  it("populates the decision-relevant collections (sanity)", () => {
    const snap = StateReader.fromState(populatedState(), new TaskMailbox());
    expect(snap.runningTasks).toEqual(["design-1"]);
    expect(snap.rejectedArtifacts).toEqual(["tests-1"]);
    expect(snap.majorPendingTaskIds).toEqual(["tests-1"]);
    expect(snap.latestIssues).toHaveLength(1);
    expect(snap.readyTasks).toContain("analyze-1");
  });

  it("mutating snapshot collections does not affect a freshly built snapshot", () => {
    const state = populatedState();
    const snap1 = StateReader.fromState(state, new TaskMailbox());

    snap1.runningTasks.push("HACK");
    snap1.rejectedArtifacts.push("HACK");
    snap1.majorPendingTaskIds.push("HACK");
    snap1.readyTasks.push("HACK");
    snap1.latestIssues.push({ severity: "HACK" });
    snap1.latestIssues[0].severity = "TAMPERED";

    const snap2 = StateReader.fromState(state, new TaskMailbox());
    expect(snap2.runningTasks).toEqual(["design-1"]);
    expect(snap2.rejectedArtifacts).toEqual(["tests-1"]);
    expect(snap2.majorPendingTaskIds).toEqual(["tests-1"]);
    expect(snap2.readyTasks).not.toContain("HACK");
    expect(snap2.latestIssues).toHaveLength(1);
    expect(snap2.latestIssues[0].severity).toBe("major");
  });

  it("mutating snapshot collections does not reach into WorkflowState internals", () => {
    const state = populatedState();
    const snap = StateReader.fromState(state, new TaskMailbox());

    snap.majorPendingTaskIds.push("HACK");
    snap.latestIssues[0].severity = "TAMPERED";

    // Backing Set is untouched.
    expect([...state.majorPendingTaskIds]).toEqual(["tests-1"]);
    expect(state.majorPendingTaskIds.has("HACK")).toBe(false);
    // The real Issue object behind latestIssues is untouched.
    expect(state.verdicts[0].issues[0].severity).toBe("major");
  });
});
