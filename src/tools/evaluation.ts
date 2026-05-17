/**
 * EvaluationTool — reviews artifacts, finds structured issues, produces fix tasks.
 * Rule checks (no LLM) + LLM semantic review. Async LLM calls.
 */

import type { LLMClient } from "../llmClient.js";
import { BaseTool } from "./base.js";
import {
  type Issue, type Task, type Verdict, type Scope,
  createIssue, createTask, createVerdict,
} from "../agent/types.js";
import { SystemDesigner } from "../generators/design.js";
import { TestCaseGenerator } from "../generators/tests.js";

export class EvaluationTool extends BaseTool {
  private _systemPrompt: string | null = null;

  constructor(llm: LLMClient) {
    super(llm);
  }

  get name(): string { return "EvaluationTool"; }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  async evaluate(
    requirementText: string,
    requirementJson: Record<string, unknown>,
    designText: string,
    diagrams: Record<string, string>,
    testCases: string,
    artifactSummary: Record<string, unknown>,
    artifactSnapshots?: Record<string, Record<string, unknown>>,
    goal = "design",
    isDirectMode = false,
    evaluatedTaskIds?: string[],
  ): Promise<Verdict> {
    this.logger.info(`evaluate: 开始评审，goal=${goal}，directMode=${isDirectMode}`);
    const snapshots = artifactSnapshots ?? EvaluationTool._buildAggregateSnapshots(
      requirementJson, designText, diagrams, testCases,
    );

    // Auto-detect direct mode
    if (!isDirectMode) {
      const hasAnalysis = Object.values(snapshots).some(
        (s) => s.type === "analyze",
      ) || (
        requirementJson && typeof requirementJson === "object"
        && (requirementJson.actors || requirementJson.functions)
      );
      const hasDesign = Object.values(snapshots).some(
        (s) => s.type === "design",
      ) || Boolean(designText?.trim());
      if (!hasAnalysis && !hasDesign) isDirectMode = true;
    }

    const issues: Issue[] = [];

    // 1. Rule check
    const ruleIssues = this._ruleCheckSnapshots(snapshots, isDirectMode, requirementJson);
    issues.push(...ruleIssues);
    this.logger.info(`evaluate: 规则检查发现 ${ruleIssues.length} 个问题`);

    // 2. LLM review
    let llmIssues: Issue[];
    const reviewMode = EvaluationTool._selectReviewMode(snapshots, isDirectMode, goal);
    if (Object.keys(snapshots).length > 0) {
      const [li] = await this._llmReviewSnapshots(requirementText, snapshots, isDirectMode, reviewMode);
      llmIssues = li;
    } else if (goal.toLowerCase().includes("analyze")) {
      llmIssues = await this._llmReviewAnalyze(requirementText, requirementJson);
    } else {
      llmIssues = [];
    }
    llmIssues = this._filterSnapshotIssues(llmIssues, snapshots);
    issues.push(...llmIssues);

    // Classify scope
    for (const issue of issues) EvaluationTool._classifyIssueScope(issue);

    // 3. Decide pass/fail
    const blockers = issues.filter((i) => i.severity === "blocker");
    const passed = blockers.length === 0;
    this.logger.info(`evaluate: 评审完成，passed=${passed}，blockers=${blockers.length}，majors=${issues.filter((i) => i.severity === "major").length}，minors=${issues.filter((i) => i.severity === "minor").length}`);

    // 4. Build fix tasks
    const fixes = passed ? [] : EvaluationTool._buildFixes(issues);

    // Build evaluated_revisions
    const evaluatedRevisions: Record<string, number> = {};
    for (const [tid, snapshot] of Object.entries(snapshots)) {
      const revision = Number((snapshot as Record<string, unknown>).revision ?? 0);
      if (revision > 0) evaluatedRevisions[tid] = revision;
    }
    if (Object.keys(evaluatedRevisions).length === 0 && typeof artifactSummary === "object") {
      if (evaluatedTaskIds) {
        for (const tid of evaluatedTaskIds) {
          const meta = (artifactSummary[tid] ?? {}) as Record<string, unknown>;
          const rev = Number(meta.revision ?? 0);
          if (rev > 0) evaluatedRevisions[tid] = rev;
        }
      } else {
        for (const [tid, meta] of Object.entries(artifactSummary)) {
          const rev = Number((meta as Record<string, unknown>).revision ?? 0);
          if (rev > 0) evaluatedRevisions[tid] = rev;
        }
      }
    }

    return createVerdict({
      passed,
      issues,
      fixes,
      summary: EvaluationTool._buildSummary(passed, issues),
      evaluatedTaskIds: Object.keys(evaluatedRevisions).sort(),
      evaluatedRevisions,
    });
  }

