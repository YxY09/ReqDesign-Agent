/**
 * RepairTool — 接收 EvaluationTool 的结构化评审问题 → 生成修复后的产物。
 * 使用专用的 repair.md prompt。异步 LLM 调用。
 */

import type { LLMClient } from "../llmClient.js";
import { SystemDesigner } from "../generators/design.js";
import { BaseTool } from "./base.js";
import type { ToolCapabilities } from "./types.js";
import { ArtifactPatcher, type PatchOp } from "./artifactPatcher.js";
import type { Task } from "../shared/types.js";
import { isRecord } from "../utils/isRecord.js";

export class RepairTool extends BaseTool {
  constructor(llm: LLMClient) {
    super(llm);
  }

  get name(): string { return "RepairTool"; }

  get capabilities(): ToolCapabilities {
    return { requiresLlm: true, supportedTaskTypes: ["repair"] };
  }

  async repair(
    task: Task,
    currentContent: unknown,
    fixInstructions: Array<Record<string, unknown>>,
    context: Record<string, unknown>,
  ): Promise<unknown | null> {
    this.logger.info(`repair: 开始修复 task=${task.id}, type=${task.type}，修复指令=${fixInstructions.length}条`);

    // 步骤 1：尝试基于规则的确定性修复
    const detResult = this._tryDeterministicFix(task, currentContent, fixInstructions, context);
    if (detResult !== null) {
      this.logger.info(`repair: task=${task.id} 确定性修复成功，跳过LLM调用`);
      return detResult;
    }

    // 步骤 2：对于其他情况，使用 LLM 修复
    const system = await this._loadRepairPrompt(task);
    const userPrompt = this._buildRepairPrompt(task, currentContent, fixInstructions, context);

    let content: unknown = null;
    try {
      if (task.type === "analyze") {
        // analyze: full rewrite (structured JSON data, not suitable for patching)
        const response = await this.llm.generateJson(userPrompt, system);
        content = this._parseResponse(response as Record<string, unknown>, task);
      } else {
        // design/diagrams/tests: patch mode
        const text = await this.llm.generateText(userPrompt, system);
        content = this._applyPatchResponse(task, currentContent, text);
      }
    } catch (e) {
      this.logger.error(`repair: task=${task.id} 修复失败: ${e instanceof Error ? e.message : String(e)}`);
      content = null;
    }

    // 保护机制：如果输出小于原始内容的 50%，则丢弃
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
  // 确定性修复（无需 LLM）
  // ------------------------------------------------------------------

  /**
   * 尝试在不调用 LLM 的情况下确定性地修复问题。
   * 如果所有问题都能确定性地修复，则返回修复后的内容；否则返回 null。
   */
  private _tryDeterministicFix(
    task: Task,
    currentContent: unknown,
    fixInstructions: Array<Record<string, unknown>>,
    context: Record<string, unknown>,
  ): unknown | null {
    if (fixInstructions.length === 0) return null;

    // 仅在所有问题都能确定性修复时才尝试确定性修复
    const fixResults: Array<{ fixed: boolean; content: unknown }> = [];
    let workingContent = currentContent;

    for (const issue of fixInstructions) {
      const desc = String(issue.description ?? "");
      const result = this._trySingleDeterministicFix(task, workingContent, issue, desc, context);
      if (result === null) {
        // 这个问题无法确定性修复——中止
        return null;
      }
      workingContent = result;
      fixResults.push({ fixed: true, content: result });
    }

    // 所有问题都已被确定性修复
    return workingContent;
  }

  /**
   * 尝试确定性地修复单个问题。
   * 如果修复成功则返回新内容；否则返回 null。
   */
  private _trySingleDeterministicFix(
    task: Task,
    currentContent: unknown,
    _issue: Record<string, unknown>,
    description: string,
    context: Record<string, unknown>,
  ): unknown | null {
    // 模式 1：实体命名不一致 — "命名不一致: 需求分析中为 'X'，设计中使用了 'Y'"
    const namingMatch = description.match(/命名不一致.*为\s*'([\w]+)'.*使用了\s*'([\w]+)'/);
    if (namingMatch) {
      const [, correctName, wrongName] = namingMatch;
      if (correctName && wrongName && correctName !== wrongName) {
        return this._fixNamingMismatch(task, currentContent, correctName, wrongName);
      }
    }

    // 模式 2：类图中缺少实体 — "类图缺少需求分析中的核心实体: X, Y"
    const missingEntityMatch = description.match(/类图缺少需求分析中的核心实体:\s*(.+)/);
    if (missingEntityMatch && task.type === "diagrams") {
      const entityNames = missingEntityMatch[1].split(", ").map((s) => s.trim()).filter(Boolean);
      if (entityNames.length > 0) {
        return this._fixMissingClassDiagramEntities(task, currentContent, entityNames, context);
      }
    }

    // 模式 3：约束未被测试覆盖 — "约束 X 未被测试用例覆盖"
    const constraintMatch = description.match(/约束\s*(C\d+)\s*未被测试用例覆盖/);
    if (constraintMatch && task.type === "tests") {
      return this._fixMissingConstraintTest(task, currentContent, constraintMatch[1], context);
    }

    // 模式 4：幽灵功能 ID — "功能ID不一致: ...引用了分析中不存在的功能ID: F009, F010"
    const ghostIdMatch = description.match(/功能ID不一致.*不存在的功能ID:\s*([F\d, ]+)/);
    if (ghostIdMatch) {
      const ghostIds = ghostIdMatch[1].split(/,\s*/).filter((s) => /^F\d+$/.test(s.trim()));
      if (ghostIds.length > 0) {
        return this._fixGhostFunctionIds(task, currentContent, ghostIds, context);
      }
    }

    return null;
  }

  private _fixNamingMismatch(
    task: Task,
    currentContent: unknown,
    correctName: string,
    wrongName: string,
  ): unknown | null {
    this.logger.info(`deterministic: fixing naming '${wrongName}' -> '${correctName}'`);

    if (task.type === "diagrams" && typeof currentContent === "object" && currentContent !== null) {
      const obj = currentContent as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(obj)) {
        if (typeof val === "string") {
          // Replace class name declarations: 'class WrongName {'
          let fixed = val.replace(
            new RegExp(`class ${this._escapeRegex(wrongName)}\\s*\\{`, "g"),
            `class ${correctName} {`,
          );
          // Replace relationship references: 'WrongName "1"'
          fixed = fixed.replace(
            new RegExp(`\\b${this._escapeRegex(wrongName)}\\b`, "g"),
            correctName,
          );
          result[key] = fixed;
        } else {
          result[key] = val;
        }
      }
      return result;
    }

    if (typeof currentContent === "string") {
      // For design/tests: replace word boundaries
      let fixed = currentContent;
      // Replace in bold markers: **WrongName**
      fixed = fixed.replace(
        new RegExp(`\\*\\*${this._escapeRegex(wrongName)}\\*\\*`, "g"),
        `**${correctName}**`,
      );
      // Replace as standalone word
      fixed = fixed.replace(
        new RegExp(`\\b${this._escapeRegex(wrongName)}\\b`, "g"),
        correctName,
      );
      return fixed;
    }

    return null;
  }

