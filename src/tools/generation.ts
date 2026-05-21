/**
 * GenerationTool — receives Task → produces Artifact with rule self-check.
 * Routes to appropriate generators by task.type.
 */

import { performance } from "node:perf_hooks";
import type { LLMClient } from "../llmClient.js";
import { BaseTool } from "./base.js";
import type { ToolCapabilities } from "./types.js";
import { createToolError } from "./types.js";
import { type Task, type Artifact, createArtifact } from "../shared/types.js";
import { RequirementAnalyzer } from "../generators/analyze.js";
import { SystemDesigner } from "../generators/design.js";
import { DiagramGenerator } from "../generators/diagrams.js";
import { TestCaseGenerator } from "../generators/tests.js";
import {
  requiresRefundFlow,
  hasConstraint,
  missingConcepts,
  REFUND_FLOW_CONCEPTS,
  REFUND_TEST_CONCEPTS,
} from "../shared/requirementChecks.js";

export class GenerationTool extends BaseTool {
  private _analyzer: RequirementAnalyzer | null = null;
  private _designer: SystemDesigner | null = null;
  private _diagramGen: DiagramGenerator | null = null;
  private _testGen: TestCaseGenerator | null = null;

  constructor(llm: LLMClient) {
    super(llm);
  }

  get name(): string { return "GenerationTool"; }

  get capabilities(): ToolCapabilities {
    return { requiresLlm: true, supportedTaskTypes: ["analyze", "design", "diagrams", "tests"] };
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  async execute(task: Task, context: Record<string, unknown>): Promise<Artifact> {
    const t0 = performance.now();
    this.logger.info(`execute: 开始生成 task=${task.id}, type=${task.type}, desc=${task.description?.slice(0, 60)}`);

    try {
      let content = await this._generate(task, context);
      if (content === null || content === undefined) {
        throw createToolError("GEN_EMPTY", `生成 ${task.type} 返回空结果`, { recoverable: true });
      }


      let issues = GenerationTool._ruleCheck(task, content, context);
      let selfCorrectRounds = 0;
      // Self-check issues are recorded but NOT auto-repaired.
      // Self-repair had 100% failure rate (6/6 in test runs) — wastes LLM calls.
      // Downstream evaluator handles these issues.
      const elapsed = (performance.now() - t0) / 1000;
      const passed = issues.length === 0;

      if (passed) {
        this.logger.info(`execute: task=${task.id} 生成完成，耗时=${elapsed.toFixed(1)}s，自检通过`);
      } else {
        this.logger.warn(`execute: task=${task.id} 生成完成，耗时=${elapsed.toFixed(1)}s，自检发现 ${issues.length} 个问题`);
      }

      return createArtifact({
        taskId: task.id,
        type: task.type,
        revision: 1,
        content,
        selfCheckPassed: passed,
        selfCheckIssues: issues,
        selfCorrectRounds,
        generationDuration: elapsed,
      });
    } catch (e: unknown) {
      const elapsed = (performance.now() - t0) / 1000;
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`execute: task=${task.id} 生成异常，耗时=${elapsed.toFixed(1)}s: ${msg}`);
      return createArtifact({
        taskId: task.id,
        type: task.type,
        content: null,
        selfCheckPassed: false,
        selfCheckIssues: [`生成异常: ${msg}`],
        generationDuration: elapsed,
      });
    }
  }

  // ------------------------------------------------------------------
  // Generation routing
  // ------------------------------------------------------------------

  private async _generate(task: Task, context: Record<string, unknown>): Promise<unknown> {
    const hints = (task.contextHints ?? {}) as Record<string, unknown>;
    const desc = task.description ?? "";
    const queryCtx = `${task.type}: ${desc.slice(0, 200)}`;
    const injectedPrompt = await this._getSystemPrompt("generator.md", "", queryCtx);

    switch (task.type) {
      case "analyze":
        return await this._generateAnalyze(context, hints, desc, injectedPrompt);
      case "design":
        return await this._generateDesign(context, hints, desc, injectedPrompt);
      case "diagrams":
        return await this._generateDiagrams(task, context, hints, desc, injectedPrompt);
      case "tests":
        return await this._generateTests(context, hints, desc, injectedPrompt);
      default:
        throw createToolError("GEN_UNKNOWN_TYPE", `未知任务类型: ${task.type}`, { recoverable: false });
    }
  }

