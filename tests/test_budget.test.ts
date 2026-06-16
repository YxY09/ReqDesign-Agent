/**
 * orchestration/budget.ts 的单元测试 — BudgetManager 和 OrchestrationConfig。
 */

import { describe, it, expect } from "vitest";
import { BudgetManager, OrchestrationConfig } from "../src/orchestration/budget.js";
import type { OrchestratorSnapshot } from "../src/orchestration/snapshot.js";

// -----------------------------------------------------------------------
// 辅助函数
// -----------------------------------------------------------------------

/** 创建用于 BudgetManager 方法测试的最小快照存根。 */
function snap(overrides: Partial<OrchestratorSnapshot> = {}): OrchestratorSnapshot {
  return {
    goal: "test",
    requirementLoaded: true,
    requirementPreview: "req preview",
    planReady: true,
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
    convergenceTrend: "unknown",
    convergenceRoundCount: 0,
    planAllCompleted: false,
    hasArtifacts: false,
    ...overrides,
  };
}

// -----------------------------------------------------------------------
// OrchestrationConfig
// -----------------------------------------------------------------------

describe("OrchestrationConfig", () => {
  it("defaults all fields to sensible values", () => {
    const c = new OrchestrationConfig();
    expect(c.maxRepairPerTask).toBe(4);
    expect(c.diagramRepairBeforeRegenerate).toBe(2);
    expect(c.designRepairBeforeRegenerate).toBe(2);
    expect(c.maxRegeneratePerTask).toBe(1);
    expect(c.maxReplanCount).toBe(2);
    expect(c.maxRuntimeSeconds).toBe(1800);
    expect(c.maxDecisionCount).toBe(500);
    expect(c.maxPlannerFailures).toBe(3);
    expect(c.maxEvaluatorTimeouts).toBe(3);
    expect(c.maxSaveFailures).toBe(3);
    expect(c.maxFinalMajorIssues).toBe(3);
    expect(c.maxFinalMajorRepairPerTask).toBe(3);
    expect(c.maxConcurrentEvaluators).toBe(2);
    expect(c.minRuntimeRemainingForNewWorkSeconds).toBe(120);
  });

  it("fromRaw applies all provided fields", () => {
    const c = OrchestrationConfig.fromRaw({
      max_repair_per_task: 10,
      diagram_repair_before_regenerate: 5,
      design_repair_before_regenerate: 3,
      max_regenerate_per_task: 2,
      max_replan_count: 4,
      max_runtime_seconds: 3600,
      max_decision_count: 1000,
      max_planner_failures: 5,
      max_evaluator_timeouts: 6,
      max_save_failures: 7,
      max_final_major_issues: 8,
      max_final_major_repair_per_task: 9,
      max_concurrent_evaluators: 4,
      min_runtime_remaining_for_new_work_seconds: 300,
    });
    expect(c.maxRepairPerTask).toBe(10);
    expect(c.diagramRepairBeforeRegenerate).toBe(5);
    expect(c.designRepairBeforeRegenerate).toBe(3);
    expect(c.maxRegeneratePerTask).toBe(2);
    expect(c.maxReplanCount).toBe(4);
    expect(c.maxRuntimeSeconds).toBe(3600);
    expect(c.maxDecisionCount).toBe(1000);
    expect(c.maxPlannerFailures).toBe(5);
    expect(c.maxEvaluatorTimeouts).toBe(6);
    expect(c.maxSaveFailures).toBe(7);
    expect(c.maxFinalMajorIssues).toBe(8);
    expect(c.maxFinalMajorRepairPerTask).toBe(9);
    expect(c.maxConcurrentEvaluators).toBe(4);
    expect(c.minRuntimeRemainingForNewWorkSeconds).toBe(300);
  });

  it("fromRaw preserves defaults for missing fields", () => {
    const c = OrchestrationConfig.fromRaw({ max_repair_per_task: 1 });
    expect(c.maxRepairPerTask).toBe(1);
    // 其他字段保持默认值
    expect(c.maxRuntimeSeconds).toBe(1800);
    expect(c.maxDecisionCount).toBe(500);
    expect(c.maxReplanCount).toBe(2);
  });

  it("fromRaw with empty object returns all defaults", () => {
    const c = OrchestrationConfig.fromRaw({});
    const d = new OrchestrationConfig();
    expect(c.maxRepairPerTask).toBe(d.maxRepairPerTask);
    expect(c.maxRuntimeSeconds).toBe(d.maxRuntimeSeconds);
    expect(c.maxDecisionCount).toBe(d.maxDecisionCount);
  });
});