  private _fixMissingClassDiagramEntities(
    task: Task,
    currentContent: unknown,
    entityNames: string[],
    context: Record<string, unknown>,
  ): unknown | null {
    if (task.type !== "diagrams" || typeof currentContent !== "object" || currentContent === null) {
      return null;
    }

    const obj = currentContent as Record<string, unknown>;
    const classDiagram = String(obj.class_diagram ?? "");
    if (!classDiagram) return null;

    // Build minimal class definitions from requirement entities
    const reqEntities = (context.requirement_json as Record<string, unknown>)?.entities;
    const entityMap = new Map<string, Record<string, unknown>>();
    if (Array.isArray(reqEntities)) {
      for (const ent of reqEntities) {
        if (typeof ent === "object" && ent !== null) {
          entityMap.set(String((ent as Record<string, unknown>).name ?? "").trim(), ent as Record<string, unknown>);
        }
      }
    }

    const newClasses: string[] = [];
    for (const name of entityNames) {
      const entity = entityMap.get(name);
      const attrs = Array.isArray((entity as Record<string, unknown>)?.attributes)
        ? ((entity as Record<string, unknown>).attributes as Array<Record<string, unknown>>).slice(0, 3).map(
            (a) => `        -String ${(a as Record<string, unknown>).name ?? "id"}`,
          ).join("\n")
        : `        -Long id`;
      newClasses.push(`    class ${name} {
${attrs}
    }`);
    }

    // Insert before the first relationship line
    const lines = classDiagram.split("\n");
    const firstRelIdx = lines.findIndex((l) => /"\d*"\s*-->/.test(l));
    if (firstRelIdx === -1) {
      // No relationships found, append
      const fixed = classDiagram + "\n" + newClasses.join("\n");
      return { ...obj, class_diagram: fixed };
    }
    lines.splice(firstRelIdx, 0, ...newClasses);
    return { ...obj, class_diagram: lines.join("\n") };
  }

