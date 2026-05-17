/**
 * Output management module: save artifacts to categorized subdirectories.
 *
 * Ported from reqdesign/output_manager.py.
 *
 * Directory structure:
 *   output_dir/
 *   ├── requirement/          Requirement analysis
 *   ├── design/               System design
 *   ├── diagrams/             Mermaid diagrams
 *   ├── tests/                Test cases
 *   ├── review/               Review reports
 *   ├── traces/               Execution traces
 *   └── summary_report.md     Summary report
 */

import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Logger, setupLogger } from "./logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUBDIR_REQUIREMENT = "requirement";
const SUBDIR_DESIGN = "design";
const SUBDIR_DIAGRAMS = "diagrams";
const SUBDIR_TESTS = "tests";
const SUBDIR_REVIEW = "review";
const SUBDIR_TRACES = "traces";

const SAFE_NAME_RE = /^[\w\u4e00-\u9fff\-\.]+$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sanitize filename to prevent path traversal. */
function sanitizeFilename(name: string): string {
  if (!name || !name.trim()) {
    throw new Error("文件名不能为空");
  }
  name = name.replace(/\.\./g, "_");
  name = name.replace(/[/\\]/g, "_");
  if (!SAFE_NAME_RE.test(name)) {
    name = name.replace(/[^\w\u4e00-\u9fff\-\.]/g, "_");
  }
  if (name.length > 200) {
    name = name.slice(0, 200);
  }
  return name;
}