// -----------------------------------------------------------------------
// BudgetManager — 构造
// -----------------------------------------------------------------------

describe("BudgetManager constructor", () => {
  it("uses OrchestrationConfig defaults when no config passed", () => {
    const b = new BudgetManager();
    expect(b.maxRepairPerTask).toBe(4);
    expect(b.maxRuntimeSeconds).toBe(1800);
    expect(b.maxDecisionCount).toBe(500);
    expect(b.minRuntimeRemainingForNewWorkSeconds).toBe(120);
  });

  it("accepts a custom OrchestrationConfig", () => {
    const cfg = OrchestrationConfig.fromRaw({ max_repair_per_task: 7, max_runtime_seconds: 900 });
    const b = new BudgetManager(cfg);
    expect(b.maxRepairPerTask).toBe(7);
    expect(b.maxRuntimeSeconds).toBe(900);
    expect(b.maxDecisionCount).toBe(500); // 默认值
  });

  it("accepts OrchestrationConfig with all fields customized", () => {
    const cfg = OrchestrationConfig.fromRaw({
      max_repair_per_task: 8,
      diagram_repair_before_regenerate: 4,
      design_repair_before_regenerate: 5,
      max_regenerate_per_task: 3,
      max_replan_count: 3,
      max_runtime_seconds: 2700,
      max_decision_count: 800,
      max_planner_failures: 2,
      max_evaluator_timeouts: 2,
      max_save_failures: 2,
      max_final_major_issues: 5,
      max_final_major_repair_per_task: 5,
      min_runtime_remaining_for_new_work_seconds: 60,
    });
    const b = new BudgetManager(cfg);
    expect(b.maxRepairPerTask).toBe(8);
    expect(b.diagramRepairBeforeRegenerate).toBe(4);
    expect(b.designRepairBeforeRegenerate).toBe(5);
    expect(b.maxRegeneratePerTask).toBe(3);
    expect(b.maxReplanCount).toBe(3);
    expect(b.maxRuntimeSeconds).toBe(2700);
    expect(b.maxDecisionCount).toBe(800);
    expect(b.maxPlannerFailures).toBe(2);
    expect(b.maxEvaluatorTimeouts).toBe(2);
    expect(b.maxSaveFailures).toBe(2);
    expect(b.maxFinalMajorIssues).toBe(5);
    expect(b.maxFinalMajorRepairPerTask).toBe(5);
    expect(b.minRuntimeRemainingForNewWorkSeconds).toBe(60);
  });
});

// -----------------------------------------------------------------------
// BudgetManager — 运行时方法
// -----------------------------------------------------------------------

