/**
 * BenchmarkRunner (case discovery + report rendering) and the EvaluationManager
 * test helper. Scorer unit tests live in test_benchmark_scorer.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { BenchmarkRunner, type RuntimeFactory } from "../src/benchmark/runBenchmark.js";
import {
  EvaluationManager,
  computeRunSummary as govComputeRunSummary,
} from "./helpers/evaluationManager.js";
import { AgentConfig } from "../src/config.js";

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
    const runner = new BenchmarkRunner(new AgentConfig(), "/nonexistent", "/nonexistent", "/tmp");
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
    // case2 has no gold label → not discovered

    const runner = new BenchmarkRunner(new AgentConfig(), casesDir, goldDir, join(tmpDir, "out"));
    const cases = runner.findCases();
    expect(cases).toHaveLength(1);
    expect(cases[0].name).toBe("case1");
  });

  it("generateMdReport has correct structure", () => {
    const runner = new BenchmarkRunner(new AgentConfig(), "", "", "");
    const md = runner.generateMdReport({
      run_time: "2025-01-01 00:00:00",
      total_cases: 1,
      results: [
        {
          case_name: "test",
          status: "success",
          passed: true,
          scores: { coverage: 100, diagram_syntax: 100, diagram_structure: 100, consistency: 100, overall: 100 },
        },
      ],
      summary: { passed: 1, failed: 0, error: 0, avg_scores: { overall: 100 } },
    });
    expect(md).toContain("# 基准测试报告");
    expect(md).toContain("| 案例 |");
    expect(md).toContain("覆盖度");
    expect(md).toContain("test");
    expect(md).toContain("100");
    expect(md).toContain("是");
  });

  it("generateMdReport shows dash for error cases", () => {
    const runner = new BenchmarkRunner(new AgentConfig(), "", "", "");
    const md = runner.generateMdReport({
      run_time: "2025-01-01 00:00:00",
      total_cases: 1,
      results: [{ case_name: "fail", status: "error", error: "timeout" }],
      summary: { passed: 0, failed: 0, error: 1, avg_scores: {} },
    });
    expect(md).toContain("fail");
    expect(md).toContain("error");
    expect(md).toContain("| - |");
  });

  it("generateMdReport shows 否 for passed=false", () => {
    const runner = new BenchmarkRunner(new AgentConfig(), "", "", "");
    const md = runner.generateMdReport({
      run_time: "2025-01-01 00:00:00",
      total_cases: 1,
      results: [
        {
          case_name: "low_score",
          status: "success",
          passed: false,
          scores: { coverage: 50, diagram_syntax: 50, diagram_structure: 50, consistency: 50, overall: 50 },
        },
      ],
      summary: { passed: 0, failed: 1, error: 0, avg_scores: { overall: 50 } },
    });
    expect(md).toContain("low_score");
    expect(md).toContain("否");
    expect(md).toContain("50");
  });

  it("generateMdReport notes cases gated by the review", () => {
    const runner = new BenchmarkRunner(new AgentConfig(), "", "", "");
    const md = runner.generateMdReport({
      run_time: "2025-01-01 00:00:00",
      total_cases: 1,
      results: [
        {
          case_name: "hospital",
          status: "success",
          passed: false,
          review_blockers: 6,
          review_passed: true,
          persisted: true,
          quality_status: "passed",
          gate_failures: ["6 unresolved major/blocker issue(s)"],
          scores: { coverage: 90, diagram_syntax: 100, diagram_structure: 100, consistency: 66, overall: 90 },
        },
      ],
      summary: { passed: 0, failed: 1, error: 0, avg_scores: { overall: 90 } },
    });
    expect(md).toContain("未通过运行时质量门禁");
    expect(md).toContain("hospital");
    expect(md).toContain("6 unresolved major/blocker issue(s)");
  });

  it("runCase returns error and calls cancel on per-case timeout", async () => {
    const casesDir = join(tmpDir, "cases");
    const goldDir = join(tmpDir, "gold");
    const outDir = join(tmpDir, "out");
    mkdirSync(casesDir);
    mkdirSync(goldDir);
    writeFileSync(join(casesDir, "tc.md"), "# TC", "utf8");
    writeFileSync(
      join(goldDir, "tc.json"),
      JSON.stringify({ actors: [], functions: [], entities: [] }),
      "utf8",
    );

    let cancelCalled = false;
    const mockFactory: RuntimeFactory = () => ({
      run: () => new Promise(() => {}), // never resolves
      cancel: () => { cancelCalled = true; },
    });

    const config = new AgentConfig({
      benchmark: { entityNameMap: {}, functionSynonyms: {}, caseTimeoutSeconds: 0.05 },
    });

    const runner = new BenchmarkRunner(config, casesDir, goldDir, outDir, undefined, mockFactory);
    const [testCase] = runner.findCases();
    const result = await runner.runCase(testCase);

    expect(result.status).toBe("error");
    expect(result.error).toContain("timeout");
    expect(cancelCalled).toBe(true);
  }, 5000);

  it("runCase respects caseTimeoutSeconds=0 (unlimited — no timeout race)", async () => {
    const casesDir = join(tmpDir, "cases");
    const goldDir = join(tmpDir, "gold");
    const outDir = join(tmpDir, "out");
    mkdirSync(casesDir);
    mkdirSync(goldDir);
    writeFileSync(join(casesDir, "instant.md"), "# Instant", "utf8");
    writeFileSync(
      join(goldDir, "instant.json"),
      JSON.stringify({ actors: [], functions: [], entities: [] }),
      "utf8",
    );

    const mockState = {
      requirementJson: {},
      diagrams: {},
      getMajorPendingTaskIds: () => [],
      finalReviewPassed: true,
      persisted: true,
      qualityStatus: "passed",
      reviewResult: {},
    };
    const mockFactory: RuntimeFactory = () => ({
      run: () => Promise.resolve(mockState),
      cancel: () => {},
    });

    // Using a stub judge so no LLM is called
    const stubJudge = {
      generateJson: async () => ({ score: 100, detail: {} }),
    } as never;

    const config = new AgentConfig({
      benchmark: { entityNameMap: {}, functionSynonyms: {}, caseTimeoutSeconds: 0 },
    });

    const runner = new BenchmarkRunner(config, casesDir, goldDir, outDir, stubJudge, mockFactory);
    const [testCase] = runner.findCases();
    const result = await runner.runCase(testCase);

    expect(result.status).toBe("success");
  }, 5000);

  it("runCase fails when runtime final quality gates fail despite high score", async () => {
    const casesDir = join(tmpDir, "cases");
    const goldDir = join(tmpDir, "gold");
    const outDir = join(tmpDir, "out");
    mkdirSync(casesDir);
    mkdirSync(goldDir);
    writeFileSync(join(casesDir, "rejected.md"), "# Rejected", "utf8");
    writeFileSync(
      join(goldDir, "rejected.json"),
      JSON.stringify({ expected_functions: ["登录"] }),
      "utf8",
    );

    const mockState = {
      requirementJson: { functions: [{ name: "登录" }], entities: [] },
      diagrams: {
        class_diagram: "classDiagram\n  class User",
        activity_diagram: "flowchart TD\n  A[开始] --> B{判断} -->|是| C[结束]",
        state_diagram: "stateDiagram-v2\n  [*] --> Open\n  Open --> Closed\n  Closed --> [*]",
      },
      getMajorPendingTaskIds: () => [],
      finalReviewPassed: false,
      persisted: false,
      qualityStatus: "rejected",
      reviewResult: {},
    };
    const mockFactory: RuntimeFactory = () => ({
      run: () => Promise.resolve(mockState),
      cancel: () => {},
    });
    const stubJudge = {
      generateJson: async () => ({
        functions: { covered: ["登录"], missing: [] },
      }),
    } as never;

    const runner = new BenchmarkRunner(
      new AgentConfig(),
      casesDir,
      goldDir,
      outDir,
      stubJudge,
      mockFactory,
    );
    const [testCase] = runner.findCases();
    const result = await runner.runCase(testCase);

    expect(result.status).toBe("success");
    expect(result.scores?.overall).toBeGreaterThanOrEqual(80);
    expect(result.passed).toBe(false);
    expect(result.gate_failures).toEqual([
      "final review did not pass",
      "quality status is rejected",
      "outputs were not persisted",
    ]);
  });
});

// ===========================================================================
// EvaluationManager (test helper)
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
            scores: { overall: 80, coverage: 90, diagram_syntax: 100, diagram_structure: 70, consistency: 95 },
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
            scores: { overall: 90, coverage: 95, diagram_syntax: 100, diagram_structure: 80, consistency: 95 },
          },
        ],
        summary: {},
      },
    ];

    const dir = join(tmpdir(), `eval-merge-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const merged = (mgr as any)._mergeRuns(reports, dir);
      expect(merged.totalRuns).toBe(2);
      expect(merged.results).toHaveLength(1);
      const case1 = merged.results[0];
      expect(case1.caseName).toBe("case1");
      expect(case1.status).toBe("success");
      expect(case1.scores.overall).toBe(85.0);
      expect(case1.runs).toBe(2);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("merge runs — all failed fills 0.0 scores", () => {
    const mgr = makeManager();
    const reports = [
      { runTime: "", totalRuns: 1, totalCases: 1, results: [{ caseName: "case1", status: "error", scores: {} }], summary: {} },
      { runTime: "", totalRuns: 1, totalCases: 1, results: [{ caseName: "case1", status: "error", scores: {} }], summary: {} },
    ];
    const dir = join(tmpdir(), `eval-fail-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const merged = (mgr as any)._mergeRuns(reports, dir);
      const case1 = merged.results[0];
      expect(case1.status).toBe("error");
      expect(case1.scores.overall).toBe(0.0);
      expect(case1.runs).toBe(0);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
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
    const dir = join(tmpdir(), `eval-history-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      mgr.runBenchmark("cases", "gold", dir, 1);
      expect(mgr.history).toHaveLength(1);
      expect(mgr.history[0]).toHaveProperty("timestamp");
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ===========================================================================
// govComputeRunSummary (governance helper)
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
