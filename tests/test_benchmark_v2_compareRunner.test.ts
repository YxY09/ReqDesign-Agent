/**
 * Compare-benchmark unit tests: compareRunner.ts — CLI parsing, case scoping,
 * report shape + deltas, incremental atomic writes, and a full offline
 * runCompare with stub baseline LLM + stub judge + stub runtime.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseCompareCliArgs,
  discoverCompareCases,
  compareRunPaths,
  loadPartialReport,
  computeDelta,
  aggregateCompare,
  renderCompareReportMd,
  runCompare,
  type SideScore,
  type CompareCaseEntry,
  type CompareReport,
  DEFAULT_COMPARE_RESULTS_BASE_DIR,
} from "../src/benchmark/compareRunner.js";
import { AgentConfig } from "../src/config.js";
import type { JudgeClient } from "../src/benchmark/scorer.js";
import type { RuntimeFactory } from "../src/benchmark/runtimeContract.js";
import type { GoldContract } from "../src/benchmark/goldObligation.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "compare-runner-"));
});
afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Empty (all-null) side score — mirrors the runner's NULL_SCORES. */
function nullSide(outputDir: string): SideScore {
  return {
    quality: {
      gold_obligation_coverage: null,
      traceability_truthfulness: null,
      test_effectiveness: null,
      design_depth: null,
      final_score: null,
    },
    scored: false,
    output_dir: outputDir,
  };
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

describe("parseCompareCliArgs", () => {
  it("parses --case and other flags", () => {
    const opts = parseCompareCliArgs(["--case", "hospital_mgmt", "--run-id", "r1", "--skip-agent"]);
    expect(opts!.caseId).toBe("hospital_mgmt");
    expect(opts!.runId).toBe("r1");
    expect(opts!.skipAgent).toBe(true);
  });

  it("returns null for --help", () => {
    expect(parseCompareCliArgs(["--help"])).toBeNull();
    expect(parseCompareCliArgs(["-h"])).toBeNull();
  });

  it("throws on an unknown argument", () => {
    expect(() => parseCompareCliArgs(["--bogus"])).toThrow(/unknown compare argument/);
  });
});

describe("DEFAULT_COMPARE_RESULTS_BASE_DIR is gitignored-safe", () => {
  it("points under benchmark/results (gitignored), not top-level results/", () => {
    expect(DEFAULT_COMPARE_RESULTS_BASE_DIR).toBe("benchmark/results");
  });
});

// ---------------------------------------------------------------------------
// Case discovery
// ---------------------------------------------------------------------------

describe("discoverCompareCases", () => {
  it("lists cases that have both .md and gold contract", () => {
    const casesDir = join(root, "cases");
    const goldDir = join(root, "gold");
    mkdirSync(casesDir, { recursive: true });
    mkdirSync(goldDir, { recursive: true });
    writeFileSync(join(casesDir, "a.md"), "# a");
    writeFileSync(join(casesDir, "b.md"), "# b");
    writeFileSync(join(goldDir, "a.json"), JSON.stringify(validContract("a")));
    // b has no gold → excluded.
    expect(discoverCompareCases(casesDir, goldDir)).toEqual(["a"]);
  });
});

function validContract(caseId: string): GoldContract {
  return {
    case_id: caseId,
    source_language: "en",
    canonical_language: "en",
    obligations: [
      {
        id: "C-001",
        type: "constraint",
        severity: "major",
        source_span: "the X limit is 50",
        expected_design_evidence: ["a 50 limit check"],
        expected_test_evidence: ["51 rejected"],
        anti_patterns: ["no number"],
      },
      {
        id: "F-001",
        type: "functional",
        severity: "minor",
        source_span: "the create flow",
        expected_design_evidence: ["create step"],
        expected_test_evidence: [],
        anti_patterns: [],
      },
      {
        id: "X-001",
        type: "exception",
        severity: "minor",
        source_span: "on failure, retry",
        expected_design_evidence: ["retry behavior"],
        expected_test_evidence: [],
        anti_patterns: [],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Delta + aggregation (null → 0 honest)
// ---------------------------------------------------------------------------

describe("computeDelta — null treated as 0", () => {
  it("agent wins produce positive deltas; null sides count as 0", () => {
    const baseline = nullSide(join(root, "b"));
    const agent: SideScore = {
      quality: {
        gold_obligation_coverage: 80,
        traceability_truthfulness: 70,
        test_effectiveness: 60,
        design_depth: 50,
        final_score: 65,
      },
      scored: true,
      output_dir: join(root, "a"),
    };
    const delta = computeDelta(baseline, agent);
    expect(delta.final_score).toBe(65);
    expect(delta.gold_obligation_coverage).toBe(80);
  });

  it("equal scores produce zero deltas", () => {
    const side: SideScore = {
      quality: { gold_obligation_coverage: 50, traceability_truthfulness: 50, test_effectiveness: 50, design_depth: 50, final_score: 50 },
      scored: true,
      output_dir: join(root, "x"),
    };
    expect(computeDelta(side, side).final_score).toBe(0);
  });
});

describe("aggregateCompare", () => {
  it("counts wins/ties and means", () => {
    // Three cases: agent beats baseline (10→30), tie (20→20), baseline beats agent (40→10).
    const entries: CompareCaseEntry[] = [
      mk(10, 30),
      mk(20, 20),
      mk(40, 10),
    ];
    const agg = aggregateCompare(entries);
    expect(agg.total_cases).toBe(3);
    expect(agg.agent_wins).toBe(1);
    expect(agg.ties).toBe(1);
    expect(agg.baseline_wins).toBe(1);
    // mean agent final = (30+20+10)/3 = 20; mean baseline = (10+20+40)/3 ≈ 23.3.
    expect(agg.mean_agent.final_score).toBe(20);
    expect(agg.mean_baseline.final_score).toBe(23.3);
    // mean delta final = (20 + 0 - 30)/3 ≈ -3.3.
    expect(agg.mean_delta.final_score).toBe(-3.3);
  });

  function mk(baselineFinal: number, agentFinal: number): CompareCaseEntry {
    return {
      case_id: `c_${baselineFinal}_${agentFinal}`,
      baseline: { quality: { gold_obligation_coverage: baselineFinal, traceability_truthfulness: baselineFinal, test_effectiveness: baselineFinal, design_depth: baselineFinal, final_score: baselineFinal }, scored: true, output_dir: "b" },
      agent: { quality: { gold_obligation_coverage: agentFinal, traceability_truthfulness: agentFinal, test_effectiveness: agentFinal, design_depth: agentFinal, final_score: agentFinal }, scored: true, output_dir: "a" },
      delta: { gold_obligation_coverage: agentFinal - baselineFinal, traceability_truthfulness: agentFinal - baselineFinal, test_effectiveness: agentFinal - baselineFinal, design_depth: agentFinal - baselineFinal, final_score: agentFinal - baselineFinal },
    };
  }
});

// ---------------------------------------------------------------------------
// Report rendering + paths + partial loading
// ---------------------------------------------------------------------------

describe("compareRunPaths + loadPartialReport + renderCompareReportMd", () => {
  it("builds paths under <base>/compare/<runId>/", () => {
    const p = compareRunPaths(root, "run1");
    expect(p.root).toBe(join(root, "compare", "run1"));
    expect(p.reportJson.endsWith("compare_report.json")).toBe(true);
  });

  it("loadPartialReport returns null when absent", () => {
    expect(loadPartialReport(join(root, "none.json"))).toBeNull();
  });

  it("renderCompareReportMd produces a table with per-case + aggregate rows", () => {
    const report: CompareReport = {
      run_id: "r1",
      timestamp: "2026-01-01T00:00:00Z",
      judge_model: "m",
      cases: [
        {
          case_id: "demo",
          baseline: { quality: { gold_obligation_coverage: 10, traceability_truthfulness: 10, test_effectiveness: 10, design_depth: 10, final_score: 10 }, scored: true, output_dir: "b" },
          agent: { quality: { gold_obligation_coverage: 80, traceability_truthfulness: 80, test_effectiveness: 80, design_depth: 80, final_score: 80 }, scored: true, output_dir: "a" },
          delta: { gold_obligation_coverage: 70, traceability_truthfulness: 70, test_effectiveness: 70, design_depth: 70, final_score: 70 },
        },
      ],
      aggregate: aggregateCompare([]),
    };
    const md = renderCompareReportMd(report);
    expect(md).toContain("# Baseline vs Agent");
    expect(md).toContain("| demo |");
    expect(md).toContain("| **delta** |");
  });
});

// ---------------------------------------------------------------------------
// Full offline runCompare with stubs
// ---------------------------------------------------------------------------

describe("runCompare — offline with stub baseline + stub judge + stub runtime", () => {
  function seed(casesDir: string, goldDir: string, ids: string[]): void {
    mkdirSync(casesDir, { recursive: true });
    mkdirSync(goldDir, { recursive: true });
    for (const id of ids) {
      writeFileSync(join(casesDir, `${id}.md`), `# ${id}\n约束 limit 50`, "utf8");
      writeFileSync(join(goldDir, `${id}.json`), JSON.stringify(validContract(id)), "utf8");
    }
  }

  /** A stub judge that gives a fixed, higher score than the null baseline floor. */
  function stubJudge(agentFinal: number): JudgeClient {
    return {
      generateJson: async () => ({
        extracted_design_evidence: ["a 50 limit check"],
        extracted_test_evidence: ["51 rejected"],
        missing_evidence: [],
        score: 3,
        score_basis: {
          has_concrete_rule: true,
          has_trigger_condition: true,
          has_handling_behavior: true,
          has_test_alignment: true,
        },
        reason: "stub full coverage",
      }),
    };
    void agentFinal;
  }

  /** A stub runtime that writes a complete Agent-aligned artifact set. */
  function stubRuntimeFactory(): RuntimeFactory {
    return () => ({
      run: (_goal: string, _inputPath: string, outputDir: string) => {
        mkdirSync(join(outputDir, "design"), { recursive: true });
        writeFileSync(join(outputDir, "design", "system_design.md"), "# design with 50 limit", "utf8");
        mkdirSync(join(outputDir, "tests"), { recursive: true });
        writeFileSync(join(outputDir, "tests", "test_cases.json"), JSON.stringify({ test_cases: [{ id: "TC-1", expected_result: "51 rejected" }] }), "utf8");
        return Promise.resolve({
          requirementJson: {},
          diagrams: {},
          getMajorPendingTaskIds: () => [],
          finalReviewPassed: true,
          persisted: true,
          qualityStatus: "passed",
          reviewResult: {},
        });
      },
      cancel: () => {},
    });
  }

  it("runs both sides for one case, scores, writes the report (json + md), and computes a delta", async () => {
    const casesDir = join(root, "cases");
    const goldDir = join(root, "gold");
    seed(casesDir, goldDir, ["alpha"]);

    const report = await runCompare(new AgentConfig(), {
      casesDir,
      goldDir,
      resultsBaseDir: root,
      runId: "run1",
      // baseline stub returns near-empty → judge scores it low (the stub judge
      // keys off design text, so an empty baseline design → null/low quality).
      baselineLlm: { generateJson: async () => ({ system_design: "", test_cases: [] }) },
      judge: stubJudge(80),
      runtimeFactory: stubRuntimeFactory(),
    });

    expect(report.run_id).toBe("run1");
    expect(report.cases).toHaveLength(1);
    expect(report.cases[0].case_id).toBe("alpha");
    // Agent side scored (stub judge gives full coverage).
    expect(report.cases[0].agent.scored).toBe(true);
    expect(report.cases[0].agent.quality.final_score).toBeGreaterThan(0);
    // Report files exist on disk.
    const paths = compareRunPaths(root, "run1");
    expect(existsSync(paths.reportJson)).toBe(true);
    expect(existsSync(paths.reportMd)).toBe(true);

    // Partial was also written (incremental flush).
    expect(existsSync(paths.partialJson)).toBe(true);
  });

  it("--case scoping restricts to one case", async () => {
    const casesDir = join(root, "cases");
    const goldDir = join(root, "gold");
    seed(casesDir, goldDir, ["alpha", "beta", "gamma"]);

    const report = await runCompare(new AgentConfig(), {
      casesDir,
      goldDir,
      resultsBaseDir: root,
      runId: "scoped",
      caseId: "beta",
      skipAgent: true, // speed: we only test scoping, not the agent run
      baselineLlm: { generateJson: async () => ({ system_design: "", test_cases: [] }) },
      judge: stubJudge(80),
    });

    expect(report.cases.map((c) => c.case_id)).toEqual(["beta"]);
  });

  it("incremental: a crash in the 2nd case does not lose the 1st (partial is flushed per case)", async () => {
    const casesDir = join(root, "cases");
    const goldDir = join(root, "gold");
    seed(casesDir, goldDir, ["ok1"]);

    // First run writes the partial for ok1.
    const report = await runCompare(new AgentConfig(), {
      casesDir,
      goldDir,
      resultsBaseDir: root,
      runId: "incr",
      skipAgent: true,
      baselineLlm: { generateJson: async () => ({ system_design: "design", test_cases: [{ id: "TC-1" }] }) },
      judge: stubJudge(80),
    });
    expect(report.cases.map((c) => c.case_id)).toEqual(["ok1"]);

    // The partial file exists and contains the scored case.
    const paths = compareRunPaths(root, "incr");
    expect(existsSync(paths.partialJson)).toBe(true);
    const partial = JSON.parse(readFileSync(paths.partialJson, "utf8")) as CompareReport;
    expect(partial.cases[0].case_id).toBe("ok1");
  });
});