describe("BudgetManager runtime methods", () => {
  const bm = new BudgetManager();

  it("runtimeDeadline adds maxRuntimeSeconds to startTime", () => {
    expect(bm.runtimeDeadline(0)).toBe(1800);
    expect(bm.runtimeDeadline(100)).toBe(1900);
    expect(bm.runtimeDeadline(500)).toBe(2300);
  });

  it("未超过截止时间时 runtimeExhausted 返回 false", () => {
    // startTime=100, now=100, deadline=1900
    expect(bm.runtimeExhausted(100, 100)).toBe(false);
    // 预算充足
    expect(bm.runtimeExhausted(100, 500)).toBe(false);
  });

  it("超过截止时间时 runtimeExhausted 返回 true", () => {
    // startTime=100, now=1900 — 正好在截止时间
    expect(bm.runtimeExhausted(100, 1900)).toBe(true);
    // startTime=100, now=2000 — 已超过截止时间
    expect(bm.runtimeExhausted(100, 2000)).toBe(true);
  });

  it("now 省略时 runtimeExhausted 使用 Date.now()", () => {
    const farPast = 0;
    // maxRuntimeSeconds 很大时不会被耗尽（取决于时钟）
    // 我们只需验证方法不会抛出异常。
    expect(() => bm.runtimeExhausted(Date.now() / 1000)).not.toThrow();
    // 很久以前应该被耗尽
    expect(bm.runtimeExhausted(farPast)).toBe(true);
  });

  it("runtimeRemainingSeconds returns remaining budget", () => {
    expect(bm.runtimeRemainingSeconds(100, 100)).toBe(1800);
    expect(bm.runtimeRemainingSeconds(100, 1000)).toBe(900);
    expect(bm.runtimeRemainingSeconds(100, 1900)).toBe(0);
    expect(bm.runtimeRemainingSeconds(100, 2000)).toBe(0); // 截断为 0
  });

  it("hasRuntimeBudgetForNewWork returns true when enough time remains", () => {
    // min required = 120s, remaining = 1800s
    expect(bm.hasRuntimeBudgetForNewWork(100, 100)).toBe(true);
    // remaining = 120s, exactly at threshold
    expect(bm.hasRuntimeBudgetForNewWork(100, 1780)).toBe(true);
  });

  it("hasRuntimeBudgetForNewWork returns false when not enough time", () => {
    // remaining = 119s
    expect(bm.hasRuntimeBudgetForNewWork(100, 1781)).toBe(false);
    // remaining = 0
    expect(bm.hasRuntimeBudgetForNewWork(100, 1900)).toBe(false);
  });
});

// -----------------------------------------------------------------------
// BudgetManager — minRuntimeForTaskType / hasRuntimeBudgetForTaskType
// -----------------------------------------------------------------------

describe("BudgetManager task-type runtime methods", () => {
  const bm = new BudgetManager();

  it("minRuntimeForTaskType returns type-specific thresholds", () => {
    expect(bm.minRuntimeForTaskType("analyze")).toBe(600);
    expect(bm.minRuntimeForTaskType("design")).toBe(360);
    expect(bm.minRuntimeForTaskType("diagrams")).toBe(240);
    expect(bm.minRuntimeForTaskType("tests")).toBe(240);
  });

  it("minRuntimeForTaskType falls back to default for unknown types", () => {
    expect(bm.minRuntimeForTaskType("unknown")).toBe(120);
    expect(bm.minRuntimeForTaskType("")).toBe(120);
  });

  it("时间充足时 hasRuntimeBudgetForTaskType 返回 true", () => {
    // startTime=100, now=100 → remaining=1800, analyze 需要 600
    expect(bm.hasRuntimeBudgetForTaskType(100, "analyze", 100)).toBe(true);
    // design 需要 360, remaining 500 → ok
    expect(bm.hasRuntimeBudgetForTaskType(100, "design", 800)).toBe(true);
  });

  it("时间不足时 hasRuntimeBudgetForTaskType 返回 false", () => {
    // startTime=100, now=1400 → remaining=500, analyze 需要 600
    expect(bm.hasRuntimeBudgetForTaskType(100, "analyze", 1400)).toBe(false);
    // 未知类型，默认为 120, remaining=100
    // startTime=100, deadline=1900, now=1781 → remaining=119 < 120
    expect(bm.hasRuntimeBudgetForTaskType(100, "unknown", 1781)).toBe(false);
  });

  it("now 省略时 hasRuntimeBudgetForTaskType 使用 Date.now()", () => {
    // 开始时间很早 → 没有剩余时间
    const bmFar = new BudgetManager(
      OrchestrationConfig.fromRaw({ max_runtime_seconds: 1 }),
    );
    expect(bmFar.hasRuntimeBudgetForTaskType(0, "analyze")).toBe(false);
  });
});

// -----------------------------------------------------------------------
// BudgetManager — decisionExhausted
// -----------------------------------------------------------------------

