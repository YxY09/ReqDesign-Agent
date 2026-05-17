/**
 * Benchmark scoring & runner tests.
 *
 * Ported from ../tests/test_benchmark.py (Phase 8).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Imports from scorer
// ---------------------------------------------------------------------------

import {
  scoreRequirementCoverage,
  scoreDiagramSyntax,
  scoreEntityAccuracy,
  scoreProcessCompleteness,
  scoreStateDiagram,
  scoreConsistency,
  computeOverallScore,
  computeRunSummary,
  fuzzyMatchEntity,
  editDistance,
  fuzzyMatchFunction,
  matchConstraintOrException,
  type BenchmarkCaseResult,
} from "../src/benchmark/scorer.js";

// ---------------------------------------------------------------------------
// Imports from runBenchmark
// ---------------------------------------------------------------------------

import { BenchmarkRunner } from "../src/benchmark/runBenchmark.js";

// ---------------------------------------------------------------------------
// Imports from evaluationManager (test utility)
// ---------------------------------------------------------------------------

import {
  EvaluationManager,
  computeRunSummary as govComputeRunSummary,
} from "./evaluationManager.js";

// ---------------------------------------------------------------------------
// Imports from config
// ---------------------------------------------------------------------------

import { AgentConfig } from "../src/config.js";

// ===========================================================================
// TestRequirementCoverage
// ===========================================================================

describe("scoreRequirementCoverage", () => {
  it("full coverage", () => {
    const result = {
      actors: [{ name: "学生" }, { name: "管理员" }],
      functions: [{ name: "用户登录" }, { name: "图书搜索" }, { name: "图书借阅" }],
      entities: [{ name: "用户" }, { name: "图书" }],
      constraints: [{ description: "同一时间一本图书只能被一个用户借阅" }],
      exceptions: [{ description: "图书已被借出" }],
    };
    const gold = {
      expected_actors: ["学生", "管理员"],
      expected_functions: ["用户登录", "图书搜索", "图书借阅"],
      expected_entities: ["用户", "图书"],
      expected_constraints: ["同一时间一本图书只能被一个用户借阅"],
      expected_exceptions: ["图书已被借出"],
    };
    expect(scoreRequirementCoverage(result, gold)).toBe(100.0);
  });

  it("partial coverage", () => {
    const result = {
      actors: [{ name: "学生" }],
      functions: [{ name: "用户登录" }],
      entities: [{ name: "用户" }],
      constraints: [],
      exceptions: [],
    };
    const gold = {
      expected_actors: ["学生", "管理员"],
      expected_functions: ["用户登录", "图书搜索"],
      expected_entities: ["用户", "图书"],
      expected_constraints: ["约束1"],
      expected_exceptions: ["异常1"],
    };
    const score = scoreRequirementCoverage(result, gold);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });

  it("empty gold returns 0", () => {
    const result = { actors: [], functions: [], entities: [], constraints: [], exceptions: [] };
    const gold = { expected_actors: [], expected_functions: [], expected_entities: [], expected_constraints: [], expected_exceptions: [] };
    expect(scoreRequirementCoverage(result, gold)).toBe(0.0);
  });

  it("none values in result do not crash", () => {
    const result = { actors: null, functions: null, entities: null, constraints: null, exceptions: null };
    const gold = {
      expected_actors: ["管理员"],
      expected_functions: ["用户登录"],
      expected_entities: ["用户"],
      expected_constraints: ["约束1"],
      expected_exceptions: ["异常1"],
    };
    expect(scoreRequirementCoverage(result, gold)).toBe(0.0);
  });
});

// ===========================================================================
// TestDiagramSyntax
// ===========================================================================

describe("scoreDiagramSyntax", () => {
  it("all valid", () => {
    const diagrams = {
      class_diagram: "classDiagram\n    class A {\n        +method()\n    }\n    A --> B",
      activity_diagram: "flowchart TD\n    A([开始]) --> B[处理]\n    B --> C([结束])",
    };
    expect(scoreDiagramSyntax(diagrams)).toBe(100.0);
  });

  it("some invalid", () => {
    const diagrams = {
      class_diagram: "classDiagram\n    class A {\n        +method()\n    }\n    A --> B",
      activity_diagram: "invalid content",
    };
    expect(scoreDiagramSyntax(diagrams)).toBe(50.0);
  });

  it("empty", () => {
    expect(scoreDiagramSyntax({})).toBe(0.0);
  });

  it("non-string content is skipped", () => {
    const diagrams: Record<string, unknown> = {
      class_diagram: 123,
      activity_diagram: "flowchart TD\n    A([开始]) --> B[处理]\n    B --> C([结束])",
    };
    // 123 skipped, flowchart passes → 1/2 = 50%
    expect(scoreDiagramSyntax(diagrams)).toBe(50.0);
  });

  it("dict content is skipped", () => {
    const diagrams: Record<string, unknown> = {
      class_diagram: { nested: "dict" },
    };
    expect(scoreDiagramSyntax(diagrams)).toBe(0.0);
  });
});

// ===========================================================================
// TestEntityAccuracy
// ===========================================================================

describe("scoreEntityAccuracy", () => {
  it("full accuracy", () => {
    const result = { entities: [{ name: "用户" }, { name: "图书" }, { name: "借阅记录" }] };
    const gold = { expected_entities: ["用户", "图书", "借阅记录"] };
    expect(scoreEntityAccuracy(result, gold)).toBe(100.0);
  });

  it("partial accuracy", () => {
    const result = { entities: [{ name: "用户" }] };
    const gold = { expected_entities: ["用户", "图书", "借阅记录"] };
    const score = scoreEntityAccuracy(result, gold);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });

  it("null entities returns 0", () => {
    const result = { entities: null };
    const gold = { expected_entities: ["用户"] };
    expect(scoreEntityAccuracy(result, gold)).toBe(0.0);
  });
});

// ===========================================================================
// TestProcessCompleteness
// ===========================================================================

describe("scoreProcessCompleteness", () => {
  it("complete activity", () => {
    const diagrams = {
      activity_diagram: "flowchart TD\n    A([开始]) --> B[用户发起请求]\n    B --> C{是否有效?}\n    C -->|是| D[处理]\n    C -->|否| E[返回错误]\n    D --> F([结束])",
    };
    const gold = { expected_processes: ["请求流程"] };
    const score = scoreProcessCompleteness(diagrams, gold);
    expect(score).toBeGreaterThanOrEqual(75);
  });

  it("no activity diagram", () => {
    const diagrams = {};
    const gold = { expected_processes: [] };
    expect(scoreProcessCompleteness(diagrams, gold)).toBe(0.0);
  });
});

// ===========================================================================
// TestConsistency
// ===========================================================================

describe("scoreConsistency", () => {
  it("consistent", () => {
    const result = { entities: [{ name: "User" }, { name: "Book" }] };
    const diagrams = {
      class_diagram: "classDiagram\n    class User {\n        +login()\n    }\n    class Book {\n        +getInfo()\n    }\n    User --> Book",
      activity_diagram: "flowchart TD\n    User --> Book",
    };
    const score = scoreConsistency(result, diagrams);
    expect(score).toBeGreaterThanOrEqual(80);
  });

  it("inconsistent", () => {
    const result = { entities: [{ name: "User" }, { name: "Order" }] };
    const diagrams = {
      class_diagram: "classDiagram\n    class Product",
      activity_diagram: "flowchart TD\n    A --> B",
    };
    const score = scoreConsistency(result, diagrams);
    expect(score).toBeLessThan(100);
  });

  it("null entities returns 100 (no penalties)", () => {
    const result = { entities: null };
    const diagrams = { class_diagram: "classDiagram\n    class A", activity_diagram: "" };
    expect(scoreConsistency(result, diagrams)).toBe(100.0);
  });
});

// ===========================================================================
// TestOverallScore
// ===========================================================================

describe("computeOverallScore", () => {
  it("weighted computation", () => {
    const score = computeOverallScore({
      requirementCoverage: 90,
      diagramSyntax: 100,
      entityAccuracy: 80,
      processCompleteness: 70,
      consistency: 85,
      stateDiagram: 90,
    });
    const expected = 90 * 0.35 + 100 * 0.2 + 80 * 0.2 + 70 * 0.1 + 90 * 0.05 + 85 * 0.1;
    expect(Math.abs(score - expected)).toBeLessThan(0.1);
  });

  it("perfect score", () => {
    const score = computeOverallScore({
      requirementCoverage: 100,
      diagramSyntax: 100,
      entityAccuracy: 100,
      processCompleteness: 100,
      consistency: 100,
      stateDiagram: 100,
    });
    expect(score).toBe(100.0);
  });

  it("zero score", () => {
    const score = computeOverallScore({
      requirementCoverage: 0,
      diagramSyntax: 0,
      entityAccuracy: 0,
      processCompleteness: 0,
      consistency: 0,
      stateDiagram: 0,
    });
    expect(score).toBe(0.0);
  });

  it("weights sum to 1.0", () => {
    const weights = [0.35, 0.20, 0.20, 0.10, 0.05, 0.10];
    expect(Math.abs(weights.reduce((a, b) => a + b, 0) - 1.0)).toBeLessThan(1e-9);
  });

  it("uses keyword args — avoids positional mistakes", () => {
    const score = computeOverallScore({
      requirementCoverage: 90,
      diagramSyntax: 100,
      entityAccuracy: 80,
      processCompleteness: 70,
      consistency: 85,
      stateDiagram: 90,
    });
    const expected = 90 * 0.35 + 100 * 0.2 + 80 * 0.2 + 70 * 0.1 + 90 * 0.05 + 85 * 0.1;
    expect(Math.abs(score - expected)).toBeLessThan(0.1);
  });
});

// ===========================================================================
// TestStateDiagram
// ===========================================================================

describe("scoreStateDiagram", () => {
  it("complete state diagram", () => {
    const diagrams = {
      state_diagram: "stateDiagram-v2\n    [*] --> 待借阅\n    待借阅 --> 借阅中 : 借阅\n    借阅中 --> 已归还 : 归还\n    已归还 --> [*]",
    };
    const gold = { expected_processes: ["借阅流程"] };
    const score = scoreStateDiagram(diagrams, gold);
    expect(score).toBeGreaterThanOrEqual(70);
  });

  it("no state diagram", () => {
    const diagrams = {};
    const gold = { expected_processes: [] };
    expect(scoreStateDiagram(diagrams, gold)).toBe(0.0);
  });

  it("minimal state diagram", () => {
    const diagrams = {
      state_diagram: "stateDiagram-v2\n    [*] --> A\n    A --> [*]",
    };
    const gold = { expected_processes: [] };
    const score = scoreStateDiagram(diagrams, gold);
    expect(score).toBeGreaterThanOrEqual(50);
  });

  it("two-state diagram scores correctly", () => {
    // [*] (len=2) + Pending (len=7) = 2 states after filter → 15 points
    const diagrams = {
      state_diagram: "stateDiagram-v2\n    [*] --> Pending\n    Pending --> A",
    };
    const gold = { expected_processes: [] };
    const score = scoreStateDiagram(diagrams, gold);
    // [*] gives 30, --> gives 20, 2 states gives 15, no gold gives 25 = 90
    expect(score).toBe(90.0);
  });
});

// ===========================================================================
// TestRunSummary (from scorer)
// ===========================================================================

describe("computeRunSummary (scorer)", () => {
  it("all success", () => {
    const results: BenchmarkCaseResult[] = [
      { case_name: "A", status: "success", passed: true, scores: { overall: 90, requirement_coverage: 95 } },
      { case_name: "B", status: "success", passed: true, scores: { overall: 85, requirement_coverage: 90 } },
    ];
    const summary = computeRunSummary(results) as Record<string, unknown>;
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.error).toBe(0);
    const avgScores = summary.avg_scores as Record<string, number>;
    expect(avgScores.overall).toBe(87.5);
  });

  it("mixed results", () => {
    const results: BenchmarkCaseResult[] = [
      { case_name: "A", status: "success", passed: true, scores: { overall: 90 } },
      { case_name: "B", status: "success", passed: false, scores: { overall: 60 } },
      { case_name: "C", status: "error", error: "timeout" },
    ];
    const summary = computeRunSummary(results) as Record<string, unknown>;
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.error).toBe(1);
  });

  it("all error", () => {
    const results: BenchmarkCaseResult[] = [
      { case_name: "A", status: "error", error: "fail" },
    ];
    const summary = computeRunSummary(results) as Record<string, unknown>;
    expect(summary.passed).toBe(0);
    expect(summary.avg_scores).toEqual({});
  });

  it("empty results", () => {
    const summary = computeRunSummary([]) as Record<string, unknown>;
    expect(summary.passed).toBe(0);
    expect(summary.error).toBe(0);
  });
});

// ===========================================================================
// TestEditDistance
// ===========================================================================

describe("editDistance", () => {
  it("standard cases", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("abc", "")).toBe(3);
  });
});

// ===========================================================================
// TestFuzzyMatchFunction
// ===========================================================================

describe("fuzzyMatchFunction", () => {
  it("edit distance match (long name >= 6 chars)", () => {
    expect(fuzzyMatchFunction("图书管理系统", ["图书管理系统"], "图书管理系统")).toBe(true);
  });

  it("keyword split match", () => {
    expect(fuzzyMatchFunction("用户注册与登录", ["用户注册", "用户登录"], "用户注册 用户登录")).toBe(true);
  });

  it("reverse synonym match", () => {
    expect(fuzzyMatchFunction("图书借阅", ["借阅图书"], "借阅图书")).toBe(true);
  });
});

// ===========================================================================
// TestMatchConstraintOrException
// ===========================================================================

describe("matchConstraintOrException", () => {
  it("direct substring match", () => {
    expect(matchConstraintOrException("密码", "用户密码不能为空")).toBe(true);
  });

  it("keyword split match", () => {
    expect(matchConstraintOrException("密码不能为空", "密码验证：不能为空")).toBe(true);
  });

  it("2-gram fallback match", () => {
    expect(matchConstraintOrException("AB", "xABx")).toBe(true);
    expect(matchConstraintOrException("AB", "xCDx")).toBe(false);
  });

  it("partial keyword match >= 70%", () => {
    // 3 keywords, match 2 = 66.7% < 70%
    expect(matchConstraintOrException("密码不能为空为空", "密码验证")).toBe(false);
    // 3 keywords, match 3 = 100% >= 70%
    expect(matchConstraintOrException("密码不能为空为空", "密码不能为空为空验证")).toBe(true);
  });

  it("number/quantifier match", () => {
    expect(matchConstraintOrException("30分钟内", "响应时间30分钟")).toBe(true);
    expect(matchConstraintOrException("7天", "有效期7天")).toBe(true);
    expect(matchConstraintOrException("6门课程", "选课上限6门")).toBe(true);
  });

  it("core noun match >= 50%", () => {
    expect(matchConstraintOrException("用户密码验证", "密码验证通过")).toBe(true);
  });

  it("empty expected returns false", () => {
    expect(matchConstraintOrException("", "target")).toBe(false);
  });

  it("number mismatch returns false", () => {
    expect(matchConstraintOrException("30分钟", "响应时间60分钟")).toBe(false);
  });

  it("single char expected returns false", () => {
    expect(matchConstraintOrException("A", "some text here")).toBe(false);
  });

  it("single char expected + empty target", () => {
    expect(matchConstraintOrException("A", "")).toBe(false);
  });
});

// ===========================================================================
// TestFuzzyMatchEntity
// ===========================================================================

describe("fuzzyMatchEntity", () => {
  it("reverse lookup — Chinese in target, English entity name", () => {
    expect(fuzzyMatchEntity("Book", "这是一个图书管理系统")).toBe(true);
  });

  it("reverse lookup no match", () => {
    expect(fuzzyMatchEntity("Book", "用户管理模块")).toBe(false);
  });
});

// ===========================================================================
// TestBenchmarkRunner
// ===========================================================================

describe("BenchmarkRunner", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `bench-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("findCases throws on missing directory", () => {
    const config = new AgentConfig();
    const runner = new BenchmarkRunner(config, "/nonexistent", "/nonexistent", "/tmp");
    expect(() => runner.findCases()).toThrow();
  });

  it("findCases discovers cases with matching gold labels", () => {
    const casesDir = join(tmpDir, "cases");
    const goldDir = join(tmpDir, "gold");
    mkdirSync(casesDir);
    mkdirSync(goldDir);
    writeFileSync(join(casesDir, "case1.md"), "# Case 1", "utf8");
    writeFileSync(join(casesDir, "case2.md"), "# Case 2", "utf8");
    writeFileSync(join(goldDir, "case1.json"), "{}", "utf8");
    // case2 has no gold label

    const config = new AgentConfig();
    const runner = new BenchmarkRunner(config, casesDir, goldDir, join(tmpDir, "out"));
    const cases = runner.findCases();
    expect(cases).toHaveLength(1);
    expect(cases[0].name).toBe("case1");
  });

  it("generateMdReport has correct structure", () => {
    const config = new AgentConfig();
    const runner = new BenchmarkRunner(config, "", "", "");
    const report = {
      run_time: "2025-01-01 00:00:00",
      total_cases: 1,
      results: [
        {
          case_name: "test",
          status: "success",
          passed: true,
          scores: {
            requirement_coverage: 100,
            diagram_syntax: 100,
            entity_accuracy: 100,
            process_completeness: 100,
            state_diagram: 100,
            consistency: 100,
            overall: 100,
          },
        },
      ],
      summary: { passed: 1, failed: 0, error: 0, avg_scores: { overall: 100 } },
    };
    const md = runner.generateMdReport(report);
    expect(md).toContain("# 基准测试报告");
    expect(md).toContain("| 案例 |");
    expect(md).toContain("test");
    expect(md).toContain("100");
  });

  it("generateMdReport shows dash for error cases", () => {
    const config = new AgentConfig();
    const runner = new BenchmarkRunner(config, "", "", "");
    const report = {
      run_time: "2025-01-01 00:00:00",
      total_cases: 1,
      results: [{ case_name: "fail", status: "error", error: "timeout" }],
      summary: { passed: 0, failed: 0, error: 1, avg_scores: {} },
    };
    const md = runner.generateMdReport(report);
    expect(md).toContain("fail");
    expect(md).toContain("error");
    expect(md).toContain("| - |");
  });

  it("generateMdReport shows 否 for passed=false", () => {
    const config = new AgentConfig();
    const runner = new BenchmarkRunner(config, "", "", "");
    const report = {
      run_time: "2025-01-01 00:00:00",
      total_cases: 1,
      results: [
        {
          case_name: "low_score",
          status: "success",
          passed: false,
          scores: {
            requirement_coverage: 50,
            diagram_syntax: 50,
            entity_accuracy: 50,
            process_completeness: 50,
            state_diagram: 50,
            consistency: 50,
            overall: 50,
          },
        },
      ],
      summary: { passed: 0, failed: 1, error: 0, avg_scores: { overall: 50 } },
    };
    const md = runner.generateMdReport(report);
    expect(md).toContain("low_score");
    expect(md).toContain("否");
    expect(md).toContain("50");
  });
});

// ===========================================================================
// TestEvaluationManager
// ===========================================================================

describe("EvaluationManager", () => {
  function makeManager(): EvaluationManager {
    const config = new AgentConfig();
    return new EvaluationManager(config as any);
  }

  it("merge runs averages scores", () => {
    const mgr = makeManager();
    const reports = [
      {
        runTime: "2025-01-01",
        totalRuns: 1,
        totalCases: 1,
        results: [
          {
            caseName: "case1",
            status: "success",
            scores: {
              overall: 80,
              requirement_coverage: 90,
              diagram_syntax: 100,
              entity_accuracy: 80,
              process_completeness: 70,
              state_diagram: 85,
              consistency: 95,
            },
          },
        ],
        summary: {},
      },
      {
        runTime: "2025-01-02",
        totalRuns: 1,
        totalCases: 1,
        results: [
          {
            caseName: "case1",
            status: "success",
            scores: {
              overall: 90,
              requirement_coverage: 95,
              diagram_syntax: 100,
              entity_accuracy: 90,
              process_completeness: 80,
              state_diagram: 85,
              consistency: 95,
            },
          },
        ],
        summary: {},
      },
    ];

    const tmpDir = join(tmpdir(), `eval-merge-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      // Access private _mergeRuns via (mgr as any)
      const merged = (mgr as any)._mergeRuns(reports, tmpDir);
      expect(merged.totalRuns).toBe(2);
      expect(merged.results).toHaveLength(1);
      const case1 = merged.results[0];
      expect(case1.caseName).toBe("case1");
      expect(case1.status).toBe("success");
      expect(case1.scores.overall).toBe(85.0);
      expect(case1.runs).toBe(2);
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("merge runs — all failed fills 0.0 scores", () => {
    const mgr = makeManager();
    const reports = [
      {
        runTime: "",
        totalRuns: 1,
        totalCases: 1,
        results: [{ caseName: "case1", status: "error", scores: {} }],
        summary: {},
      },
      {
        runTime: "",
        totalRuns: 1,
        totalCases: 1,
        results: [{ caseName: "case1", status: "error", scores: {} }],
        summary: {},
      },
    ];

    const tmpDir = join(tmpdir(), `eval-fail-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      const merged = (mgr as any)._mergeRuns(reports, tmpDir);
      const case1 = merged.results[0];
      expect(case1.status).toBe("error");
      expect(case1.scores.overall).toBe(0.0);
      expect(case1.runs).toBe(0);
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("merge runs — empty reports returns empty", () => {
    const mgr = makeManager();
    const result = (mgr as any)._mergeRuns([], "/tmp");
    expect(result.totalRuns).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("runBenchmark with runs < 1 throws", () => {
    const mgr = makeManager();
    expect(() => mgr.runBenchmark("cases", "gold", "out", 0)).toThrow(/runs must be >= 1/);
  });

  it("runBenchmark records history", () => {
    const mgr = makeManager();
    // The _runSingle stub returns an empty report; that's fine for this test
    const tmpDir = join(tmpdir(), `eval-history-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      mgr.runBenchmark("cases", "gold", tmpDir, 1);
      expect(mgr.history).toHaveLength(1);
      expect(mgr.history[0]).toHaveProperty("timestamp");
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ===========================================================================
// Test govComputeRunSummary (governance module)
// ===========================================================================

describe("govComputeRunSummary", () => {
  it("empty results returns zeros", () => {
    const summary = govComputeRunSummary([]) as Record<string, unknown>;
    expect(summary.passed).toBe(0);
    expect(summary.error).toBe(0);
    expect(summary.total).toBe(0);
  });

  it("all success", () => {
    const results = [
      { caseName: "A", status: "success", passed: true, scores: { overall: 90 } },
      { caseName: "B", status: "success", passed: true, scores: { overall: 80 } },
    ];
    const summary = govComputeRunSummary(results) as Record<string, unknown>;
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.error).toBe(0);
  });

  it("mixed results", () => {
    const results = [
      { caseName: "A", status: "success", passed: true, scores: { overall: 90 } },
      { caseName: "B", status: "success", passed: false, scores: { overall: 60 } },
      { caseName: "C", status: "error", scores: {} },
    ];
    const summary = govComputeRunSummary(results) as Record<string, unknown>;
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.error).toBe(1);
  });
});
