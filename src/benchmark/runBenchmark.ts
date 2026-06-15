import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../config.js";
import { setupLogger } from "../logger.js";
import { LLMClient } from "../llmClient.js";
import { MultiAgentRuntime } from "../runtime.js";
import { OutputManager } from "../outputManager.js";
import { createWorkflowEvent, type WorkflowEvent, type WorkflowEventSink } from "../workflowEvents.js";
import {
  casePassed,
  caseGateFailures,
  combineScores,
  computeRunSummary,
  judgeCoverage,
  type BenchmarkCaseResult,
  type GoldLabel,
  type JudgeClient,
} from "./scorer.js";

interface BenchmarkCase {
  name: string;
  casePath: string;
  goldPath: string;
}

export interface BenchmarkRunOptions {
  onEvent?: WorkflowEventSink;
}

/** Minimal runtime surface needed by BenchmarkRunner. */
export interface RuntimeLike {
  run(
    goal: string,
    inputPath: string,
    outputDir: string,
    options?: { onEvent?: WorkflowEventSink },
  ): Promise<{
    requirementJson: unknown;
    diagrams: unknown;
    getMajorPendingTaskIds(): string[];
    finalReviewPassed: boolean;
    persisted: boolean;
    qualityStatus: string;
    reviewResult: Record<string, unknown>;
  }>;
  cancel(reason?: string): void;
}

/** Factory that produces a RuntimeLike; injectable for testing. */
export type RuntimeFactory = (config: AgentConfig) => RuntimeLike;

export class BenchmarkRunner {
  private readonly logger = setupLogger("reqdesign.benchmark");
  private judge: JudgeClient | undefined;
  private readonly runtimeFactory: RuntimeFactory;

  /**
   * All benchmark artifacts — case outputs, summary reports, and the
   * aggregate report — are grouped under a `benchmark` subdirectory of the
   * caller-provided base output dir, so they align with the `.bat` log files
   * (also written under `outputs/benchmark/`).
   */
  private readonly benchmarkDir: string;

  /**
   * @param outputDir base output directory (e.g. `outputs/`); benchmark
   *   artifacts are nested under `<outputDir>/benchmark/`.
   * @param judge optional coverage judge; defaults to an LLMClient built from
   *   `config` (constructed lazily so report/discovery helpers need no LLM).
   * @param runtimeFactory optional factory for creating runtime instances;
   *   defaults to `(c) => new MultiAgentRuntime(c)`. Inject a mock for tests.
   */
  constructor(
    private readonly config: AgentConfig,
    private readonly casesDir: string,
    private readonly goldDir: string,
    outputDir: string,
    judge?: JudgeClient,
    runtimeFactory?: RuntimeFactory,
  ) {
    this.judge = judge;
    this.runtimeFactory = runtimeFactory ?? ((c) => new MultiAgentRuntime(c));
    this.benchmarkDir = join(outputDir, "benchmark");
  }

  private coverageJudge(): JudgeClient {
    if (!this.judge) this.judge = new LLMClient(this.config);
    return this.judge;
  }

  findCases(): BenchmarkCase[] {
    if (!existsSync(this.casesDir)) {
      throw new Error(`案例目录不存在: ${this.casesDir}`);
    }
    if (!existsSync(this.goldDir)) {
      throw new Error(`标注目录不存在: ${this.goldDir}`);
    }
    const cases: BenchmarkCase[] = [];
    for (const filename of readdirSync(this.casesDir).sort()) {
      if (!filename.endsWith(".md")) continue;
      const caseName = filename.replace(/\.md$/i, "");
      const goldPath = join(this.goldDir, `${caseName}.json`);
      if (!existsSync(goldPath)) {
        this.logger.warn(`案例 ${caseName} 缺少 gold label 文件`);
        continue;
      }
      cases.push({ name: caseName, casePath: join(this.casesDir, filename), goldPath });
    }
    return cases;
  }