describe("BudgetManager decisionExhausted", () => {
  const bm = new BudgetManager(); // maxDecisionCount = 500

  it("returns false when under limit", () => {
    expect(bm.decisionExhausted(0)).toBe(false);
    expect(bm.decisionExhausted(100)).toBe(false);
    expect(bm.decisionExhausted(499)).toBe(false);
  });

  it("returns true when at or above limit", () => {
    expect(bm.decisionExhausted(500)).toBe(true);
    expect(bm.decisionExhausted(999)).toBe(true);
  });

  it("respects custom maxDecisionCount", () => {
    const bmLow = new BudgetManager(
      OrchestrationConfig.fromRaw({ max_decision_count: 5 }),
    );
    expect(bmLow.decisionExhausted(0)).toBe(false);
    expect(bmLow.decisionExhausted(4)).toBe(false);
    expect(bmLow.decisionExhausted(5)).toBe(true);
  });
});

// -----------------------------------------------------------------------
// BudgetManager — convergenceRoundsExhausted / maxConvergenceRounds
// -----------------------------------------------------------------------

describe("BudgetManager convergenceRoundsExhausted / maxConvergenceRounds", () => {
  it("default maxConvergenceRounds is 6", () => {
    expect(new BudgetManager().maxConvergenceRounds).toBe(6);
    expect(new OrchestrationConfig().maxConvergenceRounds).toBe(6);
  });

  it("convergenceRoundsExhausted returns false strictly below the cap", () => {
    const bm = new BudgetManager(); // cap = 6
    expect(bm.convergenceRoundsExhausted(0)).toBe(false);
    expect(bm.convergenceRoundsExhausted(5)).toBe(false);
  });

  it("convergenceRoundsExhausted returns true at or above the cap", () => {
    const bm = new BudgetManager(); // cap = 6
    expect(bm.convergenceRoundsExhausted(6)).toBe(true);
    expect(bm.convergenceRoundsExhausted(7)).toBe(true);
    expect(bm.convergenceRoundsExhausted(100)).toBe(true);
  });

  it("fromRaw propagates max_convergence_rounds override", () => {
    const cfg = OrchestrationConfig.fromRaw({ max_convergence_rounds: 4 });
    expect(cfg.maxConvergenceRounds).toBe(4);
    const bm = new BudgetManager(cfg);
    expect(bm.maxConvergenceRounds).toBe(4);
    expect(bm.convergenceRoundsExhausted(3)).toBe(false);
    expect(bm.convergenceRoundsExhausted(4)).toBe(true);
  });
});

// -----------------------------------------------------------------------
// BudgetManager — 从快照获取任务计数
// -----------------------------------------------------------------------

describe("BudgetManager snapshot-based count methods", () => {
  const bm = new BudgetManager();

  it("repairCount returns 0 for unknown task", () => {
    const s = snap();
    expect(bm.repairCount(s, "task-1")).toBe(0);
  });

  it("repairCount returns count from snapshot", () => {
    const s = snap({ repairCountsByTask: { "task-1": 3, "task-2": 1 } });
    expect(bm.repairCount(s, "task-1")).toBe(3);
    expect(bm.repairCount(s, "task-2")).toBe(1);
  });

  it("regenerateCount returns 0 for unknown task", () => {
    const s = snap();
    expect(bm.regenerateCount(s, "task-99")).toBe(0);
  });

  it("regenerateCount returns count from snapshot", () => {
    const s = snap({ regenerateCountsByTask: { "task-a": 2 } });
    expect(bm.regenerateCount(s, "task-a")).toBe(2);
  });

  it("taskType returns from artifactTypesByTask first", () => {
    const s = snap({
      artifactTypesByTask: { "t1": "diagrams" },
      planTaskTypesById: { "t1": "design" },
    });
    expect(bm.taskType(s, "t1")).toBe("diagrams");
  });

  it("taskType falls back to planTaskTypesById", () => {
    const s = snap({
      artifactTypesByTask: {},
      planTaskTypesById: { "t1": "design" },
    });
    expect(bm.taskType(s, "t1")).toBe("design");
  });

  it("taskType returns empty string for unknown task", () => {
    const s = snap();
    expect(bm.taskType(s, "unknown")).toBe("");
  });
});

