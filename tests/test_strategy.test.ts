/**
 * Unit tests for orchestration/strategy.ts
 *
 * Covers: StrategyName, StrategyDecision, createStrategyDecision, ActionCompiler
 */

import { describe, it, expect } from "vitest";
import {
  createStrategyDecision,
  ActionCompiler,
  STRATEGY_DEFINITIONS,
  strategyPromptCatalog,
} from "../src/orchestration/strategy.js";
import type { StrategyName, StrategyDecision } from "../src/orchestration/strategy.js";
import type { OrchestratorSnapshot } from "../src/orchestration/snapshot.js";
import { createRuntimeAction } from "../src/shared/types.js";
import type { RuntimeAction } from "../src/shared/types.js";

const validStrategies = STRATEGY_DEFINITIONS.map((strategy) => strategy.name);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid OrchestratorSnapshot for compiler tests. */
function makeSnapshot(overrides: Partial<OrchestratorSnapshot> = {}): OrchestratorSnapshot {
  return {
    goal: "",
    requirementLoaded: false,
    requirementPreview: "",
    planReady: false,
    planTaskIdsByType: {},
    planTaskTypesById: {},
    readyTasks: [],
    runningTasks: [],
    failedTasks: [],
    completedPlanTasks: [],
    artifactTaskIds: [],
    artifactTypesByTask: {},
    unacceptedArtifacts: [],
    unevaluatedArtifacts: [],
    rejectedArtifacts: [],
    reviewCandidates: [],
    latestIssues: [],
    finalReviewDone: false,
    finalReviewPassed: false,
    finalReviewCurrent: false,
    outputSaved: false,
    isDirectMode: false,
    directModeArtifacts: [],
    evaluatorRunning: false,
    plannerFailures: 0,
    planRevisionCount: 0,
    repairCountsByTask: {},
    regenerateCountsByTask: {},
    stalledTaskIds: [],
    majorPendingTaskIds: [],
    globallyStalled: false,
    recentErrors: [],
    convergenceStalled: false,
    convergenceStalledFingerprints: [],
    convergenceTrend: "",
    convergenceRoundCount: 0,
    planAllCompleted: false,
    hasArtifacts: false,
    ...overrides,
  };
}

// ============================================================================
// StrategyName type
// ============================================================================

describe("StrategyName type", () => {
  it("has all 13 known strategies", () => {
    expect(validStrategies).toHaveLength(13);
  });

  it("each strategy name is a string literal", () => {
    for (const s of validStrategies) {
      expect(typeof s).toBe("string");
      // Must be non-empty and snake_case
      expect(s.length).toBeGreaterThan(0);
      expect(s).toMatch(/^[a-z_]+$/);
    }
  });

  it("has no duplicates", () => {
    const seen = new Set<string>();
    for (const s of validStrategies) {
      expect(seen.has(s)).toBe(false);
      seen.add(s);
    }
  });
});

// ============================================================================
// StrategyDecision interface
// ============================================================================

describe("StrategyDecision interface", () => {
  it("has the required fields", () => {
    const d: StrategyDecision = {
      strategy: "finish",
      targetTaskId: "t1",
      affectedTaskIds: ["t2"],
      reason: "done",
      confidence: 0.9,
    };
    expect(d.strategy).toBe("finish");
    expect(d.targetTaskId).toBe("t1");
    expect(d.affectedTaskIds).toEqual(["t2"]);
    expect(d.reason).toBe("done");
    expect(d.confidence).toBe(0.9);
  });
});

// ============================================================================
// createStrategyDecision factory
// ============================================================================

