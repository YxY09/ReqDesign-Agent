/**
 * GenerationTool — 接收 Task → 生成带有规则自检的 Artifact。
 * 根据 task.type 将任务路由到相应的生成器。
 */

import { performance } from "node:perf_hooks";
import type { LLMClient } from "../llmClient.js";
import { BaseTool } from "./base.js";
import type { ToolCapabilities } from "./types.js";
import { createToolError } from "./types.js";
import { type Task, type Artifact, createArtifact } from "../shared/types.js";
import { buildRegistrySummary } from "../shared/registrySummary.js";
import type { EntityRegistry } from "../shared/types.js";
import { RequirementAnalyzer } from "../generators/analyze.js";
import { SystemDesigner } from "../generators/design.js";
import { DiagramGenerator } from "../generators/diagrams.js";
import { TestCaseGenerator } from "../generators/tests.js";
import { RequirementIndex } from "../shared/requirementIndex.js";

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
  // 公开 API
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
      // 自检问题被记录但不会自动修复。
      // 自修复在测试中 100% 失败（6/6），会浪费 LLM 调用。
      // 下游 evaluator 会处理这些问题。
      const elapsed = (performance.now() - t0) / 1000;
      const passed = issues.length === 0;

      // Schema guard: if ruleCheck found critical structural issues (returned array
      // from ruleCheck, not empty), ensure content is at least not null/undefined
      // so downstream won't crash on missing fields.
      if (!passed && content !== null && content !== undefined) {
        content = GenerationTool._patchMissingFields(task, content, issues);
      }

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
  // 生成路由
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
    _desc: string, systemPrompt: string,
  ): Promise<Record<string, unknown>> {
    let text = (ctx.requirement_text as string) ?? "";
    const existingJson = ctx.requirement_json as Record<string, unknown> | undefined;
    if (!text && !existingJson) throw createToolError("GEN_MISSING_INPUT", "缺少 requirement_text 和 requirement_json", { recoverable: false });

    // Inject registry summary if available in context hints
    const registry = ctx.registry as EntityRegistry | undefined;
    if (registry && registry.entities.length > 0) {
      const summary = buildRegistrySummary(registry);
      if (summary) {
        text = text.replace(/\{registry_summary\}/g, summary);
        // If placeholder wasn't in text, prepend it
        if (!text.includes(summary)) {
          text = `## 全局实体注册表\n${summary}\n\n${text}`;
        }
      }
    }

    // Inject available constraints into prompt template
    let availableConstraintsText: string | undefined;
    const availConstraints = hints.availableConstraints as
      Array<{ constraintRef?: string; description?: string; sourceText?: string }> | undefined;
    if (Array.isArray(availConstraints) && availConstraints.length > 0) {
      availableConstraintsText = availConstraints
        .map((c) => `- ${c.constraintRef ?? "C_RULE_???"}: ${c.description ?? ""} (${c.sourceText ?? ""})`)
        .join("\n");
    } else {
      availableConstraintsText = "（系统尚未预提取约束，请自行提取并编号）";
    }

    if (Array.isArray(hints.focus_areas) && hints.focus_areas.length > 0) {
      const focus = hints.focus_areas.map(String).join(", ");
      text = `[重点关注: ${focus}]\\n\\n${text}`;
    }
    if (hints.note) text = `[补充说明: ${hints.note}]\n\n${text}`;
    if (Array.isArray(hints.suggested_entities) && hints.suggested_entities.length > 0) {
      const entities = hints.suggested_entities.map(String).join(", ");
      text = `[必须提取的实体（以下每个概念都必须作为独立实体出现在输出中，不得遗漏或合并）: ${entities}]\\n

${text}`;
    }
    if (Array.isArray(hints.suggested_functions) && hints.suggested_functions.length > 0) {
      const funcs = hints.suggested_functions.map(String).join(", ");
      text = `[必须提取的功能（以下每个功能都必须作为独立功能项出现在输出中）: ${funcs}]\\n

${text}`;
    }
    const analyzer = this._getAnalyzer();
    if (this.llm) this.llm.streamTag = "[Generator:analyze]";
    const raw = await analyzer.analyze(text, 3, systemPrompt, existingJson, availableConstraintsText);
    return GenerationTool._unwrapAnalyzeDict(raw);
  }

  private async _generateDesign(
    ctx: Record<string, unknown>, _hints: Record<string, unknown>,
    _desc: string, systemPrompt: string,
  ): Promise<string> {
    const reqJson = ctx.requirement_json as Record<string, unknown> | undefined;
    if (!reqJson) throw createToolError("GEN_MISSING_REQJSON", "缺少 requirement_json", { recoverable: false });

    if (this.llm) this.llm.streamTag = "[Generator:design]";
    return this._getDesigner().generateDesign(reqJson, systemPrompt);
  }

  private async _generateDiagrams(
    task: Task,
    ctx: Record<string, unknown>, hints: Record<string, unknown>,
    desc: string, systemPrompt: string,
  ): Promise<Record<string, string>> {
    const reqJson = (ctx.requirement_json ?? {}) as Record<string, unknown>;
    const designText = (ctx.design_text as string) ?? "";
    const diagramKind = GenerationTool._diagramKindForTask(task, hints, desc);

    if (this.llm) this.llm.streamTag = "[Generator:diagrams]";
    const generator = this._getDiagramGen();

    if (diagramKind) {
      const methodMap: Record<string, () => Promise<string>> = {
        class_diagram: () => generator.generateClassDiagram(reqJson, designText, systemPrompt, ""),
        activity_diagram: () => generator.generateActivityDiagram(reqJson, designText, systemPrompt, ""),
        state_diagram: () => generator.generateStateDiagram(reqJson, designText, systemPrompt, ""),
      };
      const method = methodMap[diagramKind];
      if (!method) throw createToolError("GEN_UNKNOWN_DIAGRAM", `未知图表类型: ${diagramKind}`, { recoverable: false });
      const result = await method();
      return { [diagramKind]: result };
    }
    return generator.generateAll(reqJson, designText, systemPrompt, "");
  }

  private async _generateTests(
    ctx: Record<string, unknown>, _hints: Record<string, unknown>,
    _desc: string, systemPrompt: string,
  ): Promise<string> {
    const reqJson = (ctx.requirement_json ?? {}) as Record<string, unknown>;
    const designText = (ctx.design_text as string) ?? "";
    if (this.llm) this.llm.streamTag = "[Generator:tests]";
    return this._getTestGen().generate({ requirementJson: reqJson, designText, systemPrompt, requirementText: "" });
  }

  // ------------------------------------------------------------------
  // 规则自检（零 LLM 成本）
  // ------------------------------------------------------------------

  /**
   * Patch missing expected fields in structured content (analyze type) so
   * downstream consumers don't crash on missing properties even when
   * ruleCheck flags issues.
   */
  static _patchMissingFields(
    task: Task,
    content: unknown,
    _issues: string[],
  ): unknown {
    if (task.type !== "analyze") return content;
    if (typeof content !== "object" || content === null || Array.isArray(content)) return content;
    const c = content as Record<string, unknown>;
    const patched = { ...c };
    for (const field of ["actors", "functions", "entities", "constraints", "exceptions", "non_functional_requirements", "business_processes", "proposeNewEntities", "proposeNewFunctions", "proposeNewConstraints", "proposeNewExceptions"] as const) {
      if (patched[field] === undefined || patched[field] === null) {
        patched[field] = [];
      }
    }
    return patched;
  }

  static _ruleCheck(task: Task, content: unknown, context: Record<string, unknown>): string[] {
    const issues: string[] = [];
    const taskType = task.type;
    const hints = (task.contextHints ?? {}) as Record<string, unknown>;

    if (content === null || content === undefined) return ["产物为空"];

    if (taskType === "analyze") {
      if (typeof content !== "object" || content === null || Array.isArray(content))
        return ["需求分析结果格式错误（非 dict）"];
      const c = content as Record<string, unknown>;

        // Standard full validator
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
      const c = GenerationTool._diagramContent(content);
      if (!c)
        return ["图表结果格式错误（非 dict）"];
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
          if (key === "activity_diagram") {
            // 活动图覆盖率检查已移除硬编码域规则，由 LLM 自行判断
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
        // 测试覆盖检查已移除硬编码域规则，由 LLM 自行判断
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

  private static _diagramContent(content: unknown): Record<string, string> | null {
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      return null;
    }
    const record = content as Record<string, unknown>;
    const nested = record.diagrams;
    const source = nested && typeof nested === "object" && !Array.isArray(nested)
      ? nested as Record<string, unknown>
      : record;
    const diagrams: Record<string, string> = {};
    for (const [key, value] of Object.entries(source)) {
      if (!["class_diagram", "activity_diagram", "state_diagram"].includes(key)) {
        continue;
      }
      diagrams[key] = typeof value === "string" ? value : String(value ?? "");
    }
    return diagrams;
  }

  private static _checkUndefinedExceptionIds(
    text: string,
    requirementJson: Record<string, unknown>,
    label: string,
  ): string[] {
    const requirementIndex = RequirementIndex.fromRequirementJson(requirementJson);
    if (requirementIndex.exceptions.length === 0) return [];
    // 异常 ID 前缀从实际数据推导（兼容 X001 / E006 / EXC_xxx 等不同文档约定），
    // 而不是硬编码 X/EXC_ —— 原文用 E 前缀时硬编码会漏检。
    const prefixes = new Set<string>();
    for (const ref of requirementIndex.exceptions) {
      for (const id of [ref.displayId, ref.canonicalId]) {
        const match = /^([A-Z]+_?)/.exec(id);
        if (match) prefixes.add(match[1]);
      }
    }
    const prefixList = [...prefixes];
    const referenced = requirementIndex.extractIds(text)
      .filter((id) => prefixList.some((prefix) => id.startsWith(prefix)));
    const unknown = requirementIndex.unknownReferences(referenced);
    return unknown.length > 0
      ? [`${label} 引用了未定义的异常 ID: ${unknown.join(", ")}`]
      : [];
  }

  // ------------------------------------------------------------------
  // 辅助函数
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