// -----------------------------------------------------------------------
// BudgetManager — canRepair / canRepairFinalMajor
// -----------------------------------------------------------------------

describe("BudgetManager canRepair / canRepairFinalMajor", () => {
  const bm = new BudgetManager(); // maxRepairPerTask = 4, maxFinalMajorRepairPerTask = 3

  it("canRepair returns true when under maxRepairPerTask", () => {
    const s = snap({ repairCountsByTask: { "t1": 0 } });
    expect(bm.canRepair(s, "t1")).toBe(true);
    const s2 = snap({ repairCountsByTask: { "t1": 3 } });
    expect(bm.canRepair(s2, "t1")).toBe(true);
  });

  it("canRepair returns false when at or above maxRepairPerTask", () => {
    const s = snap({ repairCountsByTask: { "t1": 4 } });
    expect(bm.canRepair(s, "t1")).toBe(false);
    const s2 = snap({ repairCountsByTask: { "t1": 5 } });
    expect(bm.canRepair(s2, "t1")).toBe(false);
  });

  it("canRepair returns true for unknown task (0 repairs)", () => {
    const s = snap();
    expect(bm.canRepair(s, "new-task")).toBe(true);
  });

  it("canRepairFinalMajor uses maxFinalMajorRepairPerTask", () => {
    const s = snap({ repairCountsByTask: { "t1": 0 } });
    expect(bm.canRepairFinalMajor(s, "t1")).toBe(true);
    const s2 = snap({ repairCountsByTask: { "t1": 2 } });
    expect(bm.canRepairFinalMajor(s2, "t1")).toBe(true);
    const s3 = snap({ repairCountsByTask: { "t1": 3 } });
    expect(bm.canRepairFinalMajor(s3, "t1")).toBe(false);
  });
});

// -----------------------------------------------------------------------
// BudgetManager — shouldRegenerate
// -----------------------------------------------------------------------

describe("BudgetManager shouldRegenerate", () => {
  const bm = new BudgetManager(); // maxRegeneratePerTask=1, diagramRepairBeforeRegenerate=2, designRepairBeforeRegenerate=2

  it("returns false when regenerate count already at max", () => {
    const s = snap({
      artifactTypesByTask: { "t1": "diagrams" },
      repairCountsByTask: { "t1": 3 },
      regenerateCountsByTask: { "t1": 1 },
    });
    expect(bm.shouldRegenerate(s, "t1")).toBe(false);
  });

  it("returns true for diagrams type when repairs >= diagramRepairBeforeRegenerate", () => {
    const s = snap({
      artifactTypesByTask: { "t1": "diagrams" },
      repairCountsByTask: { "t1": 2 },
      regenerateCountsByTask: { "t1": 0 },
    });
    expect(bm.shouldRegenerate(s, "t1")).toBe(true);

    const s2 = snap({
      artifactTypesByTask: { "t1": "diagrams" },
      repairCountsByTask: { "t1": 5 },
      regenerateCountsByTask: { "t1": 0 },
    });
    expect(bm.shouldRegenerate(s2, "t1")).toBe(true);
  });

  it("returns false for diagrams when repairs < diagramRepairBeforeRegenerate", () => {
    const s = snap({
      artifactTypesByTask: { "t1": "diagrams" },
      repairCountsByTask: { "t1": 1 },
      regenerateCountsByTask: { "t1": 0 },
    });
    expect(bm.shouldRegenerate(s, "t1")).toBe(false);
  });

  it("returns true for design type when repairs >= designRepairBeforeRegenerate", () => {
    const s = snap({
      artifactTypesByTask: { "t1": "design" },
      repairCountsByTask: { "t1": 2 },
      regenerateCountsByTask: { "t1": 0 },
    });
    expect(bm.shouldRegenerate(s, "t1")).toBe(true);
  });

  it("returns false for design when repairs < designRepairBeforeRegenerate", () => {
    const s = snap({
      artifactTypesByTask: { "t1": "design" },
      repairCountsByTask: { "t1": 1 },
      regenerateCountsByTask: { "t1": 0 },
    });
    expect(bm.shouldRegenerate(s, "t1")).toBe(false);
  });

  it("returns false for unknown task types regardless of repairs", () => {
    const s = snap({
      artifactTypesByTask: { "t1": "tests" },
      planTaskTypesById: { "t1": "tests" },
      repairCountsByTask: { "t1": 10 },
      regenerateCountsByTask: { "t1": 0 },
    });
    expect(bm.shouldRegenerate(s, "t1")).toBe(false);
  });

  it("uses planTaskTypesById as fallback for task type", () => {
    const s = snap({
      artifactTypesByTask: {},
      planTaskTypesById: { "t1": "diagrams" },
      repairCountsByTask: { "t1": 3 },
      regenerateCountsByTask: { "t1": 0 },
    });
    expect(bm.shouldRegenerate(s, "t1")).toBe(true);
  });
});