describe("createStrategyDecision", () => {
  it("returns defaults when only strategy is provided", () => {
    const d = createStrategyDecision({ strategy: "finish" });
    expect(d.strategy).toBe("finish");
    expect(d.targetTaskId).toBe("");
    expect(d.affectedTaskIds).toEqual([]);
    expect(d.reason).toBe("");
    expect(d.confidence).toBe(1.0);
  });

  it("overrides targetTaskId", () => {
    const d = createStrategyDecision({ strategy: "repair_local_artifact", targetTaskId: "design-1" });
    expect(d.strategy).toBe("repair_local_artifact");
    expect(d.targetTaskId).toBe("design-1");
  });

  it("overrides affectedTaskIds", () => {
    const d = createStrategyDecision({ strategy: "advance_ready_work", affectedTaskIds: ["a", "b"] });
    expect(d.affectedTaskIds).toEqual(["a", "b"]);
  });

  it("overrides reason", () => {
    const d = createStrategyDecision({ strategy: "pause_for_user", reason: "need input" });
    expect(d.reason).toBe("need input");
  });

  it("overrides confidence", () => {
    const d = createStrategyDecision({ strategy: "start_planning", confidence: 0.5 });
    expect(d.confidence).toBe(0.5);
  });

  it("overrides all fields", () => {
    const d = createStrategyDecision({
      strategy: "escalate_to_replan",
      targetTaskId: "planner",
      affectedTaskIds: ["design-1", "test-1"],
      reason: "systemic failure",
      confidence: 0.2,
    });
    expect(d.strategy).toBe("escalate_to_replan");
    expect(d.targetTaskId).toBe("planner");
    expect(d.affectedTaskIds).toEqual(["design-1", "test-1"]);
    expect(d.reason).toBe("systemic failure");
    expect(d.confidence).toBe(0.2);
  });

  it("affectedTaskIds default is an empty array (not shared)", () => {
    const d1 = createStrategyDecision({ strategy: "finish" });
    const d2 = createStrategyDecision({ strategy: "finish" });
    d1.affectedTaskIds.push("x");
    expect(d2.affectedTaskIds).toEqual([]);
  });

  it("targetTaskId default is empty string", () => {
    const d = createStrategyDecision({ strategy: "save_outputs" });
    expect(d.targetTaskId).toBe("");
  });

  it("reason default is empty string", () => {
    const d = createStrategyDecision({ strategy: "save_outputs" });
    expect(d.reason).toBe("");
  });

  it("confidence default is 1.0", () => {
    const d = createStrategyDecision({ strategy: "finish" });
    expect(d.confidence).toBe(1.0);
  });

  it("confidence can be set to 0", () => {
    const d = createStrategyDecision({ strategy: "finish", confidence: 0 });
    expect(d.confidence).toBe(0);
  });

  it("supports all strategy names", () => {
    for (const s of validStrategies) {
      const d = createStrategyDecision({ strategy: s });
      expect(d.strategy).toBe(s);
    }
  });

  it("renders the same strategy registry into the LLM prompt catalog", () => {
    const catalog = strategyPromptCatalog();
    for (const s of validStrategies) {
      expect(catalog).toContain(s);
    }
  });
});

// ============================================================================
// ActionCompiler
// ============================================================================