  async runCase(
    testCase: BenchmarkCase,
    options?: BenchmarkRunOptions,
  ): Promise<BenchmarkCaseResult> {
    this.emitEvent("benchmark_case_started", `running case ${testCase.name}`, {
      caseName: testCase.name,
      data: { casePath: testCase.casePath },
    }, options?.onEvent);

    let gold: GoldLabel;
    try {
      gold = JSON.parse(readFileSync(testCase.goldPath, "utf8")) as GoldLabel;
    } catch (error: unknown) {
      return this.errorResult(testCase, `gold label加载失败: ${msg(error)}`, options);
    }

    try {
      const caseOutputDir = join(this.benchmarkDir, testCase.name);
      const runtime = this.runtimeFactory(this.config);
      const timeoutSeconds = this.config.benchmark.caseTimeoutSeconds;

      const runPromise = runtime.run("design", testCase.casePath, caseOutputDir, {
        onEvent: options?.onEvent
          ? (event) => options.onEvent?.({
            ...event,
            caseName: testCase.name,
            data: { ...(event.data ?? {}), casePath: testCase.casePath },
          })
          : undefined,
      });

      let rawState: Awaited<ReturnType<RuntimeLike["run"]>>;
      if (timeoutSeconds > 0) {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`benchmark case timeout after ${timeoutSeconds}s`)),
            timeoutSeconds * 1000,
          ),
        );
        try {
          rawState = await Promise.race([runPromise, timeoutPromise]);
        } catch (err: unknown) {
          if (err instanceof Error && err.message.startsWith("benchmark case timeout")) {
            runtime.cancel("benchmark case timeout");
            return this.errorResult(testCase, err.message, options);
          }
          throw err;
        }
      } else {
        rawState = await runPromise;
      }
      const state = rawState;

      const result = state.requirementJson as Record<string, unknown>;
      const diagrams = (state.diagrams ?? {}) as Record<string, unknown>;

      // Coverage = LLM judge; everything else = deterministic.
      const coverage = await judgeCoverage(this.coverageJudge(), gold, result);
      const scores = combineScores({ coverage: coverage.score, result, diagrams });
      // Respect the pipeline's own final-review gate: a case it rejected
      // (unresolved blocker/major issues) must not be reported as passed.
      const openMajor = state.getMajorPendingTaskIds().length;
      const gateInput = {
        overall: scores.overall,
        openMajorIssues: openMajor,
        finalReviewPassed: Boolean(state.finalReviewPassed),
        persisted: Boolean(state.persisted),
        qualityStatus: String(state.qualityStatus ?? "unknown"),
      };
      const gateFailures = caseGateFailures(gateInput);
      const passed = casePassed(gateInput);

      // Best-effort: generate summary_report.md for the benchmark case. The
      // normal exit path bypasses OutputManager.saveAll (which generates the
      // summary), so benchmark runs otherwise lose this artifact. Wrap in
      // try/catch so a summary failure never affects case scoring.
      try {
        const manager = new OutputManager(caseOutputDir);
        manager.generateSummary(result, state.reviewResult);
      } catch (summaryError: unknown) {
        this.logger.warn(
          `summary_report.md generation failed for ${testCase.name}: ${summaryError instanceof Error ? summaryError.message : String(summaryError)}`,
        );
      }

      this.emitEvent("benchmark_case_completed", `case ${testCase.name} completed`, {
        caseName: testCase.name,
        status: passed ? "completed" : "failed",
        data: { overall: scores.overall, passed },
      }, options?.onEvent);

      return {
        case_name: testCase.name,
        status: "success",
        passed,
        scores,
        coverage_detail: coverage.detail,
        review_passed: Boolean(state.finalReviewPassed),
        review_blockers: openMajor,
        persisted: Boolean(state.persisted),
        quality_status: String(state.qualityStatus ?? "unknown"),
        gate_failures: gateFailures,
      };
    } catch (error: unknown) {
      return this.errorResult(testCase, msg(error), options);
    }
  }

  private errorResult(
    testCase: BenchmarkCase,
    error: string,
    options?: BenchmarkRunOptions,
  ): BenchmarkCaseResult {
    this.emitEvent("benchmark_case_completed", `case ${testCase.name} errored`, {
      caseName: testCase.name,
      status: "error",
      data: { error },
    }, options?.onEvent);
    return { case_name: testCase.name, status: "error", error, scores: {} };
  }

  async runAll(options?: BenchmarkRunOptions): Promise<Record<string, unknown>> {
    const cases = this.findCases();
    this.emitEvent("benchmark_started", `benchmark started with ${cases.length} cases`, {
      status: "running",
      data: { casesDir: this.casesDir, outputDir: this.benchmarkDir, totalCases: cases.length },
    }, options?.onEvent);

    const results: BenchmarkCaseResult[] = [];
    for (const testCase of cases) {
      results.push(await this.runCase(testCase, options));
    }

    const summary = computeRunSummary(results);
    const report = {
      run_time: new Date().toISOString().replace("T", " ").slice(0, 19),
      total_cases: cases.length,
      results,
      summary,
    };

    if (cases.length > 0) {
      mkdirSync(this.benchmarkDir, { recursive: true });
      writeFileSync(join(this.benchmarkDir, "benchmark_report.json"), JSON.stringify(report, null, 2), "utf8");
      writeFileSync(join(this.benchmarkDir, "benchmark_report.md"), this.generateMdReport(report), "utf8");
    }

    this.emitEvent("benchmark_completed", "benchmark completed", {
      status: "completed",
      data: { totalCases: cases.length, summary },
    }, options?.onEvent);
    return report;
  }

  generateMdReport(report: Record<string, unknown>): string {
    const results = Array.isArray(report.results) ? report.results as BenchmarkCaseResult[] : [];
    const summary = (report.summary as Record<string, unknown> | undefined) ?? {};
    const avg = (summary.avg_scores as Record<string, number> | undefined) ?? {};

    const lines = [
      "# 基准测试报告",
      "",
      `运行时间: ${String(report.run_time ?? "")}`,
      "",
      `总案例数: ${String(report.total_cases ?? 0)}`,
      "",
      "## 汇总",
      `- 通过: ${String(summary.passed ?? 0)}`,
      `- 未通过: ${String(summary.failed ?? 0)}`,
      `- 错误: ${String(summary.error ?? 0)}`,
    ];

    if (Object.keys(avg).length > 0) {
      lines.push("", "## 平均得分", "", "| 指标 | 得分 |", "|------|------|");
      lines.push(`| 需求覆盖度(LLM) | ${avg.coverage ?? 0} |`);
      lines.push(`| 图语法 | ${avg.diagram_syntax ?? 0} |`);
      lines.push(`| 图结构 | ${avg.diagram_structure ?? 0} |`);
      lines.push(`| 一致性 | ${avg.consistency ?? 0} |`);
      lines.push(`| **综合得分** | **${avg.overall ?? 0}** |`);
    }

    lines.push(
      "",
      "## 各案例详情",
      "",
      "| 案例 | 状态 | 覆盖度 | 图语法 | 图结构 | 一致性 | 综合 | 通过 | 失败门禁 |",
      "|------|------|--------|--------|--------|--------|------|------|----------|",
    );
    for (const r of results) {
      if (r.status === "success") {
        const s = r.scores ?? {};
        const gateFailures = (r.gate_failures ?? []).join("; ");
        lines.push(
          `| ${r.case_name} | success | ${s.coverage ?? 0} | ${s.diagram_syntax ?? 0} | ${s.diagram_structure ?? 0} | ${s.consistency ?? 0} | ${s.overall ?? 0} | ${r.passed ? "是" : "否"} | ${gateFailures || "-"} |`,
        );
      } else {
        lines.push(`| ${r.case_name} | ${r.status} | - | - | - | - | - | - | - |`);
      }
    }
    const gated = results.filter(
      (r) => r.status === "success" && !r.passed && (r.gate_failures ?? []).length > 0,
    );
    if (gated.length > 0) {
      lines.push("", "> 注：以下案例综合分可能达标，但未通过运行时质量门禁，故记为未通过：");
      for (const r of gated) {
        lines.push(`> - ${r.case_name}: ${(r.gate_failures ?? []).join("; ")}`);
      }
    }
    lines.push("");
    return lines.join("\n");
  }

  private emitEvent(
    kind: string,
    message: string,
    extras?: Partial<WorkflowEvent>,
    sink?: WorkflowEventSink,
  ): void {
    sink?.(createWorkflowEvent({ scope: "benchmark", kind, message, ...extras }));
  }
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