  /**
   * 从设计/测试内容中移除幽灵功能 ID。
   * 策略：用分析结果中最接近的有效 ID 替换幽灵 Fxxx，或者移除该引用。
   */
  private _fixGhostFunctionIds(
    task: Task,
    currentContent: unknown,
    ghostIds: string[],
    context: Record<string, unknown>,
  ): unknown | null {
    // Get analysis function IDs for fallback
    const reqJson = context.requirementJson as Record<string, unknown> | undefined;
    const functions = Array.isArray(reqJson?.functions)
      ? (reqJson!.functions as Array<Record<string, unknown>>)
      : [];
    const analysisIds = functions.map(f => String(f.id ?? "").trim()).filter(id => /^F\d+$/.test(id));

    this.logger.info(`deterministic: removing ghost function IDs: ${ghostIds.join(", ")}`);

    if (task.type === "tests" && typeof currentContent === "string") {
      // 对于测试用例：移除引用了幽灵 ID 的整个测试用例块
      let fixed = currentContent;
      for (const ghostId of ghostIds) {
        // Remove test case entries like "## TC-N-xxx: ...\n- **测试对象**: F009\n..."
        // Strategy: replace the ghost ID with a note, or remove the test case block
        fixed = fixed.replace(
          new RegExp(`##[^\n]*\\n(?:-[^\n]*\\n)*\\s*-\\s\\*\\*测试对象\\*\\*:\\s*[^,]*\\b${this._escapeRegex(ghostId)}\\b[^\\n]*\\n(?:-[^\n]*\\n)*`, "g"),
          "",
        );
      }
      // If nothing changed, try simple replacement
      if (fixed === currentContent) {
        for (const ghostId of ghostIds) {
          fixed = fixed.replace(
            new RegExp(`\\b${this._escapeRegex(ghostId)}\\b`, "g"),
            analysisIds.length > 0 ? analysisIds[0] : "",
          );
        }
      }
      return fixed !== currentContent ? fixed : null;
    }

    if (task.type === "design" && typeof currentContent === "string") {
      // 对于设计：移除引用了幽灵 ID 的模块表行
      let fixed = currentContent;
      for (const ghostId of ghostIds) {
        // Remove table rows: | **ModuleName** | ... | F009 |
        fixed = fixed.replace(
          new RegExp(`\\|[^\n]*\\b${this._escapeRegex(ghostId)}\\b[^\n]*\\|\\n`, "g"),
          "",
        );
      }
      // 备选方案：简单的单词替换
      if (fixed === currentContent) {
        for (const ghostId of ghostIds) {
          fixed = fixed.replace(
            new RegExp(`\\b${this._escapeRegex(ghostId)}\\b`, "g"),
            "",
          );
        }
      }
      return fixed !== currentContent ? fixed : null;
    }

    return null;
  }

  private _fixMissingConstraintTest(
    _task: Task,
    currentContent: unknown,
    constraintId: string,
    context: Record<string, unknown>,
  ): unknown | null {
    if (typeof currentContent !== "string") return null;

    const reqJson = context.requirement_json as Record<string, unknown> | undefined;
    if (!reqJson) return null;

    const constraints = Array.isArray(reqJson.constraints)
      ? reqJson.constraints as Array<Record<string, unknown>>
      : [];
    const constraint = constraints.find((c) => String(c.id ?? "").trim() === constraintId);
    if (!constraint) return null;

    const desc = String(constraint.description ?? constraintId);
    const testNum = (currentContent.match(/## TC-B-/g) ?? []).length + 1;
    const testId = `TC-B-${String(testNum).padStart(3, "0")}`;

    const newTest = `\n\n## ${testId}: ${constraintId} 约束边界测试\n- **类型**: 边界\n- **测试对象**: ${constraintId}\n- **前置条件**: 系统已初始化，相关数据就绪\n- **测试步骤**: 1. 构造满足约束 ${constraintId}（${desc.slice(0, 60)}）边界值的数据 2. 触发对应业务操作 3. 验证系统对边界值的处理结果\n- **预期结果**: 系统在边界值处正确执行约束校验，边界内通过，边界外拒绝并给出提示\n- **优先级**: P1`;

    return currentContent + newTest;
  }

  private _escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // ------------------------------------------------------------------
  // Patch 模式
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
  // 构建 Prompt
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
  // 格式化
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
  // 图表辅助函数
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
  // 解析响应
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