  private async _generateAnalyze(
    ctx: Record<string, unknown>, hints: Record<string, unknown>,
    desc: string, systemPrompt: string,
  ): Promise<Record<string, unknown>> {
    let text = (ctx.requirement_text as string) ?? "";
    const existingJson = ctx.requirement_json as Record<string, unknown> | undefined;
    if (!text && !existingJson) throw createToolError("GEN_MISSING_INPUT", "缺少 requirement_text 和 requirement_json", { recoverable: false });

    if (hints.focus_areas) {
      const focus = (hints.focus_areas as string[]).join(", ");
      text = `[重点关注: ${focus}]\n\n${text}`;
    }
    if (hints.note) text = `[补充说明: ${hints.note}]\n\n${text}`;
    if (desc) text = `[任务要求: ${desc}]\n\n${text}`;

    if (this.llm) this.llm.streamTag = "[Generator:analyze]";
    const analyzer = this._getAnalyzer();
    const raw = await analyzer.analyze(text, 3, systemPrompt, existingJson);
    return GenerationTool._unwrapAnalyzeDict(raw);
  }

  private async _generateDesign(
    ctx: Record<string, unknown>, hints: Record<string, unknown>,
    desc: string, systemPrompt: string,
  ): Promise<string> {
    const reqJson = ctx.requirement_json as Record<string, unknown> | undefined;
    if (!reqJson) throw createToolError("GEN_MISSING_REQJSON", "缺少 requirement_json", { recoverable: false });

    if (this.llm) this.llm.streamTag = "[Generator:design]";
    const requirementText = GenerationTool._augmentRequirementTextForTask(
      (ctx.requirement_text as string) ?? "",
      desc,
      hints,
    );
    return this._getDesigner().generateDesign(reqJson, requirementText, systemPrompt);
  }

  private async _generateDiagrams(
    task: Task,
    ctx: Record<string, unknown>, hints: Record<string, unknown>,
    desc: string, systemPrompt: string,
  ): Promise<Record<string, string>> {
    const reqJson = (ctx.requirement_json ?? {}) as Record<string, unknown>;
    const designText = (ctx.design_text as string) ?? "";
    const reqText = (ctx.requirement_text as string) ?? "";
    const diagramKind = GenerationTool._diagramKindForTask(task, hints, desc);

    if (this.llm) this.llm.streamTag = "[Generator:diagrams]";
    const generator = this._getDiagramGen();

    if (diagramKind) {
      const methodMap: Record<string, () => Promise<string>> = {
        class_diagram: () => generator.generateClassDiagram(reqJson, designText, systemPrompt, reqText),
        activity_diagram: () => generator.generateActivityDiagram(reqJson, designText, systemPrompt, reqText),
        state_diagram: () => generator.generateStateDiagram(reqJson, designText, systemPrompt, reqText),
      };
      const method = methodMap[diagramKind];
      if (!method) throw createToolError("GEN_UNKNOWN_DIAGRAM", `未知图表类型: ${diagramKind}`, { recoverable: false });
      const result = await method();
      return { [diagramKind]: result };
    }
    return generator.generateAll(reqJson, designText, systemPrompt, reqText);
  }

  private async _generateTests(
    ctx: Record<string, unknown>, _hints: Record<string, unknown>,
    _desc: string, systemPrompt: string,
  ): Promise<string> {
    const reqJson = (ctx.requirement_json ?? {}) as Record<string, unknown>;
    const designText = (ctx.design_text as string) ?? "";
    const reqText = (ctx.requirement_text as string) ?? "";

    if (this.llm) this.llm.streamTag = "[Generator:tests]";
    return this._getTestGen().generate(reqJson, designText, systemPrompt, reqText);
  }

  // ------------------------------------------------------------------
  // Rule self-check (zero LLM cost)
  // ------------------------------------------------------------------