// -----------------------------------------------------------------------
// BudgetManager — canReplan
// -----------------------------------------------------------------------

describe("BudgetManager canReplan", () => {
  const bm = new BudgetManager(); // maxPlannerFailures=3, maxReplanCount=2

  it("returns true when all conditions are met", () => {
    const s = snap({
      planReady: true,
      isDirectMode: false,
      runningTasks: [],
      evaluatorRunning: false,
      plannerFailures: 0,
      planRevisionCount: 0,
    });
    expect(bm.canReplan(s)).toBe(true);
  });

  it("returns false when plan is not ready", () => {
    const s = snap({ planReady: false });
    expect(bm.canReplan(s)).toBe(false);
  });

  it("returns false when in direct mode", () => {
    const s = snap({ planReady: true, isDirectMode: true });
    expect(bm.canReplan(s)).toBe(false);
  });

  it("returns false when tasks are running", () => {
    const s = snap({
      planReady: true,
      isDirectMode: false,
      runningTasks: ["task-1"],
    });
    expect(bm.canReplan(s)).toBe(false);
  });

  it("returns false when evaluator is running", () => {
    const s = snap({
      planReady: true,
      isDirectMode: false,
      runningTasks: [],
      evaluatorRunning: true,
    });
    expect(bm.canReplan(s)).toBe(false);
  });

  it("规划器失败次数过高时返回 false", () => {
    const s = snap({
      planReady: true,
      isDirectMode: false,
      runningTasks: [],
      evaluatorRunning: false,
      plannerFailures: 3, // maxPlannerFailures=3，所以 failures < 3 为 false
    });
    expect(bm.canReplan(s)).toBe(false);
  });

  it("计划修订次数超过限制时返回 false", () => {
    const s = snap({
      planReady: true,
      isDirectMode: false,
      runningTasks: [],
      evaluatorRunning: false,
      plannerFailures: 0,
      planRevisionCount: 2, // maxReplanCount=2，所以 revisionCount < 2 为 false
    });
    expect(bm.canReplan(s)).toBe(false);
  });

  it("returns false when all tasks are running, evaluator running, and failures maxed", () => {
    const s = snap({
      planReady: true,
      isDirectMode: false,
      runningTasks: ["t1"],
      evaluatorRunning: true,
      plannerFailures: 3,
      planRevisionCount: 2,
    });
    expect(bm.canReplan(s)).toBe(false);
  });

  it("plannerFailures 正好低于限制时返回 true", () => {
    const s = snap({
      planReady: true,
      isDirectMode: false,
      runningTasks: [],
      evaluatorRunning: false,
      plannerFailures: 2, // maxPlannerFailures=3，2 < 3 → true
      planRevisionCount: 0,
    });
    expect(bm.canReplan(s)).toBe(true);
  });

  it("planRevisionCount 正好低于限制时返回 true", () => {
    const s = snap({
      planReady: true,
      isDirectMode: false,
      runningTasks: [],
      evaluatorRunning: false,
      plannerFailures: 0,
      planRevisionCount: 1, // maxReplanCount=2，1 < 2 → true
    });
    expect(bm.canReplan(s)).toBe(true);
  });
});