  // ------------------------------------------------------------------
  // Rule checks (no LLM)
  // ------------------------------------------------------------------

  static _classifyIssueScope(issue: Issue): Scope {
    if (issue.targetTaskType === "analyze" && issue.severity === "blocker") {
      issue.scope = "systemic";
    } else if (issue.targetField.startsWith("requirement_json.")) {
      issue.scope = "upstream";
    } else {
      issue.scope = "local";
    }
    return issue.scope;
  }

  static _buildAggregateSnapshots(
    requirementJson: Record<string, unknown>,
    designText: string,
    diagrams: Record<string, string>,
    testCases: string,
  ): Record<string, Record<string, unknown>> {
    const snaps: Record<string, Record<string, unknown>> = {};
    if (requirementJson) {
      snaps["analyze-1"] = { task_id: "analyze-1", type: "analyze", revision: 0, content: requirementJson };
    }
    if (designText?.trim()) {
      snaps["design-1"] = { task_id: "design-1", type: "design", revision: 0, content: designText };
    }
    if (diagrams && Object.keys(diagrams).length > 0) {
      snaps["diagrams-1"] = { task_id: "diagrams-1", type: "diagrams", revision: 0, content: diagrams };
    }
    if (testCases?.trim()) {
      snaps["tests-1"] = { task_id: "tests-1", type: "tests", revision: 0, content: testCases };
    }
    return snaps;
  }

  static _selectReviewMode(
    snapshots: Record<string, Record<string, unknown>>,
    isDirectMode: boolean,
    goal: string,
  ): string {
    if (goal.toLowerCase().includes("analyze")) return "quick";
    if (isDirectMode) return "quick";
    if (Object.keys(snapshots).length <= 3) return "quick";
    return "deep";
  }

  private _allowedSnapshotFields(snapshot: Record<string, unknown>): Set<string> {
    const taskType = String(snapshot.type ?? "");
    const content = snapshot.content;
    if (taskType === "analyze") {
      const fields = new Set(["requirement_json"]);
      if (typeof content === "object" && content !== null) {
        for (const key of Object.keys(content as Record<string, unknown>)) fields.add(`requirement_json.${key}`);
      }
      return fields;
    }
    if (taskType === "design") return new Set(["design_text"]);
    if (taskType === "tests") return new Set(["test_cases", "content"]);
    if (taskType === "diagrams") {
      const fields = new Set(["diagrams"]);
      if (typeof content === "object" && content !== null) {
        for (const key of Object.keys(content as Record<string, unknown>)) {
          fields.add(key);
          fields.add(`diagrams.${key}`);
        }
      }
      return fields;
    }
    return new Set();
  }

  private _filterSnapshotIssues(
    issues: Issue[],
    snapshots: Record<string, Record<string, unknown>>,
  ): Issue[] {
    if (issues.length === 0 || Object.keys(snapshots).length === 0) return issues;

    const singleTaskId = Object.keys(snapshots).length === 1 ? Object.keys(snapshots)[0] : "";
    const filtered: Issue[] = [];

    for (const issue of issues) {
      let taskId = issue.targetTaskId.trim();
      if (!taskId) taskId = singleTaskId;
      if (!snapshots[taskId] && singleTaskId) taskId = singleTaskId;
      const snapshot = snapshots[taskId];
      if (!snapshot) continue;

      issue.targetTaskId = taskId;
      issue.targetTaskType = String(snapshot.type ?? "");

      const allowedFields = this._allowedSnapshotFields(snapshot);
      const field = issue.targetField.trim();
      if (field && allowedFields.size > 0 && !allowedFields.has(field)) continue;
      if (!field && allowedFields.size > 0) {
        issue.targetField = [...allowedFields].sort()[0];
      }
      filtered.push(issue);
    }
    return filtered;
  }

