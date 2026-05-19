/**
 * RepairTool — receives structured EvaluationTool issues → produces repaired artifact.
 * Uses dedicated repair.md prompt. Async LLM calls.
 */

import type { LLMClient } from "../llmClient.js";
import { SystemDesigner } from "../generators/design.js";
import { BaseTool } from "./base.js";
import { ArtifactPatcher, type PatchOp } from "./artifactPatcher.js";
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
      if (task.type === "analyze") {
        // analyze: full rewrite (structured JSON data, not suitable for patching)
        const response = await this.llm!.generateJson(userPrompt, system);
        content = this._parseResponse(response as Record<string, unknown>, task);
      } else {
        // design/diagrams/tests: patch mode
        const text = await this.llm!.generateText(userPrompt, system);
        content = this._applyPatchResponse(task, currentContent, text);
      }
    } catch (e) {
      this.logger.error(`repair: task=${task.id} 修复失败: ${e instanceof Error ? e.message : String(e)}`);
      content = null;
    }

    // Guard: reject output < 50% of original
    if (content != null && currentContent != null) {
      const origStr = task.type === "diagrams" ? JSON.stringify(currentContent) : String(currentContent);
      const newStr = task.type === "diagrams" ? JSON.stringify(content) : String(content);
      if (origStr.length > 0 && newStr.length < origStr.length * 0.5) {
        this.logger.warn(`repair: 修复结果过短（${newStr.length} < ${Math.round(origStr.length * 0.5)}），丢弃`);
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
  // Patch mode
  // ------------------------------------------------------------------

  private _applyPatchResponse(
    task: Task,
    currentContent: unknown,
    llmText: string,
  ): unknown | null {
    // Try to parse LLM output as JSON with patches array
    let parsed: Record<string, unknown>;
    try {
      // Strip markdown code fences if present
      let cleanText = llmText.trim();
      if (cleanText.startsWith("```")) {
        const firstNl = cleanText.indexOf("\n");
        const lastFence = cleanText.lastIndexOf("```");
        if (firstNl >= 0 && lastFence > firstNl) {
          cleanText = cleanText.slice(firstNl + 1, lastFence).trim();
        }
      }
      parsed = JSON.parse(cleanText);
    } catch {
      this.logger.warn(`repair: task=${task.id} LLM输出不是有效JSON，fallback到完整替换`);
      return RepairTool._wrapDiagramText(task, llmText);
    }

    const patchesRaw = parsed.patches;
    if (!Array.isArray(patchesRaw) || patchesRaw.length === 0) {
      this.logger.warn(`repair: task=${task.id} LLM未返回有效的patches数组，fallback到完整替换`);
      // Maybe the LLM returned the full content directly
      if (typeof parsed.content === "string") {
        return task.type === "diagrams"
          ? RepairTool._wrapDiagramText(task, parsed.content)
          : parsed.content;
      }
      return RepairTool._wrapDiagramText(task, llmText);
    }

    const patches: PatchOp[] = patchesRaw
      .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
      .map((p) => ({
        op: String(p.op ?? "replace_section") as PatchOp["op"],
        section: String(p.section ?? ""),
        content: typeof p.content === "string" ? p.content : String(p.content ?? ""),
      }))
      .filter((p) => p.section && p.content !== undefined);

    if (patches.length === 0) {
      this.logger.warn(`repair: task=${task.id} 解析后无有效patches`);
      return null;
    }

    const sections = ArtifactPatcher.parseSections(currentContent, task.type);
    const patchedText = ArtifactPatcher.applyPatches(sections, patches);

    if (task.type === "diagrams") {
      return ArtifactPatcher.reconstruct(
        ArtifactPatcher.parseSections(patchedText, task.type),
        task.type,
      );
    }

    this.logger.info(`repair: task=${task.id} 成功应用 ${patches.length} 个patches`);
    return patchedText;
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

    // For patch-mode tasks, show section listing and current content
    if (task.type !== "analyze") {
      const parsedSections = ArtifactPatcher.parseSections(currentContent, task.type);
      if (parsedSections.length > 1) {
        sections.push(`## 产物章节列表\n以下是当前产物的章节，修复时用 section 字段引用这些名称：\n${ArtifactPatcher.sectionListing(parsedSections)}`);
      }
    }

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

      if (designWarnings.length > 0) {
        sections.push(
          `## 当前设计全量校验结果\n${designWarnings.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
        );
      }
    }

    let fmtNote: string;
    if (task.type === "analyze") {
      fmtNote = '- 严格输出 JSON 格式：{"content": <修复后的完整产物>}';
    } else {
      fmtNote = '- 输出 JSON 格式的 patches 数组，每个 patch 指定要修改的章节名称和替换内容\n- 不要重写未出问题的章节';
    }
    const repairRules = task.type === "analyze"
      ? "- 输出修复后的完整产物"
      : "- 只修复上述问题中指出的章节\n- 保留所有未被指出问题的正确内容";
    sections.push(`## 修复要求\n根据 Evaluator 发现的问题，精准修复当前产物。\n\n**要求**：\n${repairRules}\n${fmtNote}`);

    if (task.type === "diagrams" && diagramKind) {
      sections.push(`\n## 硬性约束\n本任务仅负责 ${diagramKind}，section 字段填 \`${diagramKind}\`。`);
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
      if (typeof content === "object" && content !== null && !Array.isArray(content)) {
        const maybeWrapped = content as Record<string, unknown>;
        if (
          typeof maybeWrapped.diagrams === "object" &&
          maybeWrapped.diagrams !== null &&
          !Array.isArray(maybeWrapped.diagrams)
        ) {
          content = maybeWrapped.diagrams;
        }
      }
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
    if (task.type === "diagrams" && typeof response.diagrams === "object" && response.diagrams !== null) return response.diagrams;
    if (task.type === "design" && typeof response.system_design === "string") return response.system_design;
    if (task.type === "tests" && typeof response.test_cases === "string") return response.test_cases;
    if (task.type === "tests" && Array.isArray(response.test_cases)) return JSON.stringify({ test_cases: response.test_cases }, null, 2);
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