  static _ruleCheck(task: Task, content: unknown, context: Record<string, unknown>): string[] {
    const issues: string[] = [];
    const taskType = task.type;
    const hints = (task.contextHints ?? {}) as Record<string, unknown>;

    if (content === null || content === undefined) return ["产物为空"];

    if (taskType === "analyze") {
      if (typeof content !== "object" || content === null || Array.isArray(content))
        return ["需求分析结果格式错误（非 dict）"];
      const c = content as Record<string, unknown>;
      if (!c.actors) issues.push("缺少 actors 字段");
      if (!c.functions) issues.push("缺少 functions 字段");
      if (!c.entities) issues.push("缺少 entities 字段");
      issues.push(...RequirementAnalyzer.validateResult(c));
    }
    else if (taskType === "design") {
      if (typeof content !== "string" || !content.trim())
        return ["设计文档为空"];
      const reqJson = (context.requirement_json ?? {}) as Record<string, unknown>;
      issues.push(...SystemDesigner.validateDesign(String(content), reqJson));
      issues.push(...GenerationTool._checkUndefinedExceptionIds(String(content), reqJson, "设计"));
    }
    else if (taskType === "diagrams") {
      if (typeof content !== "object" || content === null || Array.isArray(content))
        return ["图表结果格式错误（非 dict）"];
      const c = content as Record<string, string>;
      const diagramKind = GenerationTool._diagramKindForTask(task, hints, task.description);
      const required = diagramKind ? [diagramKind] : ["class_diagram", "activity_diagram", "state_diagram"];
      for (const key of required) {
        const val = c[key] ?? "";
        if (!val || !String(val).trim()) {
          issues.push(`缺少 ${key}`);
        } else {
          const text = String(val).trim();
          const firstLine = text.split("\n", 1)[0].trim();
          const headers: Record<string, string[]> = {
            class_diagram: ["classDiagram"],
            activity_diagram: ["flowchart", "graph"],
            state_diagram: ["stateDiagram-v2", "stateDiagram"],
          };
          const expected = headers[key] ?? [];
          if (!expected.some((h) => firstLine.includes(h))) {
            issues.push(`${key} 缺少正确的 Mermaid 头部，当前第一行: ${firstLine.slice(0, 60)}`);
          }
          if (/<br\s*\/?>/i.test(text)) {
            issues.push(`${key} 包含 HTML 换行标签 <br/>，请改用纯文本标签以提升 Mermaid 兼容性`);
          }
          if (key === "class_diagram") {
            const openClasses = (text.match(/class\s+(\w+)\s*\{/g) ?? []).length;
            const closeBraces = (text.match(/^\s*\}/gm) ?? []).length;
            if (openClasses > closeBraces) {
              issues.push(`classDiagram 有 ${openClasses} 个类定义但只有 ${closeBraces} 个闭合括号，输出可能被截断`);
            }
          }
          if (key === "state_diagram" && /Coupon|优惠券/.test(text) && /C002|支付超时/.test(text)) {
            issues.push("stateDiagram 中优惠券状态不能使用 C002/支付超时作为过期触发条件，应使用有效期结束");
          }
          const reqJson = (context.requirement_json ?? {}) as Record<string, unknown>;
          issues.push(...GenerationTool._checkUndefinedExceptionIds(text, reqJson, key));
          if (key === "activity_diagram") {
            issues.push(...GenerationTool._checkActivityCoverage(text, reqJson));
          }
        }
      }
    }
    else if (taskType === "tests") {
      if (typeof content !== "string" || !content.trim())
        return ["测试用例为空"];
      try {
        const reqJson = (context.requirement_json ?? {}) as Record<string, unknown>;
        const tcIssues = TestCaseGenerator.validateTestCases(content, reqJson);
        issues.push(...tcIssues);
        issues.push(...GenerationTool._checkUndefinedExceptionIds(content, reqJson, "测试用例"));
        issues.push(...GenerationTool._checkRefundTestCoverage(content, reqJson));
      } catch (e) {
        issues.push(`测试用例规则校验失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return issues;
  }

  private static _diagramKindForTask(
    task: Task,
    hints: Record<string, unknown>,
    description = "",
  ): string {
    const explicit = String(hints.diagram_kind ?? "").trim();
    if (["class_diagram", "activity_diagram", "state_diagram"].includes(explicit)) {
      return explicit;
    }

    const text = `${task.id} ${description}`.toLowerCase();
    if (text.includes("class") || text.includes("类图")) return "class_diagram";
    if (text.includes("activity") || text.includes("活动图")) return "activity_diagram";
    if (text.includes("state") || text.includes("状态图")) return "state_diagram";
    return "";
  }

  private static _checkUndefinedExceptionIds(
    text: string,
    requirementJson: Record<string, unknown>,
    label: string,
  ): string[] {
    const defined = new Set(
      ((requirementJson.exceptions ?? []) as Array<Record<string, unknown>>)
        .map((item) => String(item.id ?? "").trim())
        .filter(Boolean),
    );
    if (defined.size === 0) return [];
    const referenced = new Set(text.match(/\b[EX]\d{3}\b/g) ?? []);
    const unknown = [...referenced].filter((id) => !defined.has(id)).sort();
    return unknown.length > 0
      ? [`${label} 引用了未定义的异常 ID: ${unknown.join(", ")}`]
      : [];
  }

  private static _checkActivityCoverage(
    text: string,
    requirementJson: Record<string, unknown>,
  ): string[] {
    const issues: string[] = [];
    if (requiresRefundFlow(requirementJson)) {
      const missing = missingConcepts(text, REFUND_FLOW_CONCEPTS);
      if (missing.length > 0) {
        issues.push(`activity_diagram 未完整覆盖退货退款流程，缺少: ${missing.join(", ")}`);
      }
    }

    if (hasConstraint(requirementJson, "C001")) {
      const missing = missingConcepts(text, [
        ["订单总数量<=99", /(总数量|商品数量|件数).*(99|上限)|(99).*(件|数量)/],
        ["订单金额<=99999", /(金额|实付|总价).*(99999|上限)|(99999).*(元|金额)/],
        ["单商品数量<=10", /(单商品|同一商品|单个商品|限购).*(10|上限)|(10).*(件|限购)/],
        ["地址配送范围", /(地址|收货地址).*(配送范围|可配送)|(配送范围).*(地址|校验)/],
      ]);
      if (missing.length > 0) {
        issues.push(`activity_diagram 未完整覆盖 C001 订单约束校验，缺少: ${missing.join(", ")}`);
      }
    }
    return issues;
  }

  private static _checkRefundTestCoverage(
    text: string,
    requirementJson: Record<string, unknown>,
  ): string[] {
    if (!requiresRefundFlow(requirementJson)) return [];
    const missing = missingConcepts(text, REFUND_TEST_CONCEPTS);
    return missing.length > 0
      ? [`测试用例未覆盖完整退货退款正常流程，缺少: ${missing.join(", ")}`]
      : [];
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  static _unwrapAnalyzeDict(result: Record<string, unknown>): Record<string, unknown> {
    const content = result.content;
    if (typeof content === "object" && content !== null && !Array.isArray(content)) {
      const c = content as Record<string, unknown>;
      if (c.actors || c.functions || c.entities) return c;
    }
    return result;
  }

  static _unwrapJsonContent(raw: unknown): unknown {
    if (typeof raw !== "string" || !raw.trim()) return raw;
    let text = raw.trim();
    if (text.startsWith("```")) {
      const firstNewline = text.indexOf("\n");
      const lastFence = text.lastIndexOf("```");
      if (firstNewline >= 0 && lastFence > firstNewline) {
        text = text.slice(firstNewline + 1, lastFence).trim();
      }
    }
    if (text.startsWith("{") && text.includes('"content"')) {
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null && "content" in parsed) {
          return parsed.content;
        }
      } catch { /* fall through */ }
    }
    return raw;
  }