describe("ActionCompiler", () => {
  const compiler = new ActionCompiler();

  // -----------------------------------------------------------------------
  // start_planning
  // -----------------------------------------------------------------------

  describe("start_planning", () => {
    it("emits spawn for planner", () => {
      const d = createStrategyDecision({ strategy: "start_planning", reason: "init" });
      const result = compiler.compile(d, makeSnapshot());
      expect(result.action).toBe("spawn");
      expect(result.taskId).toBe("planner");
      expect(result.reason).toBe("init");
    });
  });

  // -----------------------------------------------------------------------
  // route_direct_diagrams
  // -----------------------------------------------------------------------

  describe("route_direct_diagrams", () => {
    it("emits spawn for direct_diagrams", () => {
      const d = createStrategyDecision({ strategy: "route_direct_diagrams", reason: "direct mode" });
      const result = compiler.compile(d, makeSnapshot());
      expect(result.action).toBe("spawn");
      expect(result.taskId).toBe("direct_diagrams");
      expect(result.reason).toBe("direct mode");
    });
  });

  // -----------------------------------------------------------------------
  // advance_ready_work
  // -----------------------------------------------------------------------

  describe("advance_ready_work", () => {
    it("emits spawn for single ready task", () => {
      const d = createStrategyDecision({
        strategy: "advance_ready_work",
        affectedTaskIds: ["analyze-1"],
        reason: "ready",
      });
      const result = compiler.compile(d, makeSnapshot());
      expect(result.action).toBe("spawn");
      expect(result.taskId).toBe("analyze-1");
    });

    it("emits spawn_all_ready for multiple ready tasks", () => {
      const d = createStrategyDecision({
        strategy: "advance_ready_work",
        affectedTaskIds: ["analyze-1", "design-1"],
        reason: "two ready",
      });
      const result = compiler.compile(d, makeSnapshot());
      expect(result.action).toBe("spawn_all_ready");
      expect(result.taskId).toBe("");
    });

    it("falls back to snapshot.readyTasks when affectedTaskIds is empty", () => {
      const d = createStrategyDecision({ strategy: "advance_ready_work", reason: "go" });
      const snap = makeSnapshot({ readyTasks: ["t1"] });
      const result = compiler.compile(d, snap);
      // single ready task from snapshot → spawn
      expect(result.action).toBe("spawn");
      expect(result.taskId).toBe("t1");
    });

    it("falls back to snapshot.readyTasks (multiple) when affectedTaskIds is empty", () => {
      const d = createStrategyDecision({ strategy: "advance_ready_work", reason: "go" });
      const snap = makeSnapshot({ readyTasks: ["t1", "t2", "t3"] });
      const result = compiler.compile(d, snap);
      expect(result.action).toBe("spawn_all_ready");
    });
  });

  // -----------------------------------------------------------------------
  // wait_for_running
  // -----------------------------------------------------------------------

  describe("wait_for_running", () => {
    it("emits inspect for all", () => {
      const d = createStrategyDecision({ strategy: "wait_for_running", reason: "busy" });
      const result = compiler.compile(d, makeSnapshot());
      expect(result.action).toBe("inspect");
      expect(result.taskId).toBe("all");
      expect(result.reason).toBe("busy");
    });
  });

  // -----------------------------------------------------------------------
  // run_opportunistic_review
  // -----------------------------------------------------------------------

  describe("run_opportunistic_review", () => {
    it("uses affectedTaskIds as evaluateScope when provided", () => {
      const d = createStrategyDecision({
        strategy: "run_opportunistic_review",
        affectedTaskIds: ["design-1", "test-2"],
        reason: "review now",
      });
      const result = compiler.compile(d, makeSnapshot());
      expect(result.action).toBe("spawn");
      expect(result.taskId).toBe("evaluator");
      expect(result.evaluateScope).toEqual(["design-1", "test-2"]);
    });

    it("falls back to snapshot.reviewCandidates when affectedTaskIds is empty", () => {
      const d = createStrategyDecision({ strategy: "run_opportunistic_review", reason: "check" });
      const snap = makeSnapshot({ reviewCandidates: ["a1"] });
      const result = compiler.compile(d, snap);
      expect(result.evaluateScope).toEqual(["a1"]);
    });

    it("falls back to snapshot.unevaluatedArtifacts when both affectedTaskIds and reviewCandidates are empty", () => {
      const d = createStrategyDecision({ strategy: "run_opportunistic_review", reason: "check" });
      const snap = makeSnapshot({ reviewCandidates: [], unevaluatedArtifacts: ["u1", "u2"] });
      const result = compiler.compile(d, snap);
      expect(result.evaluateScope).toEqual(["u1", "u2"]);
    });

    it("prefers affectedTaskIds over snapshot fallbacks", () => {
      const d = createStrategyDecision({
        strategy: "run_opportunistic_review",
        affectedTaskIds: ["explicit"],
        reason: "prefer",
      });
      const snap = makeSnapshot({
        reviewCandidates: ["rc"],
        unevaluatedArtifacts: ["ue"],
      });
      const result = compiler.compile(d, snap);
      expect(result.evaluateScope).toEqual(["explicit"]);
    });
  });

  // -----------------------------------------------------------------------
  // run_final_review
  // -----------------------------------------------------------------------

  describe("run_final_review", () => {
    it("emits spawn for evaluator", () => {
      const d = createStrategyDecision({ strategy: "run_final_review", reason: "final" });
      const result = compiler.compile(d, makeSnapshot());
      expect(result.action).toBe("spawn");
      expect(result.taskId).toBe("evaluator");
      expect(result.reason).toBe("final");
    });
  });

  // -----------------------------------------------------------------------
  // repair_local_artifact
  // -----------------------------------------------------------------------

  describe("repair_local_artifact", () => {
    it("emits repair with target task", () => {
      const d = createStrategyDecision({
        strategy: "repair_local_artifact",
        targetTaskId: "design-1",
        reason: "fix issue",
      });
      const result = compiler.compile(d, makeSnapshot());
      expect(result.action).toBe("repair");
      expect(result.taskId).toBe("design-1");
      expect(result.reason).toBe("fix issue");
    });
  });

  // -----------------------------------------------------------------------
  // repair_upstream_artifact
  // -----------------------------------------------------------------------

  describe("repair_upstream_artifact", () => {
    it("emits repair with target task", () => {
      const d = createStrategyDecision({
        strategy: "repair_upstream_artifact",
        targetTaskId: "analyze-1",
        reason: "upstream fix",
      });
      const result = compiler.compile(d, makeSnapshot());
      expect(result.action).toBe("repair");
      expect(result.taskId).toBe("analyze-1");
    });
  });

  // -----------------------------------------------------------------------
  // regenerate_downstream
  // -----------------------------------------------------------------------

  describe("regenerate_downstream", () => {
    it("uses first affectedTaskId when available", () => {
      const d = createStrategyDecision({
        strategy: "regenerate_downstream",
        targetTaskId: "t-target",
        affectedTaskIds: ["t-downstream", "t-other"],
        reason: "redo",
      });
      const result = compiler.compile(d, makeSnapshot());
      expect(result.action).toBe("regenerate");
      expect(result.taskId).toBe("t-downstream");
    });

    it("falls back to targetTaskId when affectedTaskIds is empty", () => {
      const d = createStrategyDecision({
        strategy: "regenerate_downstream",
        targetTaskId: "t-target",
        reason: "redo",
      });
      const result = compiler.compile(d, makeSnapshot());
      expect(result.action).toBe("regenerate");
      expect(result.taskId).toBe("t-target");
    });
  });

  // -----------------------------------------------------------------------
  // escalate_to_replan
  // -----------------------------------------------------------------------

  describe("escalate_to_replan", () => {
    it("emits replan for planner", () => {
      const d = createStrategyDecision({ strategy: "escalate_to_replan", reason: "stuck" });
      const result = compiler.compile(d, makeSnapshot());
      expect(result.action).toBe("replan");
      expect(result.taskId).toBe("planner");
    });
  });

  // -----------------------------------------------------------------------
  // save_outputs
  // -----------------------------------------------------------------------

  describe("save_outputs", () => {
    it("emits save", () => {
      const d = createStrategyDecision({ strategy: "save_outputs", reason: "done" });
      const result = compiler.compile(d, makeSnapshot());
      expect(result.action).toBe("save");
      expect(result.taskId).toBe("");
    });
  });

  // -----------------------------------------------------------------------
  // finish
  // -----------------------------------------------------------------------

  describe("finish", () => {
    it("emits finish", () => {
      const d = createStrategyDecision({ strategy: "finish", reason: "all done" });
      const result = compiler.compile(d, makeSnapshot());
      expect(result.action).toBe("finish");
      expect(result.taskId).toBe("");
      expect(result.reason).toBe("all done");
    });
  });

  // -----------------------------------------------------------------------
  // pause_for_user
  // -----------------------------------------------------------------------

  describe("pause_for_user", () => {
    it("emits pause", () => {
      const d = createStrategyDecision({ strategy: "pause_for_user", reason: "need input" });
      const result = compiler.compile(d, makeSnapshot());
      expect(result.action).toBe("pause");
      expect(result.reason).toBe("need input");
    });
  });

  // -----------------------------------------------------------------------
  // fallback / default case
  // -----------------------------------------------------------------------

  describe("default fallback", () => {
    it("returns pause when reason is set", () => {
      // We can't pass an invalid strategy through TypeScript types,
      // but we can test the fallback by casting. The default case
      // (last line of compile) returns pause with the reason or a default.
      // To cover it we simulate the code path with a valid strategy
      // that falls through — but the switch covers all 13 values.
      // We test the fallback indirectly by confirming every known
      // strategy is handled explicitly, so the default is never hit
      // with valid input.
      for (const s of validStrategies) {
        const d = createStrategyDecision({ strategy: s, reason: "test" });
        const result = compiler.compile(d, makeSnapshot());
        // All should be handled explicitly, none should hit the default pause fallback
        // (the default fallback also emits pause, so we check that recognized
        // strategies emit their expected action types).
        const fallbackActions = ["pause"];
        // Every known strategy maps to a non-pause action except pause_for_user
        if (s === "pause_for_user") {
          expect(result.action).toBe("pause");
        } else {
          expect(result.action).not.toBe("pause");
        }
      }
    });

    it("default fallback returns pause with custom reason", () => {
      // Test the actual fallback by calling compile directly with a cast.
      // The fallback code: return createRuntimeAction({ action: "pause", reason: reason || "orchestrator paused" });
      const decision = { strategy: "unknown" as StrategyName, targetTaskId: "", affectedTaskIds: [], reason: "oops", confidence: 0.5 };
      const result = compiler.compile(decision, makeSnapshot());
      expect(result.action).toBe("pause");
      expect(result.reason).toBe("oops");
    });

    it("default fallback returns pause with default reason when reason is empty", () => {
      const decision = { strategy: "unknown" as StrategyName, targetTaskId: "", affectedTaskIds: [], reason: "", confidence: 0.5 };
      const result = compiler.compile(decision, makeSnapshot());
      expect(result.action).toBe("pause");
      expect(result.reason).toBe("orchestrator paused");
    });
  });
});

// ============================================================================
// Integration: createStrategyDecision + ActionCompiler.compile
// ============================================================================

describe("createStrategyDecision → ActionCompiler.compile round-trip", () => {
  const compiler = new ActionCompiler();

  it("start_planning round-trip", () => {
    const decision = createStrategyDecision({ strategy: "start_planning", reason: "round-trip" });
    const action = compiler.compile(decision, makeSnapshot());
    expect(action).toEqual(createRuntimeAction({ action: "spawn", taskId: "planner", reason: "round-trip" }));
  });

  it("finish round-trip", () => {
    const decision = createStrategyDecision({ strategy: "finish", reason: "done" });
    const action = compiler.compile(decision, makeSnapshot());
    expect(action).toEqual(createRuntimeAction({ action: "finish", reason: "done" }));
  });

  it("repair round-trip", () => {
    const decision = createStrategyDecision({
      strategy: "repair_local_artifact",
      targetTaskId: "design-1",
      reason: "broken",
    });
    const action = compiler.compile(decision, makeSnapshot());
    expect(action).toEqual(createRuntimeAction({ action: "repair", taskId: "design-1", reason: "broken" }));
  });
});
