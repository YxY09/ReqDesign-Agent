import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../config.js";
import { setupLogger } from "../logger.js";
import { LLMClient } from "../llmClient.js";
import { MultiAgentRuntime } from "../runtime.js";
import { createWorkflowEvent, type WorkflowEvent, type WorkflowEventSink } from "../workflowEvents.js";
import {
  combineScores,
  computeRunSummary,
  isPassing,
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

export class BenchmarkRunner {
  private readonly logger = setupLogger("reqdesign.benchmark");
  private judge: JudgeClient | undefined;

  /**
   * @param judge optional coverage judge; defaults to an LLMClient built from
   *   `config` (constructed lazily so report/discovery helpers need no LLM).
   */
  constructor(
    private readonly config: AgentConfig,
    private readonly casesDir: string,
    private readonly goldDir: string,
    private readonly outputDir: string,
    judge?: JudgeClient,
  ) {
    this.judge = judge;
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
      const caseOutputDir = join(this.outputDir, testCase.name);
      const runtime = new MultiAgentRuntime(this.config);
      const state = await runtime.run("design", testCase.casePath, caseOutputDir, {
        onEvent: options?.onEvent
          ? (event) => options.onEvent?.({
            ...event,
            caseName: testCase.name,
            data: { ...(event.data ?? {}), casePath: testCase.casePath },
          })
          : undefined,
      });

      const result = state.requirementJson as Record<string, unknown>;
      const diagrams = (state.diagrams ?? {}) as Record<string, unknown>;

      // Coverage = LLM judge; everything else = deterministic.
      const coverage = await judgeCoverage(this.coverageJudge(), gold, result);
      const scores = combineScores({ coverage: coverage.score, result, diagrams });
      const passed = isPassing(scores.overall);

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
      data: { casesDir: this.casesDir, outputDir: this.outputDir, totalCases: cases.length },
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
      mkdirSync(this.outputDir, { recursive: true });
      writeFileSync(join(this.outputDir, "benchmark_report.json"), JSON.stringify(report, null, 2), "utf8");
      writeFileSync(join(this.outputDir, "benchmark_report.md"), this.generateMdReport(report), "utf8");
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
      "| 案例 | 状态 | 覆盖度 | 图语法 | 图结构 | 一致性 | 综合 | 通过 |",
      "|------|------|--------|--------|--------|--------|------|------|",
    );
    for (const r of results) {
      if (r.status === "success") {
        const s = r.scores ?? {};
        lines.push(
          `| ${r.case_name} | success | ${s.coverage ?? 0} | ${s.diagram_syntax ?? 0} | ${s.diagram_structure ?? 0} | ${s.consistency ?? 0} | ${s.overall ?? 0} | ${r.passed ? "是" : "否"} |`,
        );
      } else {
        lines.push(`| ${r.case_name} | ${r.status} | - | - | - | - | - | - |`);
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