  private static _augmentRequirementTextForTask(
    requirementText: string,
    description: string,
    hints: Record<string, unknown>,
  ): string {
    const sections: string[] = [];
    if (description.trim()) {
      sections.push(`## 当前生成任务\n${description.trim()}`);
    }

    const focusAreas = Array.isArray(hints.focus_areas)
      ? hints.focus_areas.map((item) => String(item)).filter(Boolean)
      : [];
    if (focusAreas.length > 0) {
      sections.push(`## 重点覆盖范围\n${focusAreas.join(", ")}`);
    }

    const note = typeof hints.note === "string" ? hints.note.trim() : "";
    if (note) {
      sections.push(`## 任务补充说明\n${note}`);
    }

    const fixInstructions = Array.isArray(hints.fix_instructions)
      ? hints.fix_instructions
        .filter((item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
        )
        .slice(0, 20)
      : [];
    if (fixInstructions.length > 0) {
      sections.push(
        "## 必须处理的评审问题\n" +
        fixInstructions.map((item, index) => {
          const severity = String(item.severity ?? "");
          const field = String(item.target_field ?? "");
          const desc = String(item.description ?? "");
          const suggestion = String(item.suggestion ?? "");
          return `${index + 1}. [${severity}] ${field}: ${desc}${suggestion ? `；建议：${suggestion}` : ""}`;
        }).join("\n"),
      );
    }

    if (sections.length === 0) return requirementText;
    return `${sections.join("\n\n")}\n\n## 原始需求\n${requirementText}`;
  }

  private _getAnalyzer(): RequirementAnalyzer {
    if (!this._analyzer) this._analyzer = new RequirementAnalyzer(this.llm);
    return this._analyzer;
  }

  private _getDesigner(): SystemDesigner {
    if (!this._designer) this._designer = new SystemDesigner(this.llm);
    return this._designer;
  }

  private _getDiagramGen(): DiagramGenerator {
    if (!this._diagramGen) this._diagramGen = new DiagramGenerator(this.llm);
    return this._diagramGen;
  }

  private _getTestGen(): TestCaseGenerator {
    if (!this._testGen) this._testGen = new TestCaseGenerator(this.llm);
    return this._testGen;
  }
}