  _ruleCheckSnapshots(
    snapshots: Record<string, Record<string, unknown>>,
    skipMissingArtifact: boolean,
    requirementJson: Record<string, unknown>,
  ): Issue[] {
    const issues: Issue[] = [];

    for (const [taskId, snapshot] of Object.entries(snapshots)) {
      const taskType = String(snapshot.type ?? "");
      const content = snapshot.content;

      if (taskType === "analyze") {
        if (!content || typeof content !== "object") {
          issues.push(createIssue({ severity: "blocker", targetTaskId: taskId, targetTaskType: "analyze", targetField: "requirement_json", description: "需求分析结果为空或格式错误", suggestion: "重新执行需求分析任务" }));
          continue;
        }
        const c = content as Record<string, unknown>;
        if (!c.actors) issues.push(createIssue({ severity: "major", targetTaskId: taskId, targetTaskType: "analyze", targetField: "requirement_json.actors", description: "需求分析缺少 actors", suggestion: "补充参与者列表" }));
        if (!c.functions) issues.push(createIssue({ severity: "blocker", targetTaskId: taskId, targetTaskType: "analyze", targetField: "requirement_json.functions", description: "需求分析缺少 functions", suggestion: "补充功能列表" }));
        if (!c.entities) issues.push(createIssue({ severity: "major", targetTaskId: taskId, targetTaskType: "analyze", targetField: "requirement_json.entities", description: "需求分析缺少 entities", suggestion: "补充实体列表" }));
        continue;
      }

      if (taskType === "design") {
        if (skipMissingArtifact) continue;
        if (typeof content !== "string" || !(content as string).trim()) {
          issues.push(createIssue({ severity: "blocker", targetTaskId: taskId, targetTaskType: "design", targetField: "design_text", description: "系统设计文档为空", suggestion: "重新执行设计生成任务" }));
        } else {
          for (const warning of SystemDesigner.validateDesign(String(content), requirementJson)) {
            issues.push(createIssue({
              severity: "major",
              targetTaskId: taskId,
              targetTaskType: "design",
              targetField: "design_text",
              description: warning,
              suggestion: warning.includes("未在需求中识别的核心类")
                ? "删除或下沉多余的核心类，只保留需求中识别的业务实体"
                : "补充对应模块、实体或章节，并保持与需求一致",
            }));
          }
        }
        continue;
      }

      if (taskType === "diagrams") {
        if (typeof content !== "object" || content === null || Array.isArray(content) || Object.keys(content as Record<string, unknown>).length === 0) {
          issues.push(createIssue({ severity: "blocker", targetTaskId: taskId, targetTaskType: "diagrams", targetField: "diagrams", description: "图表为空或格式错误", suggestion: "重新执行图表生成任务" }));
          continue;
        }
        const c = content as Record<string, string>;
        for (const [dtype, raw] of Object.entries(c)) {
          if (!raw?.trim()) {
            issues.push(createIssue({ severity: "blocker", targetTaskId: taskId, targetTaskType: "diagrams", targetField: `diagrams.${dtype}`, description: `${dtype} 为空`, suggestion: `重新生成 ${dtype}` }));
            continue;
          }
          const text = String(raw).trim();
          const firstLine = text.split("\n")[0].trim();
          const expected: Record<string, string[]> = {
            class_diagram: ["classDiagram"],
            activity_diagram: ["flowchart", "graph"],
            state_diagram: ["stateDiagram-v2", "stateDiagram"],
          };
          const exp = expected[dtype] ?? [];
          if (exp.length > 0 && !exp.some((h) => firstLine.includes(h))) {
            issues.push(createIssue({ severity: "blocker", targetTaskId: taskId, targetTaskType: "diagrams", targetField: `diagrams.${dtype}`, description: `${dtype} 缺少正确的 Mermaid 头部`, suggestion: `在 ${dtype} 首行添加正确的 Mermaid 头部` }));
          }
          if (dtype === "class_diagram" && requirementJson) {
            const entityIssues = this._checkClassDiagramEntities(taskId, text, requirementJson);
            issues.push(...entityIssues);
          }
        }
        continue;
      }

      if (taskType === "tests") {
        if (skipMissingArtifact) continue;
        if (typeof content !== "string" || !(content as string).trim()) {
          issues.push(createIssue({ severity: "major", targetTaskId: taskId, targetTaskType: "tests", targetField: "test_cases", description: "测试用例为空", suggestion: "重新执行测试用例生成任务" }));
          continue;
        }
        try {
          for (const warning of TestCaseGenerator.validateTestCases(content as string, requirementJson)) {
            issues.push(createIssue({
              severity: "major", targetTaskId: taskId, targetTaskType: "tests",
              targetField: "test_cases", description: warning,
              suggestion: "补充对应功能 ID 的正常/异常/边界测试用例",
            }));
          }
        } catch (e) {
          issues.push(createIssue({ severity: "major", targetTaskId: taskId, targetTaskType: "tests", targetField: "test_cases", description: `测试用例规则校验失败: ${e instanceof Error ? e.message : String(e)}` }));
        }
      }
    }

    return issues;
  }

