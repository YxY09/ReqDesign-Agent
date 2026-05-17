/**
 * RepairTool — receives structured EvaluationTool issues → produces repaired artifact.
 * Uses dedicated repair.md prompt. Async LLM calls.
 */

import type { LLMClient } from "../llmClient.js";
import { SystemDesigner } from "../generators/design.js";
import { BaseTool } from "./base.js";
import type { Task } from "../agent/types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class RepairTool extends BaseTool {
  constructor(llm: LLMClient) {
    super(llm);
  }

  get name(): string { return "RepairTool"; }

  async repair(
    task: Task,
    currentContent: unknown,
    fixInstructions: Array<Record<string, unknown>>,
    context: Record<string, unknown>,
  ): Promise<unknown | null> {
    this.logger.info(`repair: 开始修复 task=${task.id}, type=${task.type}，修复指令=${fixInstructions.length}条`);
    const system = await this._loadRepairPrompt(task);
    const userPrompt = this._buildRepairPrompt(task, currentContent, fixInstructions, context);

    let content: unknown = null;
    try {
      if (task.type === "design" || task.type === "tests" || task.type === "diagrams") {
        const text = await this.llm!.generateText(userPrompt, system);
        content = RepairTool._wrapDiagramText(task, text);
      } else {
        const response = await this.llm!.generateJson(userPrompt, system);
        content = this._parseResponse(response as Record<string, unknown>, task);
      }
    } catch (e) {
      this.logger.error(`repair: task=${task.id} 修复失败: ${e instanceof Error ? e.message : String(e)}`);
      content = null;
    }

    // Guard: reject output < 50% of original
    if (content != null && currentContent != null) {
      const origLen = String(currentContent).length;
      const newLen = String(content).length;
      if (origLen > 0 && newLen < origLen * 0.5) {
        this.logger.warn(`repair: 修复结果过短（${newLen} < ${Math.round(origLen * 0.5)}），丢弃`);
        content = null;
      }
    }

    if (content != null) {
      this.logger.info(`repair: task=${task.id} 修复成功`);
    } else {
      this.logger.warn(`repair: task=${task.id} 修复返回空结果`);
    }
    return content;
  }

  // ------------------------------------------------------------------
  // Prompt building
  // ------------------------------------------------------------------

  private _loadRepairPrompt(task: Task): Promise<string> {
    const queryCtx = `repair ${task.type}: ${task.description.slice(0, 200)}`;
    return this._loadPromptWithConstitution("repair.md", "", queryCtx);
  }

  private _buildRepairPrompt(
    task: Task,
    currentContent: unknown,
    fixInstructions: Array<Record<string, unknown>>,
    context: Record<string, unknown>,
  ): string {
    const sections: string[] = [];

    const hints = (task.contextHints ?? {}) as Record<string, unknown>;
    let taskInfo = `**类型**: ${task.type}\n**描述**: ${task.description}`;
    const diagramKind = String(hints.diagram_kind ?? "").trim();
    if (diagramKind) taskInfo += `\n**图表类型**: ${diagramKind}`;
    sections.push(`## 任务信息\n${taskInfo}`);

    const reqText = String(context.requirement_text ?? "").slice(0, 6000);
    if (reqText) sections.push(`## 原始需求\n${reqText}`);

    sections.push(`## Evaluator 发现的问题\n${RepairTool._formatIssues(fixInstructions)}`);
    sections.push(`## 当前产物\n${RepairTool._formatContent(currentContent)}`);

    const aux = RepairTool._formatAuxContext(context);
    if (aux) sections.push(`## 辅助上下文\n${aux}`);

    if (task.type === "design") {
      const requirementJson = isRecord(context.requirement_json)
        ? context.requirement_json
        : null;
      const designText = typeof currentContent === "string"
        ? currentContent
        : String(currentContent ?? "");
      const designWarnings = requirementJson
        ? SystemDesigner.validateDesign(designText, requirementJson)
        : [];

      sections.push(
        "## 设计修复模式\n" +
          "- 这是一份系统设计文档修复，不是单句补丁。\n" +
          "- 如果问题表现为实体缺失、章节缺失、模块映射不完整或命名不一致，应按 requirement_json 做一次全局闭环。\n" +
          "- 保留正确内容，但允许重写受影响章节，优先一次性补齐所有已知缺口。",
      );

      if (designWarnings.length > 0) {
        sections.push(
          `## 当前设计全量校验结果\n${designWarnings.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
        );
      }
    }

    let fmtNote: string;
    if (task.type === "design" || task.type === "tests") {
      fmtNote = "- 直接输出修复后的完整 Markdown 文本，**不要用 JSON 包裹**";
    } else if (task.type === "diagrams") {
      fmtNote = "- 直接输出修复后的完整 Mermaid 文本，**不要用 JSON 包裹，不要用 markdown 代码块包裹**";
    } else {
      fmtNote = '- 严格输出 JSON 格式：{"content": <修复后的完整产物>}';
    }
    const repairRules = task.type === "design"
      ? "- 默认保留所有未被指出问题的正确内容\n- 对于设计不全、覆盖不全、命名不一致类问题，按全局闭环修复，不要只补单点"
      : "- 只修复上述问题中指出的部分\n- 保留所有未被指出问题的正确内容";
    sections.push(`## 修复要求\n根据 Evaluator 发现的问题，精准修复当前产物。\n\n**要求**：\n${repairRules}\n- 输出修复后的**完整**产物（绝对不要截断或省略）\n${fmtNote}`);

    if (task.type === "diagrams" && diagramKind) {
      sections.push(`\n## 硬性约束\n本任务仅负责 ${diagramKind}，直接输出该图表的 Mermaid 代码。`);
    }

    return sections.join("\n\n");
  }

  // ------------------------------------------------------------------
  // Formatting
  // ------------------------------------------------------------------

  static _formatIssues(issues: Array<Record<string, unknown>>): string {
    if (issues.length === 0) return "(无问题)";
    return issues.map((iss, i) => {
      const severity = iss.severity ?? "major";
      const target = iss.target_field ?? iss.task_type ?? "";
      const desc = iss.description ?? "";
      const suggestion = iss.suggestion ?? "";
      let line = `### 问题 ${i + 1} [${severity}]`;
      if (target) line += ` — \`${target}\``;
      line += `\n**问题**: ${desc}`;
      if (suggestion) line += `\n**修复建议**: ${suggestion}`;
      return line;
    }).join("\n\n");
  }

  static _formatContent(content: unknown): string {
    if (content === null || content === undefined) return "(空)";
    if (typeof content === "string") {
      return content.length > 12000 ? content.slice(0, 12000) + "\n\n...(产物已截断)" : content;
    }
    if (typeof content === "object") {
      const serialized = JSON.stringify(content, null, 2);
      const truncated = serialized.length > 12000 ? serialized.slice(0, 12000) + "\n\n...(产物已截断)" : serialized;
      return "```json\n" + truncated + "\n```";
    }
    return String(content).slice(0, 12000);
  }

  static _formatAuxContext(context: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const [key, val] of Object.entries(context)) {
      if (key.startsWith("_") || key === "requirement_text") continue;
      if (typeof val === "string") {
        parts.push(`### ${key}\n${val.slice(0, 3000)}`);
      } else if (typeof val === "object" && val !== null) {
        const serialized = JSON.stringify(val, null, 2);
        parts.push(`### ${key}\n\`\`\`json\n${serialized.slice(0, 4000)}\n\`\`\``);
      }
    }
    return parts.join("\n\n");
  }

  // ------------------------------------------------------------------
  // Diagram helpers
  // ------------------------------------------------------------------

  static _wrapDiagramText(task: Task, text: string): unknown {
    if (task.type !== "diagrams") return text;
    const hints = (task.contextHints ?? {}) as Record<string, unknown>;
    let diagramKind = String(hints.diagram_kind ?? "").trim();
    if (!diagramKind) diagramKind = RepairTool._inferDiagramKind(task, text);
    if (diagramKind) return { [diagramKind]: text };
    return { diagram: text };
  }

  // ------------------------------------------------------------------
  // Response parsing
  // ------------------------------------------------------------------

  private _parseResponse(response: Record<string, unknown>, task: Task): unknown {
    let content = response.content;

    if (content === undefined && !("content" in response) && Object.keys(response).length > 0) {
      content = RepairTool._inferContent(response, task);
    }

    if (content !== undefined && task.type === "diagrams") {
      const hints = (task.contextHints ?? {}) as Record<string, unknown>;
      let diagramKind = String(hints.diagram_kind ?? "").trim();
      if (!diagramKind) diagramKind = RepairTool._inferDiagramKind(task, String(content));
      if (typeof content === "string" && diagramKind) {
        content = { [diagramKind]: content };
      }
      if (diagramKind && typeof content === "object" && content !== null && !Array.isArray(content)) {
        const c = content as Record<string, unknown>;
        const extra = Object.keys(c).filter((k) => k !== diagramKind);
        if (extra.length > 0) {
          content = { [diagramKind]: c[diagramKind] };
        }
      }
    }

    return content;
  }

  static _inferContent(response: Record<string, unknown>, task: Task): unknown {
    if (task.type === "analyze" && "actors" in response) return response;
    if (task.type === "diagrams" && ("class_diagram" in response || "activity_diagram" in response || "state_diagram" in response)) return response;
    if (task.type === "design" && typeof response.system_design === "string") return response.system_design;
    if (task.type === "tests" && typeof response.test_cases === "string") return response.test_cases;
    if (Object.keys(response).length === 1) {
      const val = Object.values(response)[0];
      if (typeof val === "object" || typeof val === "string") return val;
    }
    return null;
  }

  static _inferDiagramKind(task: Task, text = ""): string {
    const haystack = `${task.id} ${task.description} ${text.slice(0, 200)}`.toLowerCase();
    if (haystack.includes("class") || haystack.includes("类图") || haystack.includes("classdiagram")) return "class_diagram";
    if (haystack.includes("activity") || haystack.includes("活动") || haystack.includes("flowchart") || haystack.includes("graph ")) return "activity_diagram";
    if (haystack.includes("state") || haystack.includes("状态") || haystack.includes("statediagram")) return "state_diagram";
    return "";
  }
}
