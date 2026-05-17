import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../config.js";
import { setupLogger } from "../logger.js";
import { MultiAgentRuntime } from "../runtime.js";
import { createWorkflowEvent, type WorkflowEvent, type WorkflowEventSink } from "../workflowEvents.js";
import {
  computeOverallScore,
  computeRunSummary,
  scoreConsistency,
  scoreDiagramSyntax,
  scoreEntityAccuracy,
  scoreProcessCompleteness,
  scoreRequirementCoverage,
  scoreStateDiagram,
  type BenchmarkCaseResult,
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

  constructor(
    private readonly config: AgentConfig,
    private readonly casesDir: string,
    private readonly goldDir: string,
    private readonly outputDir: string,
  ) {}

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
      cases.push({
        name: caseName,
        casePath: join(this.casesDir, filename),
        goldPath,
      });
    }
    return cases;
  }

  async runCase(
    testCase: BenchmarkCase,
    options?: BenchmarkRunOptions,
  ): Promise<BenchmarkCaseResult> {
    this.emitEvent("benchmark_case_started", `running case ${testCase.name}`, {
      caseName: testCase.name,
      data: {
        casePath: testCase.casePath,
      },
    }, options?.onEvent);
    const caseOutputDir = join(this.outputDir, testCase.name);
    let gold: Record<string, unknown>;
    try {
      gold = JSON.parse(readFileSync(testCase.goldPath, "utf8")) as Record<string, unknown>;
    } catch (error: unknown) {
      const result = {
        case_name: testCase.name,
        status: "error",
        error: `gold label加载失败: ${error instanceof Error ? error.message : String(error)}`,
        scores: {},
      };
      this.emitEvent("benchmark_case_completed", `case ${testCase.name} failed to load gold labels`, {
        caseName: testCase.name,
        status: "error",
      }, options?.onEvent);
      return result;
    }

    try {
      const runtime = new MultiAgentRuntime(this.config);
      const state = await runtime.run("design", testCase.casePath, caseOutputDir, {
        onEvent: options?.onEvent
          ? (event) => {
            options.onEvent?.({
              ...event,
              caseName: testCase.name,
              data: {
                ...(event.data ?? {}),
                casePath: testCase.casePath,
              },
            });
          }
          : undefined,
      });
      const requirementResult = state.requirementJson;
      const diagrams = state.diagrams;
      const scores: Record<string, number> = {
        requirement_coverage: scoreRequirementCoverage(requirementResult, gold),
        diagram_syntax: scoreDiagramSyntax(diagrams),
        entity_accuracy: scoreEntityAccuracy(requirementResult, gold),
        process_completeness: scoreProcessCompleteness(diagrams, gold),
        state_diagram: scoreStateDiagram(diagrams, gold),
        consistency: scoreConsistency(requirementResult, diagrams),
      };
      scores.overall = computeOverallScore({
        requirementCoverage: scores.requirement_coverage,
        diagramSyntax: scores.diagram_syntax,
        entityAccuracy: scores.entity_accuracy,
        processCompleteness: scores.process_completeness,
        consistency: scores.consistency,
        stateDiagram: scores.state_diagram,
      });
      const result = {
        case_name: testCase.name,
        status: "success",
        passed: scores.overall >= 80,
        scores,
      };
      this.emitEvent("benchmark_case_completed", `case ${testCase.name} completed`, {
        caseName: testCase.name,
        status: result.passed ? "completed" : "failed",
        data: {
          overall: scores.overall,
          passed: result.passed,
        },
      }, options?.onEvent);
      return result;
    } catch (error: unknown) {
      const result = {
        case_name: testCase.name,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        scores: {},
      };
      this.emitEvent("benchmark_case_completed", `case ${testCase.name} errored`, {
        caseName: testCase.name,
        status: "error",
        data: {
          error: result.error,
        },
      }, options?.onEvent);
      return result;
    }
  }

  async runAll(options?: BenchmarkRunOptions): Promise<Record<string, unknown>> {
    const cases = this.findCases();
    this.emitEvent("benchmark_started", `benchmark started with ${cases.length} cases`, {
      status: "running",
      data: {
        casesDir: this.casesDir,
        outputDir: this.outputDir,
        totalCases: cases.length,
      },
    }, options?.onEvent);
    if (cases.length === 0) {
      const report = {
        run_time: "",
        total_cases: 0,
        results: [],
        summary: { passed: 0, failed: 0, error: 0, avg_scores: {} },
      };
      this.emitEvent("benchmark_completed", "benchmark finished with no cases", {
        status: "completed",
        data: {
          totalCases: 0,
        },
      }, options?.onEvent);
      return report;
    }

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

    mkdirSync(this.outputDir, { recursive: true });
    writeFileSync(
      join(this.outputDir, "benchmark_report.json"),
      JSON.stringify(report, null, 2),
      "utf8",
    );
    writeFileSync(
      join(this.outputDir, "benchmark_report.md"),
      this.generateMdReport(report),
      "utf8",
    );
    this.emitEvent("benchmark_completed", "benchmark completed", {
      status: "completed",
      data: {
        totalCases: cases.length,
        summary,
      },
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
      lines.push(`| 需求覆盖率 | ${avg.requirement_coverage ?? 0} |`);
      lines.push(`| 图语法通过率 | ${avg.diagram_syntax ?? 0} |`);
      lines.push(`| 实体识别准确率 | ${avg.entity_accuracy ?? 0} |`);
      lines.push(`| 流程完整性 | ${avg.process_completeness ?? 0} |`);
      lines.push(`| 状态图完整性 | ${avg.state_diagram ?? 0} |`);
      lines.push(`| 一致性 | ${avg.consistency ?? 0} |`);
      lines.push(`| **综合得分** | **${avg.overall ?? 0}** |`);
    }

    lines.push(
      "",
      "## 各案例详情",
      "",
      "| 案例 | 状态 | 需求覆盖 | 图语法 | 实体准确 | 流程完整 | 状态图 | 一致性 | 综合 | 通过 |",
      "|------|------|----------|--------|----------|----------|--------|--------|------|------|",
    );

    for (const result of results) {
      if (result.status === "success") {
        const scores = result.scores ?? {};
        lines.push(
          `| ${result.case_name} | success | ${scores.requirement_coverage ?? 0} | ${scores.diagram_syntax ?? 0} | ${scores.entity_accuracy ?? 0} | ${scores.process_completeness ?? 0} | ${scores.state_diagram ?? 0} | ${scores.consistency ?? 0} | ${scores.overall ?? 0} | ${result.passed ? "是" : "否"} |`,
        );
      } else {
        lines.push(`| ${result.case_name} | ${result.status} | - | - | - | - | - | - | - | - |`);
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
    sink?.(
      createWorkflowEvent({
        scope: "benchmark",
        kind,
        message,
        ...extras,
      }),
    );
  }
}