  private _checkClassDiagramEntities(
    taskId: string,
    mermaidText: string,
    requirementJson: Record<string, unknown>,
  ): Issue[] {
    const reqEntities = (requirementJson.entities ?? []) as Array<Record<string, unknown>>;
    if (!reqEntities || reqEntities.length === 0) return [];

    const expectedNames: string[] = [];
    for (const entity of reqEntities) {
      const name = String(entity.name ?? entity.ename ?? "").trim();
      if (!name) continue;
      // Skip Chinese characters — can't match Mermaid class names
      if (/[\u4e00-\u9fff]/.test(name)) continue;
      expectedNames.push(name);
    }
    if (expectedNames.length === 0) return [];

    const classRe = /class\s+(\w+)\s*\{/g;
    const diagramClasses = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = classRe.exec(mermaidText)) !== null) {
      diagramClasses.add(m[1]);
    }

    const missing = expectedNames.filter(
      (name) => !diagramClasses.has(name) && ![...diagramClasses].some((dc) => dc.includes(name)),
    );

    if (missing.length === 0) return [];

    return [createIssue({
      severity: "major",
      targetTaskId: taskId,
      targetTaskType: "diagrams",
      targetField: "diagrams.class_diagram",
      description: `类图缺少需求分析中的核心实体: ${missing.join(", ")}`,
      suggestion: `在类图中补充以下实体的类定义: ${missing.join(", ")}`,
    })];
  }

  // ------------------------------------------------------------------
  // LLM review
  // ------------------------------------------------------------------

  private async _llmReviewSnapshots(
    requirementText: string,
    snapshots: Record<string, Record<string, unknown>>,
    isDirectMode: boolean,
    reviewMode: string,
  ): Promise<[Issue[], number | null]> {
    const presentTypes = [...new Set(
      Object.values(snapshots)
        .map((s) => String(s.type ?? ""))
        .filter(Boolean),
    )];
    const artifactTypes = presentTypes.length > 0 ? presentTypes.join(", ") : "scoped";
    const system = await this._getSystemPrompt(`review ${reviewMode} ${artifactTypes}`);

    const reqLimit = reviewMode === "quick" ? 800 : 2000;
    const textLimit = reviewMode === "quick" ? 10000 : 16000;
    const diagramLimit = reviewMode === "quick" ? 3000 : 5000;

    const sections: string[] = [];
    if (requirementText) {
      sections.push(`## 原始需求\n${(requirementText ?? "").slice(0, reqLimit)}`);
    }

    for (const [taskId, snapshot] of Object.entries(snapshots)) {
      const taskType = String(snapshot.type ?? "");
      const content = snapshot.content;
      const allowedFields = [...this._allowedSnapshotFields(snapshot)].sort().join(", ");
      sections.push(`## 任务 ${taskId}\n类型: ${taskType}\n仅允许审查字段: ${allowedFields}`);

      if (taskType === "analyze" && typeof content === "object") {
        sections.push("```json\n" + JSON.stringify(content, null, 2).slice(0, textLimit) + "\n```");
      } else if (taskType === "diagrams" && typeof content === "object") {
        const snippet: Record<string, string> = {};
        for (const [k, v] of Object.entries(content as Record<string, unknown>)) {
          snippet[k] = String(v ?? "").slice(0, diagramLimit);
        }
        sections.push(JSON.stringify(snippet, null, 2).slice(0, Math.max(diagramLimit * 3, 1800)));
      } else {
        sections.push(String(content ?? "").slice(0, textLimit));
      }
    }

    if (sections.length === 0) return [[], null];

    let userPrompt = sections.join("\n\n");
    userPrompt += "\n\n请审查上述任务产物，指出需要修改的具体问题。输出 JSON，且每个 issue 必须使用准确的 target_task_id。绝对不要审查未提供的兄弟任务或未列出的字段。";
    if (reviewMode === "quick") {
      userPrompt += "\n这是 quick review。优先返回 blocker 和 major 问题；忽略纯措辞优化和跨任务一致性检查。";
    } else {
      userPrompt += "\n请同时检查跨任务一致性、覆盖完整性和结构缺口。";
    }
    if (isDirectMode) {
      userPrompt += "\n\n## 重要：这是 Direct 模式的局部审查\n只审查当前 task 的产物质量，不因缺少其他阶段产物而扣分。";
    }

    if (this.llm) this.llm.streamTag = `[Evaluator:${reviewMode}]`;
    const response = await this.llm!.generateJson(userPrompt, system);
    const issues = EvaluationTool._parseLlmIssues(response as Record<string, unknown>);
    return [issues, null];
  }

  private async _llmReviewAnalyze(
    requirementText: string,
    requirementJson: Record<string, unknown>,
  ): Promise<Issue[]> {
    const system = await this._getSystemPrompt("analyze:" + (requirementText ?? "").slice(0, 150));
    const reqTextShort = (requirementText ?? "").slice(0, 2000);
    const reqJsonStr = JSON.stringify(requirementJson ?? {}, null, 2).slice(0, 3000);
    const userPrompt = `## 原始需求\n${reqTextShort}\n\n## 需求分析结果\n\`\`\`json\n${reqJsonStr}\n\`\`\`\n\n请审查需求分析结果的完整性和准确性，输出 JSON 裁决。`;

    if (this.llm) this.llm.streamTag = "[Evaluator:analyze]";
    const response = await this.llm!.generateJson(userPrompt, system);
    return EvaluationTool._parseLlmIssues(response as Record<string, unknown>);
  }

  static _parseLlmIssues(response: Record<string, unknown>): Issue[] {
    if (!response || typeof response !== "object") return [];
    const raw = response.issues as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(raw)) return [];

    return raw
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null && !Array.isArray(r))
      .map((r) => createIssue({
        severity: String(r.severity ?? "major") as Issue["severity"],
        targetTaskId: String(r.target_task_id ?? ""),
        targetTaskType: String(r.target_task_type ?? ""),
        targetField: String(r.target_field ?? ""),
        description: String(r.description ?? ""),
        suggestion: String(r.suggestion ?? ""),
      }));
  }

  // ------------------------------------------------------------------
  // Fix task generation
  // ------------------------------------------------------------------

  static _buildFixes(issues: Issue[]): Task[] {
    if (issues.length === 0) return [];
    const grouped = new Map<string, Issue[]>();
    for (const issue of issues) {
      const tid = issue.targetTaskId || "unknown";
      if (!grouped.has(tid)) grouped.set(tid, []);
      grouped.get(tid)!.push(issue);
    }

    const fixes: Task[] = [];
    let counter = 0;
    for (const [taskId, taskIssues] of grouped) {
      counter++;
      const descParts: string[] = [];
      const suggestions: string[] = [];
      for (const iss of taskIssues) {
        descParts.push(`[${iss.severity}] ${iss.description}`);
        if (iss.suggestion) suggestions.push(iss.suggestion);
      }
      const taskType = EvaluationTool._inferTaskType(taskIssues);
      fixes.push(createTask({
        id: `${taskId}-fix-${counter}`,
        type: taskType as Task["type"],
        description: descParts.join("; "),
        dependsOn: [taskId],
        contextHints: {
          fix_instructions: suggestions,
          original_issues: taskIssues.map((i) => i.description),
        },
      }));
    }
    return fixes;
  }

  static _inferTaskType(issues: Issue[]): string {
    const explicitTypes = issues.map((i) => i.targetTaskType).filter(Boolean);
    if (explicitTypes.length > 0) return explicitTypes[0];
    for (const issue of issues) {
      const field = issue.targetField ?? "";
      if (field.includes("requirement_json")) return "analyze";
      if (field.includes("design_text")) return "design";
      if (field.includes("diagram")) return "diagrams";
      if (field.includes("test")) return "tests";
    }
    return "analyze";
  }

  static _buildSummary(passed: boolean, issues: Issue[]): string {
    if (passed) return "审查通过，无 blocker 问题。";
    const blockerCount = issues.filter((i) => i.severity === "blocker").length;
    const majorCount = issues.filter((i) => i.severity === "major").length;
    const minorCount = issues.filter((i) => i.severity === "minor").length;
    return `审查未通过。发现 ${issues.length} 个问题（blocker: ${blockerCount}, major: ${majorCount}, minor: ${minorCount}）。`;
  }

  // ------------------------------------------------------------------
  // Prompt
  // ------------------------------------------------------------------

  private async _getSystemPrompt(queryContext = ""): Promise<string> {
    if (this._systemPrompt === null || queryContext) {
      const prompt = await this._loadPromptWithConstitution("evaluator.md", "", queryContext);
      if (!queryContext) this._systemPrompt = prompt;
      return prompt;
    }
    return this._systemPrompt;
  }
}
