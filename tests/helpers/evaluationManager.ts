/**
 * Evaluation manager for benchmark evaluation.
 *
 * Ported from governance/evaluation_manager.py.
 *
 * Manages benchmark runs, score aggregation across multiple runs,
 * and historical trending.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Logger, setupLogger } from "../../src/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentConfig {
  llm: {
    provider: string;
    model: string;
    apiKey: string;
    baseUrl: string;
    temperature: number;
    maxTokens: number;
    timeout: number;
  };
  retry: { maxRetries: number };
  output: { defaultDir: string };
  logging: { level: string; logDir: string };
  [key: string]: unknown;
}

interface CaseResult {
  caseName: string;
  status: string;
  scores: Record<string, number>;
  passed: boolean;
  runs?: number;
  [key: string]: unknown;
}

interface BenchmarkReport {
  runTime: string;
  totalRuns: number;
  totalCases: number;
  results: CaseResult[];
  summary: Record<string, unknown>;
  [key: string]: unknown;
}

interface HistoryEntry {
  timestamp: string;
  runs: number;
  summary: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// EvaluationManager
// ---------------------------------------------------------------------------

export class EvaluationManager {
  static readonly METRICS = [
    "requirement_coverage",
    "diagram_syntax",
    "entity_accuracy",
    "process_completeness",
    "state_diagram",
    "consistency",
    "overall",
  ];

  readonly config: AgentConfig;
  readonly history: HistoryEntry[] = [];
  private readonly _logger: Logger;

  constructor(config: AgentConfig) {
    this.config = config;
    this._logger = setupLogger("reqdesign.eval");
  }

  /**
   * Run benchmark evaluation.
   *
   * @param casesDir - Directory containing benchmark cases.
   * @param goldDir - Directory containing gold labels.
   * @param outputDir - Directory for result output.
   * @param runs - Number of runs to average (reduces LLM randomness).
   * @returns The merged benchmark report.
   */
  runBenchmark(
    casesDir = "benchmark/cases",
    goldDir = "benchmark/gold_labels",
    outputDir = "benchmark/results",
    runs = 1,
  ): BenchmarkReport {
    this._logger.info(`开始benchmark评估，运行${runs}次`);

    if (runs < 1) {
      throw new Error("runs must be >= 1");
    }

    const allReports: BenchmarkReport[] = [];

    for (let i = 0; i < runs; i++) {
      if (runs > 1) {
        this._logger.info(`第 ${i + 1}/${runs} 次运行`);
      }

      // Placeholder: in practice this would call BenchmarkRunner
      const report = this._runSingle(
        casesDir,
        goldDir,
        outputDir,
        runs > 1 ? i + 1 : undefined,
      );

      if (!report || typeof report !== "object") {
        this._logger.error(`第 ${i + 1} 次运行返回无效结果`);
        allReports.push({
          runTime: "",
          totalRuns: 0,
          totalCases: 0,
          results: [],
          summary: {},
        });
      } else {
        allReports.push(report);
      }
    }

    const merged =
      runs > 1 ? this._mergeRuns(allReports, outputDir) : allReports[0];

    this.history.push({
      timestamp: new Date().toISOString(),
      runs,
      summary: merged.summary ?? {},
    });

    return merged;
  }

  /**
   * Run a single benchmark pass.
   *
   * Basic implementation: validates that output files exist and conform to expected structure.
   * For production use, extend this with semantic quality checks (e.g., LLM-based evaluation).
   */
  private _runSingle(
    casesDir: string,
    goldDir: string,
    outputDir: string,
    _runIndex?: number,
  ): BenchmarkReport {
    this._logger.info(
      `Running benchmark: cases=${casesDir}, gold=${goldDir}, output=${outputDir}`,
    );

    const results: CaseResult[] = [];

    // Basic validation: check if expected output files exist
    // This is a minimal implementation - in production you'd want:
    // 1. JSON schema validation
    // 2. Content quality checks
    // 3. LLM-based semantic evaluation
    const fs = require("node:fs");
    const path = require("node:path");

    try {
      if (!fs.existsSync(outputDir)) {
        this._logger.error(`Output directory does not exist: ${outputDir}`);
        return {
          runTime: new Date().toISOString().replace("T", " ").slice(0, 19),
          totalRuns: 1,
          totalCases: 0,
          results: [],
          summary: { error: "output_dir_missing" },
        };
      }

      // Check for common output files
      const expectedFiles = [
        "requirement_analysis.json",
        "system_design.md",
        "diagrams.json",
        "test_cases.md",
      ];

      const foundFiles = expectedFiles.filter((file) =>
        fs.existsSync(path.join(outputDir, file)),
      );

      const passed = foundFiles.length >= 2; // At least 2 outputs present
      const score = foundFiles.length / expectedFiles.length;

      results.push({
        caseName: "output_validation",
        status: passed ? "passed" : "failed",
        scores: { completeness: score },
        passed,
        issues: expectedFiles
          .filter((f) => !foundFiles.includes(f))
          .map((f) => `Missing file: ${f}`),
      });

      return {
        runTime: new Date().toISOString().replace("T", " ").slice(0, 19),
        totalRuns: 1,
        totalCases: results.length,
        results,
        summary: {
          passed: results.filter((r) => r.passed).length,
          failed: results.filter((r) => !r.passed).length,
          avgScore:
            results.reduce((sum, r) => sum + (r.scores?.completeness ?? 0), 0) /
            results.length,
        },
      };
    } catch (error: unknown) {
      this._logger.error(
        `Benchmark execution failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        runTime: new Date().toISOString().replace("T", " ").slice(0, 19),
        totalRuns: 1,
        totalCases: 0,
        results: [],
        summary: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  /**
   * Merge multiple benchmark runs, computing average scores per case.
   */
  private _mergeRuns(
    reports: BenchmarkReport[],
    outputDir: string,
  ): BenchmarkReport {
    if (reports.length === 0) {
      return {
        runTime: "",
        totalRuns: 0,
        totalCases: 0,
        results: [],
        summary: {},
      };
    }

    // Aggregate scores by case name
    const caseScores = new Map<string, Record<string, number>[]>();

    for (const report of reports) {
      for (const result of report.results ?? []) {
        const name = result.caseName;
        if (!name) {
          this._logger.warn(
            `结果缺少case_name，跳过: ${JSON.stringify(result)}`,
          );
          continue;
        }
        if (!caseScores.has(name)) {
          caseScores.set(name, []);
        }
        if (result.status === "success") {
          caseScores.get(name)!.push(result.scores ?? {});
        }
      }
    }

    // Compute average per case
    const avgResults: CaseResult[] = [];

    for (const [caseName, scoreList] of caseScores) {
      if (scoreList.length === 0) {
        avgResults.push({
          caseName,
          status: "error",
          scores: Object.fromEntries(
            EvaluationManager.METRICS.map((m) => [m, 0]),
          ),
          passed: false,
          runs: 0,
        });
        continue;
      }

      const avgScores: Record<string, number> = {};
      for (const metric of EvaluationManager.METRICS) {
        const values = scoreList.map((s) => s[metric] ?? 0);
        avgScores[metric] =
          values.length > 0
            ? Math.round(
                (values.reduce((a, b) => a + b, 0) / values.length) * 10,
              ) / 10
            : 0;
      }

      const passed = (avgScores["overall"] ?? 0) >= 80;

      avgResults.push({
        caseName,
        status: "success",
        scores: avgScores,
        passed,
        runs: scoreList.length,
      });
    }

    // Compute summary
    const summary = this._computeSummary(avgResults);

    const merged: BenchmarkReport = {
      runTime: new Date().toISOString().replace("T", " ").slice(0, 19),
      totalRuns: reports.length,
      totalCases: avgResults.length,
      results: avgResults,
      summary,
    };

    // Save merged results
    try {
      mkdirSync(outputDir, { recursive: true });
      const reportPath = join(outputDir, "benchmark_report.json");
      writeFileSync(reportPath, JSON.stringify(merged, null, 2), {
        encoding: "utf8",
      });
    } catch (e) {
      this._logger.error(`保存合并结果失败: ${e}`);
    }

    return merged;
  }

  /**
   * Compute a summary from results.
   *
   * Delegates to computeRunSummary — a standalone function that
   * mirrors the Python scorer.compute_run_summary.
   */
  private _computeSummary(results: CaseResult[]): Record<string, unknown> {
    return computeRunSummary(results);
  }
}

// ---------------------------------------------------------------------------
// computeRunSummary (ported from benchmark/scorer.py)
// ---------------------------------------------------------------------------

/**
 * Compute a summary from benchmark results.
 *
 * Returns aggregate statistics: pass rate, average scores per metric, etc.
 */
export function computeRunSummary(
  results: CaseResult[],
): Record<string, unknown> {
  if (results.length === 0) {
    return {
      total: 0,
      passed: 0,
      failed: 0,
      error: 0,
      passRate: 0,
      overallAvg: 0,
    };
  }

  let passedCount = 0;
  let failedCount = 0;
  let errorCount = 0;

  const metricSums: Record<string, number> = {};
  const metricMax: Record<string, number> = {};
  const metricMin: Record<string, number> = {};
  let scoreCount = 0;

  for (const r of results) {
    if (r.status === "error") {
      errorCount++;
      continue;
    }

    if (r.passed) {
      passedCount++;
    } else {
      failedCount++;
    }

    for (const [metric, value] of Object.entries(r.scores)) {
      metricSums[metric] = (metricSums[metric] ?? 0) + value;
      metricMax[metric] = Math.max(metricMax[metric] ?? value, value);
      metricMin[metric] = Math.min(metricMin[metric] ?? value, value);
    }
    scoreCount++;
  }

  const metricAverages: Record<string, number> = {};
  const safeScoreCount = scoreCount || 1;
  for (const m of EvaluationManager.METRICS) {
    metricAverages[m] =
      Math.round(((metricSums[m] ?? 0) / safeScoreCount) * 10) / 10;
  }

  return {
    total: results.length,
    passed: passedCount,
    failed: failedCount,
    error: errorCount,
    passRate:
      results.length > 0
        ? Math.round((passedCount / results.length) * 100 * 10) / 10
        : 0,
    overallAvg: metricAverages["overall"] ?? 0,
    metricAverages,
    metricMax,
    metricMin,
  };
}
