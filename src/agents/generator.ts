/**
 * GeneratorAgent — receives Task → produces Artifact with rule self-check.
 * Routes to appropriate generators by task.type.
 */

import { performance } from "node:perf_hooks";
import type { LLMClient } from "../llmClient.js";
import { BaseAgent } from "./base.js";
import { type Task, type Artifact, createArtifact } from "./types.js";
import { RequirementAnalyzer } from "../generators/analyze.js";
import { SystemDesigner } from "../generators/design.js";
import { DiagramGenerator } from "../generators/diagrams.js";
import { TestCaseGenerator } from "../generators/tests.js";

export class GeneratorAgent extends BaseAgent {
  private _systemPrompt: string | null = null;
  private _analyzer: RequirementAnalyzer | null = null;
  private _designer: SystemDesigner | null = null;
  private _diagramGen: DiagramGenerator | null = null;
  private _testGen: TestCaseGenerator | null = null;

  constructor(llm: LLMClient) {
    super(llm);
  }

  get name(): string { return "GeneratorAgent"; }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  async execute(task: Task, context: Record<string, unknown>): Promise<Artifact> {
    const t0 = performance.now();

    try {
      const content = await this._generate(task, context);
      if (content === null || content === undefined) {
        throw new Error(`生成 ${task.type} 返回空结果`);
      }

      const issues = GeneratorAgent._ruleCheck(task, content, context);
      const elapsed = (performance.now() - t0) / 1000;
      const passed = issues.length === 0;

      return createArtifact({
        taskId: task.id,
        type: task.type,
        revision: 1,
        content,
        selfCheckPassed: passed,
        selfCheckIssues: issues,
        selfCorrectRounds: 0,
        generationDuration: elapsed,
      });
    } catch (e: unknown) {
      const elapsed = (performance.now() - t0) / 1000;
      const msg = e instanceof Error ? e.message : String(e);
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
    const injectedPrompt = await this._getSystemPrompt(queryCtx);

    switch (task.type) {
      case "analyze":
        return await this._generateAnalyze(context, hints, desc, injectedPrompt);
      case "design":
        return await this._generateDesign(context, hints, desc, injectedPrompt);
      case "diagrams":
        return await this._generateDiagrams(context, hints, desc, injectedPrompt);
      case "tests":
        return await this._generateTests(context, hints, desc, injectedPrompt);
      default:
        throw new Error(`未知任务类型: ${task.type}`);
    }
  }

  private async _generateAnalyze(
    ctx: Record<string, unknown>, hints: Record<string, unknown>,
    desc: string, systemPrompt: string,
  ): Promise<Record<string, unknown>> {
    let text = (ctx.requirement_text as string) ?? "";
    const existingJson = ctx.requirement_json as Record<string, unknown> | undefined;
    if (!text && !existingJson) throw new Error("缺少 requirement_text 和 requirement_json");

    if (hints.focus_areas) {
      const focus = (hints.focus_areas as string[]).join(", ");
      text = `[重点关注: ${focus}]\n\n${text}`;
    }
    if (hints.note) text = `[补充说明: ${hints.note}]\n\n${text}`;
    if (desc) text = `[任务要求: ${desc}]\n\n${text}`;

    if (this.llm) this.llm.streamTag = "[Generator:analyze]";
    const analyzer = this._getAnalyzer();
    const raw = await analyzer.analyze(text, 3, systemPrompt, existingJson);
    return GeneratorAgent._unwrapAnalyzeDict(raw);
  }

  private async _generateDesign(
    ctx: Record<string, unknown>, _hints: Record<string, unknown>,
    _desc: string, systemPrompt: string,
  ): Promise<string> {
    const reqJson = ctx.requirement_json as Record<string, unknown> | undefined;
    if (!reqJson) throw new Error("缺少 requirement_json");

    if (this.llm) this.llm.streamTag = "[Generator:design]";
    return this._getDesigner().generateDesign(reqJson, (ctx.requirement_text as string) ?? "", systemPrompt);
  }

  private async _generateDiagrams(
    ctx: Record<string, unknown>, hints: Record<string, unknown>,
    _desc: string, systemPrompt: string,
  ): Promise<Record<string, string>> {
    const reqJson = (ctx.requirement_json ?? {}) as Record<string, unknown>;
    const designText = (ctx.design_text as string) ?? "";
    const reqText = (ctx.requirement_text as string) ?? "";
    const diagramKind = String(hints.diagram_kind ?? "").trim();

    if (this.llm) this.llm.streamTag = "[Generator:diagrams]";
    const generator = this._getDiagramGen();

    if (diagramKind) {
      const methodMap: Record<string, () => Promise<string>> = {
        class_diagram: () => generator.generateClassDiagram(reqJson, designText, systemPrompt, reqText),
        activity_diagram: () => generator.generateActivityDiagram(reqJson, designText, systemPrompt, reqText),
        state_diagram: () => generator.generateStateDiagram(reqJson, designText, systemPrompt, reqText),
      };
      const method = methodMap[diagramKind];
      if (!method) throw new Error(`未知图表类型: ${diagramKind}`);
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
    }
    else if (taskType === "design") {
      if (typeof content !== "string" || !content.trim())
        return ["设计文档为空"];
      const reqJson = (context.requirement_json ?? {}) as Record<string, unknown>;
      issues.push(...SystemDesigner.validateDesign(String(content), reqJson));
    }
    else if (taskType === "diagrams") {
      if (typeof content !== "object" || content === null || Array.isArray(content))
        return ["图表结果格式错误（非 dict）"];
      const c = content as Record<string, string>;
      const diagramKind = String(hints.diagram_kind ?? "").trim();
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
          if (key === "class_diagram") {
            const openClasses = (text.match(/class\s+(\w+)\s*\{/g) ?? []).length;
            const closeBraces = (text.match(/^\s*\}/gm) ?? []).length;
            if (openClasses > closeBraces) {
              issues.push(`classDiagram 有 ${openClasses} 个类定义但只有 ${closeBraces} 个闭合括号，输出可能被截断`);
            }
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
      } catch (e) {
        issues.push(`测试用例规则校验失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return issues;
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

  private async _getSystemPrompt(queryContext = ""): Promise<string> {
    if (this._systemPrompt === null || queryContext) {
      const prompt = await this._loadPromptWithConstitution("generator.md", "", queryContext);
      if (!queryContext) this._systemPrompt = prompt;
      return prompt;
    }
    return this._systemPrompt;
  }

  private _getAnalyzer(): RequirementAnalyzer {
    if (!this._analyzer) this._analyzer = new RequirementAnalyzer(this.llm!);
    return this._analyzer;
  }

  private _getDesigner(): SystemDesigner {
    if (!this._designer) this._designer = new SystemDesigner(this.llm!);
    return this._designer;
  }

  private _getDiagramGen(): DiagramGenerator {
    if (!this._diagramGen) this._diagramGen = new DiagramGenerator(this.llm!);
    return this._diagramGen;
  }

  private _getTestGen(): TestCaseGenerator {
    if (!this._testGen) this._testGen = new TestCaseGenerator(this.llm!);
    return this._testGen;
  }
}