/** Escape markdown table cell content. */
function escapeMdCell(text: unknown): string {
  if (!text) return "";
  return String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// ---------------------------------------------------------------------------
// OutputManager
// ---------------------------------------------------------------------------

export class OutputManager {
  readonly outputDir: string;
  private readonly _logger: Logger;

  constructor(outputDir: string) {
    this.outputDir = resolve(outputDir);
    mkdirSync(this.outputDir, { recursive: true });
    for (const subdir of [
      SUBDIR_REQUIREMENT,
      SUBDIR_DESIGN,
      SUBDIR_DIAGRAMS,
      SUBDIR_TESTS,
      SUBDIR_REVIEW,
      SUBDIR_TRACES,
    ]) {
      mkdirSync(join(this.outputDir, subdir), { recursive: true });
    }
    this._logger = setupLogger("reqdesign.output");
    this._logger.info(`输出目录: ${this.outputDir}`);
  }

  // ---------------------------------------------------------------
  // Resolve paths
  // ---------------------------------------------------------------

  private _resolvePath(subdir: string, filename: string): string {
    const safeName = sanitizeFilename(filename);
    const dirPath = join(this.outputDir, subdir);
    const filePath = join(dirPath, safeName);
    const realPath = resolve(filePath);
    const realDir = resolve(dirPath);
    const rel = relative(realDir, realPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`不安全的文件名: ${filename}`);
    }
    return filePath;
  }

  // ---------------------------------------------------------------
  // Write helpers
  // ---------------------------------------------------------------

  private _writeFile(filename: string, content: string, subdir = ""): void {
    const targetDir = subdir || ".";
    const filePath = this._resolvePath(targetDir, filename);
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, { encoding: "utf8" });
      this._logger.debug(`已写入: ${filePath}`);
    } catch (e) {
      this._logger.error(`写入文件失败 ${filePath}: ${e}`);
      throw e;
    }
  }

  private _writeJson(
    filename: string,
    data: Record<string, unknown>,
    subdir = "",
  ): void {
    const filePath = this._resolvePath(subdir, filename);
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(data, null, 2), { encoding: "utf8" });
      this._logger.debug(`已写入: ${filePath}`);
    } catch (e) {
      this._logger.error(`写入JSON失败 ${filePath}: ${e}`);
      throw e;
    }
  }

  // ---------------------------------------------------------------
  // Save methods
  // ---------------------------------------------------------------

  /** Save requirement analysis results → requirement/ */
  saveRequirementAnalysis(
    requirementJson: Record<string, unknown>,
    _requirementText = "",
  ): void {
    const json = requirementJson || {};
    this._writeJson("analysis.json", json, SUBDIR_REQUIREMENT);

    const md = this._generateRequirementMd(json);
    this._writeFile("analysis.md", md, SUBDIR_REQUIREMENT);
    this._logger.info(`需求分析结果已保存 → ${SUBDIR_REQUIREMENT}/`);
  }

  /** Save system design → design/ */
  saveSystemDesign(designText: string): void {
    this._writeFile("system_design.md", designText || "", SUBDIR_DESIGN);
    this._logger.info(`系统设计已保存 → ${SUBDIR_DESIGN}/`);
  }

  /** Save Mermaid diagrams → diagrams/ */
  saveDiagrams(diagrams: Record<string, unknown>): void {
    const diagramsObj = diagrams || {};
    let saved = 0;
    for (const [name, content] of Object.entries(diagramsObj)) {
      if (content && String(content).trim()) {
        this._writeFile(`${name}.mmd`, String(content), SUBDIR_DIAGRAMS);
        saved++;
      }
    }
    this._logger.info(
      `已保存 ${saved}/${Object.keys(diagramsObj).length} 个图表 → ${SUBDIR_DIAGRAMS}/`,
    );
  }

  /** Save test cases → tests/ */
  saveTestCases(testCases: string): void {
    this._writeFile("test_cases.md", testCases || "", SUBDIR_TESTS);
    this._logger.info(`测试用例已保存 → ${SUBDIR_TESTS}/`);
  }

  /** Save a per-task artifact to by_task/<taskId>/ subdirectory. */
  saveArtifactByTask(
    taskId: string,
    taskType: string,
    content: unknown,
  ): void {
    const safeTaskId = taskId.replace(/[/\\]/g, "_");
    const taskDir = `by_task/${safeTaskId}`;
    mkdirSync(join(this.outputDir, taskDir), { recursive: true });

    if (taskType === "analyze" && typeof content === "object" && content !== null) {
      this._writeJson("analysis.json", content as Record<string, unknown>, taskDir);
    } else if (taskType === "design" && typeof content === "string") {
      this._writeFile("system_design.md", content, taskDir);
    } else if (taskType === "diagrams" && typeof content === "object" && content !== null) {
      const diagramsObj = content as Record<string, unknown>;
      for (const [name, mmdContent] of Object.entries(diagramsObj)) {
        if (mmdContent && String(mmdContent).trim()) {
          this._writeFile(`${name}.mmd`, String(mmdContent), taskDir);
        }
      }
    } else if (taskType === "tests" && typeof content === "string") {
      this._writeFile("test_cases.md", content, taskDir);
    }
    this._logger.info(`per-task save: ${taskId} → ${taskDir}/`);
  }

  /** Save review report → review/ */
  saveReviewReport(
    reviewReport: string,
    reviewResult: Record<string, unknown> | null = null,
  ): void {
    this._writeFile("report.md", reviewReport || "", SUBDIR_REVIEW);
    if (reviewResult) {
      this._writeJson("result.json", reviewResult, SUBDIR_REVIEW);
    }
    this._logger.info(`审查报告已保存 → ${SUBDIR_REVIEW}/`);
  }

  /** Save trace file → traces/ */
  saveTrace(filename: string, content: string): void {
    this._writeFile(filename, content, SUBDIR_TRACES);
    this._logger.info(`追踪文件已保存 → ${SUBDIR_TRACES}/${filename}`);
  }

  /** Save trace JSON → traces/ */
  saveTraceJson(filename: string, data: Record<string, unknown>): void {
    this._writeJson(filename, data, SUBDIR_TRACES);
    this._logger.info(`追踪文件已保存 → ${SUBDIR_TRACES}/${filename}`);
  }

  /** Save all artifacts in one call. */
  saveAll(
    requirementJson: Record<string, unknown>,
    requirementText: string,
    designText: string,
    diagrams: Record<string, unknown>,
    testCases: string,
    reviewResult: Record<string, unknown> | null = null,
  ): void {
    this.saveRequirementAnalysis(requirementJson, requirementText);
    if (designText) {
      this.saveSystemDesign(designText);
    }
    if (diagrams && Object.keys(diagrams).length > 0) {
      this.saveDiagrams(diagrams);
    }
    if (testCases) {
      this.saveTestCases(testCases);
    }
    if (reviewResult) {
      this._writeJson("result.json", reviewResult, SUBDIR_REVIEW);
    }
    this._generateSummary(requirementJson, reviewResult);
    this._logger.info(`所有产物已保存到: ${this.outputDir}`);
  }

  // ---------------------------------------------------------------
  // SVG rendering (optional — skipped)
  // ---------------------------------------------------------------

  /**
   * Try to render SVGs using mmdc CLI.
   * Skipped in TypeScript port — use an external Mermaid renderer.
   * @returns 0 (no SVGs rendered).
   */
  _tryRenderSvg(_diagrams: Record<string, unknown>): number {
    // Skip mmdc SVG rendering — optional feature.
    // If needed, use child_process.spawn with mmdc.
    return 0;
  }

  // ---------------------------------------------------------------
  // Markdown generation
  // ---------------------------------------------------------------

  private _generateRequirementMd(req: Record<string, unknown>): string {
    const lines: string[] = ["# 需求分析说明\n"];

    if (req["project_name"]) {
      lines.push(`## 项目名称\n${req["project_name"]}\n`);
    }
    if (req["project_overview"]) {
      lines.push(`## 项目概述\n${req["project_overview"]}\n`);
    }

    // Actors
    const actors = req["actors"];
    if (Array.isArray(actors) && actors.length > 0) {
      lines.push("## 角色\n");
      lines.push("| 角色名称 | 描述 |");
      lines.push("|----------|------|");
      for (const a of actors) {
        if (typeof a === "object" && a !== null) {
          const obj = a as Record<string, unknown>;
          lines.push(
            `| ${escapeMdCell(obj["name"])} | ${escapeMdCell(obj["description"])} |`,
          );
        } else {
          lines.push(`| ${escapeMdCell(String(a))} | |`);
        }
      }
      lines.push("");
    }

    // Functions
    const functions = req["functions"];
    if (Array.isArray(functions) && functions.length > 0) {
      lines.push("## 功能需求\n");
      lines.push("| 编号 | 名称 | 描述 | 相关角色 | 优先级 |");
      lines.push("|------|------|------|----------|--------|");
      for (const f of functions) {
        if (typeof f === "object" && f !== null) {
          const obj = f as Record<string, unknown>;
          const actorsStr = escapeMdCell(
            Array.isArray(obj["related_actors"])
              ? obj["related_actors"].map(String).join(", ")
              : "",
          );
          lines.push(
            `| ${escapeMdCell(obj["id"])} | ${escapeMdCell(obj["name"])} | ${escapeMdCell(obj["description"])} | ${actorsStr} | ${escapeMdCell(obj["priority"])} |`,
          );
        }
      }
      lines.push("");
    }

    // Entities
    const entities = req["entities"];
    if (Array.isArray(entities) && entities.length > 0) {
      lines.push("## 核心实体\n");
      for (const e of entities) {
        if (typeof e === "object" && e !== null) {
          const obj = e as Record<string, unknown>;
          const attrs = escapeMdCell(
            Array.isArray(obj["attributes"])
              ? obj["attributes"].map(String).join(", ")
              : "",
          );
          lines.push(
            `### ${escapeMdCell(obj["name"])}\n${escapeMdCell(obj["description"])}\n属性: ${attrs}\n`,
          );
        }
      }
    }

    // Constraints
    const constraints = req["constraints"];
    if (Array.isArray(constraints) && constraints.length > 0) {
      lines.push("## 业务约束\n");
      for (const c of constraints) {
        if (typeof c === "object" && c !== null) {
          const obj = c as Record<string, unknown>;
          lines.push(
            `- **${escapeMdCell(obj["id"])}**: ${escapeMdCell(obj["description"])}`,
          );
        } else {
          lines.push(`- ${escapeMdCell(String(c))}`);
        }
      }
      lines.push("");
    }

    // Exceptions
    const exceptions = req["exceptions"];
    if (Array.isArray(exceptions) && exceptions.length > 0) {
      lines.push("## 异常流程\n");
      for (const e of exceptions) {
        if (typeof e === "object" && e !== null) {
          const obj = e as Record<string, unknown>;
          lines.push(
            `- **${escapeMdCell(obj["id"])}**: ${escapeMdCell(obj["description"])} ` +
              `(触发: ${escapeMdCell(obj["trigger"])}, 处理: ${escapeMdCell(obj["handling"])})`,
          );
        } else {
          lines.push(`- ${escapeMdCell(String(e))}`);
        }
      }
      lines.push("");
    }

    // Non-functional requirements
    const nfr = req["non_functional_requirements"];
    if (Array.isArray(nfr) && nfr.length > 0) {
      lines.push("## 非功能需求\n");
      for (const n of nfr) {
        if (typeof n === "object" && n !== null) {
          const obj = n as Record<string, unknown>;
          lines.push(
            `- **${escapeMdCell(obj["category"])}**: ${escapeMdCell(obj["description"])}`,
          );
        } else {
          lines.push(`- ${escapeMdCell(String(n))}`);
        }
      }
      lines.push("");
    }

    // Business processes
    const processes = req["business_processes"];
    if (Array.isArray(processes) && processes.length > 0) {
      lines.push("## 业务流程\n");
      for (const p of processes) {
        if (typeof p === "object" && p !== null) {
          const obj = p as Record<string, unknown>;
          lines.push(`### ${escapeMdCell(obj["name"])}\n`);
          lines.push(
            `参与角色: ${escapeMdCell(
              Array.isArray(obj["actors"])
                ? obj["actors"].map(String).join(", ")
                : "",
            )}\n`,
          );
          const steps = obj["steps"];
          if (Array.isArray(steps)) {
            steps.forEach((step: unknown, i: number) => {
              lines.push(`${i + 1}. ${escapeMdCell(String(step))}`);
            });
          }
        } else {
          lines.push(`- ${escapeMdCell(String(p))}`);
        }
        lines.push("");
      }
    }

    return lines.join("\n");
  }

  private _generateSummary(
    req: Record<string, unknown>,
    reviewResult: Record<string, unknown> | null,
  ): void {
    const lines: string[] = ["# 设计任务汇总报告\n"];

    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    lines.push(`生成时间: ${now}\n`);

    lines.push("## 需求统计\n");
    lines.push(`- 角色数: ${Array.isArray(req["actors"]) ? req["actors"].length : 0}`);
    lines.push(`- 功能数: ${Array.isArray(req["functions"]) ? req["functions"].length : 0}`);
    lines.push(`- 实体数: ${Array.isArray(req["entities"]) ? req["entities"].length : 0}`);
    lines.push(`- 约束数: ${Array.isArray(req["constraints"]) ? req["constraints"].length : 0}`);
    lines.push(
      `- 异常流程数: ${Array.isArray(req["exceptions"]) ? req["exceptions"].length : 0}`,
    );
    lines.push("");

    if (reviewResult) {
      const score = reviewResult["overall_score"];
      const passed =
        reviewResult["overall_pass"] ?? reviewResult["passed"] ?? false;
      const issues = (reviewResult["issues"] as unknown[]) ?? [];
      const severityCounts: Record<string, number> = {
        blocker: 0,
        major: 0,
        minor: 0,
      };

      for (const issue of issues) {
        if (typeof issue === "object" && issue !== null) {
          const sev = String(
            (issue as Record<string, unknown>)["severity"] ?? "",
          ).trim();
          if (sev in severityCounts) {
            severityCounts[sev]++;
          }
        }
      }

      lines.push("## 审查结果\n");
      lines.push(`- 综合得分: ${score != null ? score : "未提供"}`);
      lines.push(`- 审查通过: ${passed ? "是" : "否"}`);
      lines.push(`- 问题总数: ${issues.length}`);
      lines.push(
        `- 问题分布: blocker=${severityCounts["blocker"]}, major=${severityCounts["major"]}, minor=${severityCounts["minor"]}`,
      );

      const checks = reviewResult["checks"];
      if (Array.isArray(checks) && checks.length > 0) {
        lines.push("\n### 各维度得分\n");
        for (const c of checks) {
          if (typeof c === "object" && c !== null) {
            const obj = c as Record<string, unknown>;
            lines.push(`- ${obj["dimension"] ?? ""}: ${obj["score"] ?? 0}`);
          }
        }
      }
      lines.push("");
    }

    lines.push("## 输出目录结构\n");
    lines.push("```\n");
    lines.push(`${basename(this.outputDir)}/\n`);
    const subdirs: [string, string][] = [
      [SUBDIR_REQUIREMENT, "需求分析"],
      [SUBDIR_DESIGN, "系统设计"],
      [SUBDIR_DIAGRAMS, "图表"],
      [SUBDIR_TESTS, "测试用例"],
      [SUBDIR_REVIEW, "审查报告"],
      [SUBDIR_TRACES, "执行追踪"],
    ];
    for (const [subdir, label] of subdirs) {
      const dirPath = join(this.outputDir, subdir);
      if (existsSync(dirPath)) {
        const files = readdirSync(dirPath).filter((f) =>
          statSync(join(dirPath, f)).isFile(),
        );
        if (files.length > 0) {
          lines.push(`├── ${subdir}/  # ${label}\n`);
          for (const f of files.sort()) {
            const size = statSync(join(dirPath, f)).size;
            lines.push(`│   ├── ${f}  (${size} bytes)\n`);
          }
        }
      }
    }
    lines.push("└── summary_report.md\n");
    lines.push("```\n");

    this._writeFile("summary_report.md", lines.join("\n"));
    this._logger.info("汇总报告已保存 → summary_report.md");
  }
}
