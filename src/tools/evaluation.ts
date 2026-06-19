/**
 * EvaluationTool — 评审产物，找出结构化问题，生成修复任务。
 * 规则检查（无 LLM）+ LLM 语义评审。异步 LLM 调用。
 */

import type { LLMClient } from "../llmClient.js";
import { BaseTool } from "./base.js";
import type { ToolCapabilities } from "./types.js";
import {
  type Issue, type IssueKind, type Task, type Verdict, type Scope,
  createIssue, createTask, createVerdict, isDesignModel,
} from "../shared/types.js";
import { SystemDesigner } from "../generators/design.js";
import { TestCaseGenerator } from "../generators/tests.js";
import { validateReview, type ReviewValidationResult } from "../shared/reviewValidator.js";
import { RequirementIndex } from "../shared/requirementIndex.js";
import { SYNTHETIC_TASK_IDS } from "../shared/taskConstants.js";
import { appendMemorySafely } from "../memory/promptMemory.js";
import { extractRelationEndpoints } from "../shared/mermaidRelations.js";


export class EvaluationTool extends BaseTool {
  constructor(llm: LLMClient) {
    super(llm);
  }

  get name(): string { return "EvaluationTool"; }

  get capabilities(): ToolCapabilities {
    return { requiresLlm: true, supportedTaskTypes: ["evaluate"] };
  }

  // --------------------------------------------------------------
  // 公开 API
  // --------------------------------------------------------------

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
    _previousIssues?: Array<{ severity: string; description: string; location?: string }>,
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

    // 1. 规则检查
    const ruleIssues = this._ruleCheckSnapshots(snapshots, isDirectMode, requirementJson);
    // Classify each rule issue defect vs advisory (deterministic, by content).
    for (const issue of ruleIssues) issue.kind = EvaluationTool._classifyIssueKind(issue);
    issues.push(...ruleIssues);
    this.logger.info(`evaluate: 规则检查发现 ${ruleIssues.length} 个问题`);

    // Targets a deterministic rule-check already proved defective — used to
    // corroborate (promote) LLM complaints about the same field.
    const ruleDefectTargets = new Set(
      ruleIssues
        .filter((issue) => issue.kind === "defect")
        .map((issue) => `${issue.targetTaskId}::${issue.targetField}`),
    );

    // 1.5 Review 前置门禁（确定性验证）
    const snapDesignText = EvaluationTool._extractDesignText(snapshots);
    const snapTestCasesText = EvaluationTool._extractTestCasesText(snapshots);
    const reviewValidation = validateReview(requirementJson, snapDesignText, snapTestCasesText);
    if (!reviewValidation.passed) {
      this.logger.info(`evaluate: review 前置门禁未通过 — ${reviewValidation.checks.filter((c) => !c.passed).map((c) => c.name).join(", ")}`);
    }

    // 2. LLM 评审
    let llmIssues: Issue[];
    const reviewMode = EvaluationTool._selectReviewMode(snapshots, isDirectMode, goal);
    if (EvaluationTool._shouldSkipAnalyzeShardLlmReview(snapshots, goal)) {
      this.logger.info("evaluate: 跳过 analyze 分片的 LLM 语义评审，仅保留规则检查");
      llmIssues = [];
    } else if (Object.keys(snapshots).length > 0) {
      const [li] = await this._llmReviewSnapshots(requirementText, snapshots, isDirectMode, reviewMode, reviewValidation);
      llmIssues = li;
    } else if (goal.toLowerCase().includes("analyze")) {
      llmIssues = await this._llmReviewAnalyze(requirementText, requirementJson);
    } else {
      llmIssues = [];
    }
    llmIssues = this._filterSnapshotIssues(llmIssues, snapshots);
    // Classify LLM issues: advisory unless they match a defect signature or are
    // corroborated by a rule-check defect on the same field. The LLM's own
    // severity label is NOT trusted to drive control flow.
    for (const issue of llmIssues) {
      issue.kind = EvaluationTool._classifyLlmIssueKind(issue, ruleDefectTargets);
    }
    issues.push(...llmIssues);
    EvaluationTool._mapSyntheticFinalIssuesToSources(issues, snapshots);

    // 分类范围
    for (const issue of issues) EvaluationTool._classifyIssueScope(issue);

    // 3. 判断通过/失败 — gate on verifiable DEFECTS, not raw severity. Advisories
    // (completeness/coverage opinions) never block acceptance or trigger repair.
    const defects = issues.filter((i) => i.kind === "defect");
    const blockers = defects.filter((i) => i.severity === "blocker");
    const majors = issues.filter((i) => i.severity === "major");
    const advisories = issues.filter((i) => i.kind === "advisory");
    const passed = blockers.length === 0;
    this.logger.info(`evaluate: 评审完成，passed=${passed}，blockers=${blockers.length}，defects=${defects.length}，majors=${majors.length}，advisories=${advisories.length}，minors=${issues.filter((i) => i.severity === "minor").length}`);

    // 4. 构建修复任务 — only for defects; advisories are recorded, not repaired.
    const fixes = passed ? [] : EvaluationTool._buildFixes(defects);

    // Log all issues for observability
    for (const iss of issues) {
      this.logger.info(`evaluate: issue [${iss.severity}] ${iss.targetTaskId} ${iss.targetField} | ${iss.description}`);
    }

    // Build evaluated_revisions
    const evaluatedRevisions: Record<string, number> = {};
    for (const [tid, snapshot] of Object.entries(snapshots)) {
      const revision = Number((snapshot as Record<string, unknown>).revision ?? 0);
      evaluatedRevisions[tid] = revision;
      const sourceRevisions = (snapshot as Record<string, unknown>).sourceRevisions;
      if (sourceRevisions && typeof sourceRevisions === "object" && !Array.isArray(sourceRevisions)) {
        for (const [sourceTaskId, sourceRevision] of Object.entries(sourceRevisions as Record<string, unknown>)) {
          evaluatedRevisions[sourceTaskId] = Number(sourceRevision ?? 0);
        }
      }
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

  // --------------------------------------------------------------
  // 规则检查（无 LLM）
  // --------------------------------------------------------------

  /**
   * Deterministic defect signatures — text that means the artifact is WRONG
   * (hallucinated/undefined references, broken syntax, contradictions, bad
   * mappings), as opposed to merely incomplete. Matching is content-based so it
   * works regardless of whether the issue came from a rule-check or the LLM, and
   * regardless of the (untrustworthy) severity label the LLM assigned.
   */
  static readonly _DEFECT_SIGNATURE =
    /未定义|不存在|未在需求中|引用了错误类型|使用了内部\s*ID|语义未匹配|为空|格式错误|无法渲染|缺少正确的\s*Mermaid|\[object Object\]|矛盾|冲突|映射错误|hallucinat|undefined (?:id|reference)|not defined|does not exist|cannot render/i;

  /**
   * Classify an issue as a verifiable defect or an advisory. Blockers are always
   * defects (a blocker means the artifact is unusable). Otherwise an issue is a
   * defect only if its description matches a defect signature; everything else
   * (coverage gaps, completeness/precision opinions) is advisory and will not
   * drive repair/replan.
   */
  static _classifyIssueKind(issue: Issue): IssueKind {
    if (issue.severity === "blocker") return "defect";
    return EvaluationTool._DEFECT_SIGNATURE.test(issue.description)
      ? "defect"
      : "advisory";
  }

  /**
   * Classify an LLM-reported issue. Same signature test as rule issues, plus
   * corroboration: if a deterministic rule-check already flagged a defect on the
   * same target field, an LLM complaint about that field is almost certainly
   * describing the same real defect, so promote it even if its wording misses
   * the signature.
   */
  static _classifyLlmIssueKind(issue: Issue, ruleDefectTargets: Set<string>): IssueKind {
    if (EvaluationTool._classifyIssueKind(issue) === "defect") return "defect";
    if (ruleDefectTargets.has(`${issue.targetTaskId}::${issue.targetField}`)) {
      return "defect";
    }
    return "advisory";
  }

  static _classifyIssueScope(issue: Issue): Scope {
    if (issue.targetTaskType === "analyze" && issue.severity === "blocker") {
      issue.scope = "systemic";
    } else if (issue.targetField.startsWith("requirement_json.") && issue.targetTaskType === "analyze") {
      // 仅对 requirement_json 有问题的分析任务视为真正的上游问题
      issue.scope = "upstream";
    } else {
      // 设计/图表/测试问题引用需求字段属于本地问题（可通过修补产物修复）
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

  /** Extract design text from snapshots for validation. */
  static _extractDesignText(snapshots: Record<string, Record<string, unknown>>): string {
    for (const snapshot of Object.values(snapshots)) {
      if (String(snapshot.type ?? "") === "design") {
        return EvaluationTool._snapshotText(snapshot);
      }
    }
    return "";
  }

  /** Extract test cases text from snapshots for validation. */
  static _extractTestCasesText(snapshots: Record<string, Record<string, unknown>>): string {
    for (const snapshot of Object.values(snapshots)) {
      if (String(snapshot.type ?? "") === "tests") {
        const content = snapshot.content;
        if (typeof content === "string") return content;
        if (typeof content === "object" && content !== null) return JSON.stringify(content);
      }
    }
    return "";
  }

  static _snapshotText(snapshot: Record<string, unknown>): string {
    const taskType = String(snapshot.type ?? "");
    const content = snapshot.content;
    if (taskType === "design" && isDesignModel(content)) {
      return SystemDesigner.renderDesignMarkdown(content);
    }
    if (typeof content === "string") return content;
    if (typeof content === "object" && content !== null) {
      return JSON.stringify(content);
    }
    return String(content ?? "");
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

  static _shouldSkipAnalyzeShardLlmReview(
    snapshots: Record<string, Record<string, unknown>>,
    goal: string,
  ): boolean {
    const entries = Object.entries(snapshots);
    if (entries.length <= 1) return false;
    if (goal.toLowerCase().includes("analyze")) return false;
    return entries.every(([taskId, snapshot]) => {
      if (String(snapshot.type ?? "") !== "analyze") return false;
      return taskId !== SYNTHETIC_TASK_IDS.ANALYZE_FINAL && taskId !== SYNTHETIC_TASK_IDS.ANALYZE_COMPREHENSIVE;
    });
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
      const diagrams = EvaluationTool._diagramContent(content);
      if (diagrams) {
        for (const key of Object.keys(diagrams)) {
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
      if (!snapshot) {
        // taskId 为空时（LLM 未指定目标）保留 issue；非空时说明 LLM 幻觉了一个不存在的 ID，丢弃。
        if (!taskId) filtered.push(issue);
        continue;
      }

      issue.targetTaskId = taskId;
      issue.targetTaskType = String(snapshot.type ?? "");
      EvaluationTool._mapSyntheticFinalIssueToSource(issue, snapshot);

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

  private static _mapSyntheticFinalIssueToSource(
    issue: Issue,
    snapshot: Record<string, unknown>,
  ): void {
    const taskId = issue.targetTaskId;
    if (!taskId.endsWith("-final")) return;

    const sourceTaskIds = Array.isArray(snapshot.sourceTaskIds)
      ? snapshot.sourceTaskIds.map((item) => String(item)).filter(Boolean)
      : [];
    const sourceRevisions = snapshot.sourceRevisions;
    const sourceFromRevisions = sourceRevisions && typeof sourceRevisions === "object" && !Array.isArray(sourceRevisions)
      ? Object.keys(sourceRevisions as Record<string, unknown>)
      : [];

    const sources = sourceTaskIds.length > 0 ? sourceTaskIds : sourceFromRevisions;
    if (sources.length === 0) return;

    if (taskId === SYNTHETIC_TASK_IDS.DIAGRAMS_FINAL) {
      const field = issue.targetField;
      const wanted = field.includes("class") ? "class" : field.includes("activity") ? "activity" : field.includes("state") ? "state" : "";
      const matched = wanted
        ? sources.find((source) => source.toLowerCase().includes(wanted) || source.includes("类图") || source.includes("活动") || source.includes("状态"))
        : "";
      issue.targetTaskId = matched || sources[0];
      return;
    }

    if (taskId === SYNTHETIC_TASK_IDS.ANALYZE_FINAL) {
      // Try to match the issue to the correct analyze shard by inspecting
      // entity names or function IDs in the issue description
      const desc = issue.description ?? "";
      const shardContent = snapshot.content;
      if (sources.length > 1 && typeof shardContent === "object" && shardContent !== null) {
        // Extract entity names / function IDs from issue description
        const entityRe = /\b([A-Z][a-zA-Z0-9]+)\b/g;
        const fnIdRe = /\b(F\d{1,4})\b/g;
        const mentionedEntities = new Set<string>();
        const mentionedFnIds = new Set<string>();
        let m: RegExpExecArray | null;
        while ((m = entityRe.exec(desc)) !== null) mentionedEntities.add(m[1]);
        while ((m = fnIdRe.exec(desc)) !== null) mentionedFnIds.add(m[1]);

        // Score each source shard by relevance
        let bestSource = sources[0];
        let bestScore = 0;
        for (const source of sources) {
          let score = 0;
          // Check if this source has a snapshot in the context
          const sourceSnap = (snapshot as Record<string, unknown>).__sourceSnapshots
            ? ((snapshot as Record<string, unknown>).__sourceSnapshots as Record<string, Record<string, unknown>>)[source]
            : undefined;
          if (sourceSnap?.content && typeof sourceSnap.content === "object") {
            const srcContent = sourceSnap.content as Record<string, unknown>;
            const srcEntities = Array.isArray(srcContent.entities)
              ? (srcContent.entities as Array<Record<string, unknown>>)
              : [];
            for (const ent of srcEntities) {
              if (mentionedEntities.has(String(ent.name ?? ""))) score += 2;
            }
            const srcFunctions = Array.isArray(srcContent.functions)
              ? (srcContent.functions as Array<Record<string, unknown>>)
              : [];
            for (const fn of srcFunctions) {
              if (mentionedFnIds.has(String(fn.id ?? ""))) score += 3;
            }
          }
          // Fallback: check if source ID contains relevant keywords
          const sourceLower = source.toLowerCase();
          for (const entity of mentionedEntities) {
            if (sourceLower.includes(entity.toLowerCase())) score += 1;
          }
          if (score > bestScore) {
            bestScore = score;
            bestSource = source;
          }
        }
        if (bestScore > 0) {
          issue.targetTaskId = bestSource;
        }
      } else {
        issue.targetTaskId = sources[0];
      }
    }
  }

  private static _mapSyntheticFinalIssuesToSources(
    issues: Issue[],
    snapshots: Record<string, Record<string, unknown>>,
  ): void {
    for (const issue of issues) {
      const snapshot = snapshots[issue.targetTaskId];
      if (!snapshot) continue;
      EvaluationTool._mapSyntheticFinalIssueToSource(issue, snapshot);
    }
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
        const isEmpty = content === null || content === undefined ||
          (typeof content === "string" && !content.trim());
        if (isEmpty) {
          issues.push(createIssue({ severity: "blocker", targetTaskId: taskId, targetTaskType: "design", targetField: "design_text", description: "系统设计文档为空", suggestion: "重新执行设计生成任务" }));
        } else if (isDesignModel(content)) {
          for (const warning of SystemDesigner.validateDesignModel(content, requirementJson)) {
            issues.push(createIssue({
              severity: "major",
              targetTaskId: taskId,
              targetTaskType: "design",
              targetField: "design_text",
              description: warning,
              suggestion: "补充对应模块、实体或章节，并保持与需求一致",
            }));
          }
          const rendered = SystemDesigner.renderDesignMarkdown(content);
          issues.push(
            ...this._checkUndefinedExceptionIds(taskId, "design", "design_text", rendered, requirementJson),
          );
        } else {
          const textContent = typeof content === "object"
            ? JSON.stringify(content, null, 2)
            : String(content);
          for (const warning of SystemDesigner.validateDesign(textContent, requirementJson)) {
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
          issues.push(
            ...this._checkUndefinedExceptionIds(taskId, "design", "design_text", textContent, requirementJson),
          );
        }
        continue;
      }

      if (taskType === "diagrams") {
        const c = EvaluationTool._diagramContent(content);
        if (!c || Object.keys(c).length === 0) {
          issues.push(createIssue({ severity: "blocker", targetTaskId: taskId, targetTaskType: "diagrams", targetField: "diagrams", description: "图表为空或格式错误", suggestion: "重新执行图表生成任务" }));
          continue;
        }
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
          if (/<br\s*\/?>/i.test(text)) {
            issues.push(createIssue({
              severity: "minor",
              targetTaskId: taskId,
              targetTaskType: "diagrams",
              targetField: `diagrams.${dtype}`,
              description: `${dtype} 包含 HTML 换行标签 <br/>，可能导致部分 Mermaid 渲染器不兼容`,
              suggestion: "移除 HTML 标签，改用纯文本分隔符或更短节点标签",
            }));
          }
          if (dtype === "class_diagram" && requirementJson) {
            const entityIssues = this._checkClassDiagramEntities(taskId, text, requirementJson);
            issues.push(...entityIssues);
          }
          issues.push(
            ...this._checkUndefinedExceptionIds(
              taskId,
              "diagrams",
              `diagrams.${dtype}`,
              text,
              requirementJson,
            ),
          );
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
          issues.push(...this._checkUndefinedExceptionIds(
            taskId,
            "tests",
            "test_cases",
            content as string,
            requirementJson,
          ));
        } catch (e) {
          issues.push(createIssue({ severity: "major", targetTaskId: taskId, targetTaskType: "tests", targetField: "test_cases", description: `测试用例规则校验失败: ${e instanceof Error ? e.message : String(e)}` }));
        }
      }
    }

    // 跨产物实体命名一致性检查
    issues.push(...this._checkCrossArtifactNaming(snapshots, requirementJson));

    // 跨产物功能 ID 一致性检查
    issues.push(...this._checkFunctionIdConsistency(snapshots, requirementJson));

    // 跨产物约束边界测试覆盖率检查
    issues.push(...this._checkConstraintBoundaryCoverage(snapshots, requirementJson));

    // 跨产物业务流程在活动图中的覆盖率检查
    issues.push(...this._checkBusinessProcessCoverage(snapshots, requirementJson));

    return issues;
  }

  private _checkCrossArtifactNaming(
    snapshots: Record<string, Record<string, unknown>>,
    requirementJson: Record<string, unknown>,
  ): Issue[] {
    const issues: Issue[] = [];
    const entities = (requirementJson.entities ?? []) as Array<Record<string, unknown>>;
    if (entities.length === 0) return issues;

    // 从需求分析中构建规范的实体名集合（normalized -> original）
    const entityNames = new Map<string, string>(); // normalized -> original
    for (const entity of entities) {
      const name = String(entity.name ?? "").trim();
      if (!name || /[\u4e00-\u9fff]/.test(name)) continue;
      const normalized = name.toLowerCase().replace(/[_\-\s]/g, "");
      entityNames.set(normalized, name);
    }
    if (entityNames.size === 0) return issues;

    // 检查设计文本中是否有重命名的实体
    for (const [taskId, snapshot] of Object.entries(snapshots)) {
      const taskType = String(snapshot.type ?? "");
      if (taskType !== "design") continue;
      const content = EvaluationTool._snapshotText(snapshot);
      if (!content) continue;

      // Extract class names from design text (Markdown table rows)
      const tableClassRe = /\|\s*\*\*([\w]+)\*\*\s*\|/g;
      const designClasses = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = tableClassRe.exec(content)) !== null) {
        designClasses.add(m[1]);
      }

      // Check if any requirement entity is missing and a similar name exists
      for (const [normalized, original] of entityNames) {
        const found = [...designClasses].some((dc) => dc.toLowerCase().replace(/[_\-\s]/g, "") === normalized) ||
          new RegExp(`\\b${this._escapeRegex(original)}\\b`).test(content);
        if (!found) {
          // Check if a renamed version exists (singular/plural, synonym)
          const similarInDesign = [...designClasses].filter((dc) => {
            const dcNorm = dc.toLowerCase().replace(/[_\-\s]/g, "");
            // Detect renames: original appears as substring of design name (suffix-based rename)
            // e.g. Promotion -> PromotionRule, AuditLog -> OperationLog
            if (dcNorm.includes(normalized) || normalized.includes(dcNorm)) {
              // Same name is OK (exact match), only flag actual renames
              return dcNorm !== normalized;
            }
            // Also detect near-match renames (e.g. AuditLog -> OperationLog)
            // Check if they share a significant common suffix/prefix
            const minLen = Math.min(dcNorm.length, normalized.length);
            if (minLen < 3) return false;
            let commonChars = 0;
            for (let i = 0; i < Math.min(dcNorm.length, normalized.length); i++) {
              if (dcNorm[i] === normalized[i]) commonChars++;
            }
            return commonChars / minLen >= 0.75 && Math.abs(dcNorm.length - normalized.length) <= 4;
          });
          if (similarInDesign.length > 0) {
            issues.push(createIssue({
              severity: "major",
              targetTaskId: taskId,
              targetTaskType: "design",
              targetField: "design_text",
              description: "实体命名不一致: 需求分析中为 '" + original + "'，设计中使用了 '" + similarInDesign.join("', '") + "'",
              suggestion: "统一使用需求分析中的实体名 '" + original + "'，或在文档中说明改名原因",
            }));
          }
        }
      }
    }

    // Check class diagram entity names vs requirement entities
    for (const [taskId, snapshot] of Object.entries(snapshots)) {
      const taskType = String(snapshot.type ?? "");
      if (taskType !== "diagrams") continue;
      const content = EvaluationTool._diagramContent(snapshot.content);
      if (!content) continue;
      const classDiagram = String(content.class_diagram ?? "");
      if (!classDiagram) continue;

      const classRe = /class\s+(\w+)\s*\{/g;
      const diagramClasses = new Set<string>();
      let dm: RegExpExecArray | null;
      while ((dm = classRe.exec(classDiagram)) !== null) {
        diagramClasses.add(dm[1]);
      }

      for (const [normalized, original] of entityNames) {
        const found = diagramClasses.has(original) ||
          [...diagramClasses].some((dc) => dc.toLowerCase().replace(/[_\-\s]/g, "") === normalized);
        if (!found) {
          const similar = [...diagramClasses].filter((dc) => {
            const dcNorm = dc.toLowerCase().replace(/[_\-\s]/g, "");
            if (Math.abs(dcNorm.length - normalized.length) > 4) return false;
            return dcNorm.includes(normalized) || normalized.includes(dcNorm);
          });
          if (similar.length > 0) {
            issues.push(createIssue({
              severity: "major",
              targetTaskId: taskId,
              targetTaskType: "diagrams",
              targetField: "diagrams.class_diagram",
              description: "类图实体命名不一致: 需求分析中为 '" + original + "'，类图中使用了 '" + similar.join("', '") + "'",
              suggestion: "统一使用需求分析中的实体名 '" + original + "'",
            }));
          }
        }
      }
    }

    return issues;
  }

  private _escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * 检查设计/测试中引用的所有功能 ID 是否在分析中存在。
   * 标记"幽灵 ID"——下游任务中虚构的 ID。
   */
  /**
   * 检查活动图是否覆盖了分析中的所有业务流程。
   */
  private _checkBusinessProcessCoverage(
    snapshots: Record<string, Record<string, unknown>>,
    requirementJson: Record<string, unknown>,
  ): Issue[] {
    const issues: Issue[] = [];
    const processes = (Array.isArray(requirementJson.business_processes)
      ? requirementJson.business_processes as Array<Record<string, unknown>>
      : []);
    if (processes.length <= 1) return issues;

    // Find activity diagram snapshot
    for (const [taskId, snapshot] of Object.entries(snapshots)) {
      const taskType = String(snapshot.type ?? "");
      if (taskType !== "diagrams") continue;
      const content = snapshot.content;
      const diagrams = EvaluationTool._diagramContent(content);
      if (!diagrams) continue;
      const activityDiagram = String(diagrams.activity_diagram ?? "");
      if (!activityDiagram) continue;

      // Check which process names (or recognizable keywords) appear in the activity diagram
      const missing: string[] = [];
      const adLower = activityDiagram.toLowerCase();

      for (const proc of processes) {
        const name = String(proc.name ?? "").trim();
        if (!name) continue;

        // Source 1: PascalCase keywords from process name (works for English diagrams)
        const nameKeywords = name.replace(/([a-z])([A-Z])/g, "$1 $2").split(/(?=[A-Z])/).join(" ").toLowerCase().split(/\s+/);
        const mainNameKeywords = nameKeywords.filter(k => k.length > 3);

        // Source 2: Chinese keywords from process steps (works for Chinese diagrams)
        const steps = Array.isArray(proc.steps) ? proc.steps as string[] : [];
        const stepKeywords = steps.map(s => String(s).trim()).filter(s => s.length >= 2);

        // Try name keywords first
        let found = mainNameKeywords.length > 0 && mainNameKeywords.some(kw => adLower.includes(kw));

        // If name keywords didn't match, try step keywords
        if (!found && stepKeywords.length > 0) {
          // A process is considered "covered" if >= 40% of its steps appear in the diagram
          const matched = stepKeywords.filter(step => adLower.includes(step.toLowerCase()));
          found = matched.length >= Math.ceil(stepKeywords.length * 0.4);
        }

        if (!found) {
          missing.push(name);
        }
      }

      if (missing.length > 0) {
        issues.push(createIssue({
          severity: "major",
          targetTaskId: taskId,
          targetTaskType: "diagrams",
          targetField: "diagrams.activity_diagram",
          description: `活动图未覆盖业务流程: ${missing.join(", ")}`,
          suggestion: `活动图应至少包含以下业务流程的完整路径: ${missing.join(", ")}`,
        }));
      }
    }

    return issues;
  }

  private _checkFunctionIdConsistency(
    snapshots: Record<string, Record<string, unknown>>,
    requirementJson: Record<string, unknown>,
  ): Issue[] {
    const issues: Issue[] = [];
    const functions = (Array.isArray(requirementJson.functions)
      ? requirementJson.functions as Array<Record<string, unknown>>
      : []);
    const analysisIds = new Set(
      functions.flatMap((f) => [f.displayId, f.id])
        .map((id) => String(id ?? "").trim())
        // Keep both display (F001) and canonical (FUN_xxx) forms, matching
        // RequirementIndex.allowedIds (requirementIndex.ts).
        .filter((id) => /^F\d+$/.test(id) || /^FUN_/.test(id)),
    );
    if (analysisIds.size === 0) return issues;

    for (const [taskId, snapshot] of Object.entries(snapshots)) {
      const taskType = String(snapshot.type ?? "");
      // Only check design and test artifacts
      if (taskType !== "design" && taskType !== "tests") continue;

      const content = EvaluationTool._snapshotText(snapshot);
      if (!content) continue;

      // Extract all Fxxx / FUN_xxx IDs from downstream artifact. FUN_xxx is
      // included so canonical-form references are also checked for ghosts,
      // consistent with RequirementIndex.ID_RE.
      const idRe = /\b(F\d{1,4}|FUN_[A-Za-z0-9_]+)\b/g;
      const referencedIds = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = idRe.exec(content)) !== null) {
        referencedIds.add(m[1]);
      }

      // Find ghost IDs
      const ghostIds = [...referencedIds].filter(id => !analysisIds.has(id));
      if (ghostIds.length > 0) {
        issues.push(createIssue({
          severity: "major",
          targetTaskId: taskId,
          targetTaskType: taskType,
          targetField: taskType === "design" ? "design_text" : "test_cases",
          description: `功能ID不一致: ${taskType === "design" ? "设计文档" : "测试用例"}中引用了分析中不存在的功能ID: ${ghostIds.join(", ")}`,
          suggestion: `移除或替换这些ID: ${ghostIds.join(", ")}。分析中存在的功能ID: ${[...analysisIds].sort().join(", ")}`,
        }));
      }
    }

    return issues;
  }

  private _checkConstraintBoundaryCoverage(
    snapshots: Record<string, Record<string, unknown>>,
    requirementJson: Record<string, unknown>,
  ): Issue[] {
    const issues: Issue[] = [];
    const constraints = (requirementJson.constraints ?? []) as Array<Record<string, unknown>>;
    if (constraints.length === 0) return issues;

    // Find test snapshots
    const testSnapshots = Object.entries(snapshots).filter(
      ([, s]) => String(s.type ?? "") === "tests",
    );
    if (testSnapshots.length === 0) return issues;

    for (const [taskId, snapshot] of testSnapshots) {
      const content = String(snapshot.content ?? "");
      if (!content) continue;

      const uncovered: Array<{ id: string; text: string }> = [];
      for (const constraint of constraints) {
        const cid = String(constraint.displayId ?? constraint.id ?? "").trim();
        if (!cid) continue;
        const covered = new RegExp(`\\b${cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(content);
        if (!covered) {
          const text = String(
            constraint.source_text ??
            constraint.sourceText ??
            constraint.description ??
            "",
          ).trim();
          uncovered.push({ id: cid, text });
        }
      }

      if (uncovered.length === 0) continue;
      const uncoveredLabels = uncovered.map((item) =>
        item.text ? `${item.id}(${item.text})` : item.id,
      );

      // Merge all uncovered constraints into a single issue so the repair LLM
      // can fix all of them in one call, and the issue count stays ≤ convergence threshold.
      issues.push(createIssue({
        severity: "major",
        targetTaskId: taskId,
        targetTaskType: "tests",
        targetField: "test_cases",
        description: `${uncovered.length} 个约束未被测试用例覆盖: ${uncoveredLabels.join(", ")}`,
        suggestion: `为以下每个约束各添加至少一个边界测试用例，target 必须使用 C 编号和当前约束文本，不要使用 CON_* canonicalId: ${uncoveredLabels.join(", ")}`,
      }));
    }

    return issues;
  }

  private _checkUndefinedExceptionIds(
    taskId: string,
    taskType: string,
    targetField: string,
    text: string,
    requirementJson: Record<string, unknown>,
  ): Issue[] {
    const requirementIndex = RequirementIndex.fromRequirementJson(requirementJson);
    if (requirementIndex.exceptions.length === 0) return [];

    // Dynamically derive prefixes from actual exception IDs — same logic as GenerationTool.
    const prefixes = new Set<string>();
    for (const ref of requirementIndex.exceptions) {
      for (const id of [ref.displayId, ref.canonicalId]) {
        const match = /^([A-Z]+_?)/.exec(id);
        if (match) prefixes.add(match[1]);
      }
    }
    const prefixList = [...prefixes];
    if (prefixList.length === 0) return [];

    const referenced = requirementIndex.extractIds(text)
      .filter((id) => prefixList.some((prefix) => id.startsWith(prefix)));
    const unknown = requirementIndex.unknownReferences(referenced);
    if (unknown.length === 0) return [];

    return [createIssue({
      severity: "major",
      targetTaskId: taskId,
      targetTaskType: taskType,
      targetField,
      description: `产物引用了未定义的异常 ID: ${unknown.join(", ")}`,
      suggestion: `只引用 requirement_json.exceptions 中已定义的异常 ID: ${requirementIndex.idsFor("exception", "both").sort().join(", ")}`,
    })];
  }

  private _checkClassDiagramEntities(
    taskId: string,
    mermaidText: string,
    requirementJson: Record<string, unknown>,
  ): Issue[] {
    const reqEntities = (requirementJson.entities ?? []) as Array<Record<string, unknown>>;

    const expectedNames: string[] = [];
    if (Array.isArray(reqEntities)) {
      for (const entity of reqEntities) {
        const name = String(entity.name ?? entity.ename ?? "").trim();
        if (!name) continue;
        // Skip Chinese characters — can't match Mermaid class names
        if (/[\u4e00-\u9fff]/.test(name)) continue;
        expectedNames.push(name);
      }
    }

    const classRe = /class\s+(\w+)\s*\{/g;
    const diagramClasses = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = classRe.exec(mermaidText)) !== null) {
      diagramClasses.add(m[1]);
    }

    const issues: Issue[] = [];

    // Missing entities: required entities not defined in the diagram.
    // Use a precise set membership check (not a fuzzy `.includes` substring,
    // which let e.g. "User" hide inside "UserAccount").
    const missing = expectedNames.filter((name) => !diagramClasses.has(name));

    if (missing.length > 0) {
      issues.push(createIssue({
        severity: "major",
        targetTaskId: taskId,
        targetTaskType: "diagrams",
        targetField: "diagrams.class_diagram",
        description: `类图缺少需求分析中的核心实体: ${missing.join(", ")}`,
        suggestion: `在类图中补充以下实体的类定义: ${missing.join(", ")}`,
      }));
    }

    // Dangling relationship endpoints: any relationship line that references
    // a class which has no `class X {}` definition block. This catches
    // associations (`"1" --> "*"`) that slipped past the inheritance-only
    // checks. Mirrors the mermaid.ts semantic check so the evaluator can
    // emit an actionable issue with the canonical phrasing the repair tool
    // routes on (see _trySingleDeterministicFix).
    const dangling = extractRelationEndpoints(mermaidText)
      .filter((name) => !diagramClasses.has(name));
    if (dangling.length > 0) {
      issues.push(createIssue({
        severity: "major",
        targetTaskId: taskId,
        targetTaskType: "diagrams",
        targetField: "diagrams.class_diagram",
        description: `类图关系引用了未定义的类: ${dangling.join(", ")}`,
        suggestion: `为以下关系端点补充 \`class X {}\` 定义块，或删除引用该类的关系行: ${dangling.join(", ")}`,
      }));
    }

    return issues;
  }

  // --------------------------------------------------------------
  // LLM 评审
  // --------------------------------------------------------------

  private async _llmReviewSnapshots(
    requirementText: string,
    snapshots: Record<string, Record<string, unknown>>,
    isDirectMode: boolean,
    reviewMode: string,
    validationResult?: ReviewValidationResult,
  ): Promise<[Issue[], number | null]> {
    const presentTypes = [...new Set(
      Object.values(snapshots)
        .map((s) => String(s.type ?? ""))
        .filter(Boolean),
    )];
    const artifactTypes = presentTypes.length > 0 ? presentTypes.join(", ") : "scoped";
    const system = await (async () => {
      const base = await this._getSystemPrompt("evaluator.md", "", `review ${reviewMode} ${artifactTypes}`);
      const queryCtx = `evaluate ${reviewMode}: ${Object.keys(snapshots).join(", ")}`;
      return appendMemorySafely("evaluator", base, queryCtx);
    })();

    // 覆盖性评审必须看到足够多的需求原文，否则就是盲审。
    // quick 模式给小预算，full 模式给大预算（中文 1 字符 ≈ 1 token，
    // full 模式总输入约 30k tokens，主流模型 64k+ 上下文可容纳）。
    const reqLimit = reviewMode === "quick" ? 4000 : 12000;
    const textLimit = reviewMode === "quick" ? 10000 : 16000;
    const diagramLimit = reviewMode === "quick" ? 3000 : 5000;

    const sections: string[] = [];
    if (requirementText) {
      sections.push(`## 原始需求\n${EvaluationTool._requirementForReview(requirementText, reqLimit)}`);
    }

    // NOTE: previousIssues injection removed — LLM evaluators tend to parrot
    // previous issues instead of independently reviewing current artifacts.
    // Each evaluation round now performs a blind review.

    // Inject review validation results as supplementary context
    if (validationResult && !validationResult.passed) {
      const failedChecks = validationResult.checks.filter((c) => !c.passed);
      const validationSection = [
        "## 前置门禁结果（确定性检查，仅供参考）",
        "以下检查未通过，请在评审时特别关注：",
        ...failedChecks.map((c) => `- [✗] ${c.name}: ${c.detail}`),
        "",
      ].join("\n");
      sections.push(validationSection);
    }

    for (const [taskId, snapshot] of Object.entries(snapshots)) {
      const taskType = String(snapshot.type ?? "");
      const content = snapshot.content;
      const allowedFields = [...this._allowedSnapshotFields(snapshot)].sort().join(", ");
      sections.push(`## 任务 ${taskId}\n类型: ${taskType}\n仅允许审查字段: ${allowedFields}`);

      if (taskType === "analyze" && typeof content === "object") {
        sections.push(
          "以下是合法 JSON 评审摘要；`__review_truncated__` 表示仅为控制提示长度而省略，不能据此判定源产物缺失。\n" +
          "```json\n" + EvaluationTool._jsonForReview(content, textLimit) + "\n```",
        );
      } else if (taskType === "diagrams" && typeof content === "object") {
        const snippet: Record<string, string> = {};
        for (const [k, v] of Object.entries(content as Record<string, unknown>)) {
          snippet[k] = EvaluationTool._truncateTextForReview(String(v ?? ""), diagramLimit);
        }
        sections.push(
          "以下是合法 JSON 评审摘要；`__review_truncated__` 表示仅为控制提示长度而省略，不能据此判定源产物缺失。\n" +
          "```json\n" + EvaluationTool._jsonForReview({ diagrams: snippet }, Math.max(diagramLimit * 3, 1800)) + "\n```",
        );
      } else {
        sections.push(EvaluationTool._truncateTextForReview(
          EvaluationTool._snapshotText(snapshot),
          textLimit,
        ));
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

    const response = await this.llm.runWithStreamTagContext(`[Evaluator:${reviewMode}]`, "", () =>
      this.llm.generateJson(userPrompt, system)
    );
    const issues = EvaluationTool._parseLlmIssues(response as Record<string, unknown>);
    return [issues, null];
  }

  private async _llmReviewAnalyze(
    requirementText: string,
    requirementJson: Record<string, unknown>,
  ): Promise<Issue[]> {
    const system = await (async () => {
      const base = await this._getSystemPrompt("evaluator.md", "", "analyze:" + (requirementText ?? "").slice(0, 150));
      return appendMemorySafely("evaluator", base, `analyze: ${(requirementText ?? "").slice(0, 150)}`);
    })();
    // 完整性审查不能只看前 2000 字符；JSON 硬切会产生残缺片段误导评审，
    // 改用 _jsonForReview 自适应摘要（始终输出合法 JSON）。
    const reqTextShort = EvaluationTool._requirementForReview(requirementText ?? "", 12000);
    const reqJsonStr = EvaluationTool._jsonForReview(requirementJson ?? {}, 16000);
    const userPrompt = `## 原始需求\n${reqTextShort}\n\n## 需求分析结果\n\`\`\`json\n${reqJsonStr}\n\`\`\`\n\n请审查需求分析结果的完整性和准确性，输出 JSON 裁决。`;

    const response = await this.llm.runWithStreamTagContext("[Evaluator:analyze]", "", () =>
      this.llm.generateJson(userPrompt, system)
    );
    return EvaluationTool._parseLlmIssues(response as Record<string, unknown>);
  }

  static _parseLlmIssues(response: Record<string, unknown>): Issue[] {
    if (!response || typeof response !== "object") return [];
    const raw = response.issues as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(raw)) return [];

    return raw
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null && !Array.isArray(r))
      .map((r) => {
        // scope 用于 policy 判定 final-major 问题能否安全地本地修复
        // （upstream/systemic 会被排除出本地修复目标）。非法值归一为 ""。
        const rawScope = String(r.scope ?? "").trim().toLowerCase();
        const scope: Issue["scope"] =
          rawScope === "local" || rawScope === "upstream" || rawScope === "systemic"
            ? rawScope
            : "";
        return createIssue({
          severity: String(r.severity ?? "major") as Issue["severity"],
          targetTaskId: String(r.target_task_id ?? ""),
          targetTaskType: String(r.target_task_type ?? ""),
          targetField: String(r.target_field ?? ""),
          description: String(r.description ?? ""),
          suggestion: String(r.suggestion ?? ""),
          scope,
        });
      });
  }

  static _truncateTextForReview(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, Math.max(0, maxChars - 80)) +
      `\n__review_truncated__: ${text.length - Math.max(0, maxChars - 80)} chars omitted`;
  }

  /**
   * 需求原文的评审用截断：保留头部 70% + 尾部 30%。
   * 约束、非功能需求、验收标准往往出现在文档后半部，
   * 纯头部截断会让评审完全看不到它们。
   */
  static _requirementForReview(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const headBudget = Math.floor(maxChars * 0.7);
    const tailBudget = Math.max(0, maxChars - headBudget - 120);
    const omitted = text.length - headBudget - tailBudget;
    return (
      text.slice(0, headBudget) +
      `\n\n__review_truncated__: 中部省略 ${omitted} 字符（仅为控制提示长度，不代表原文缺失）\n\n` +
      text.slice(text.length - tailBudget)
    );
  }

  static _jsonForReview(value: unknown, maxChars: number): string {
    const direct = JSON.stringify(value, null, 2);
    if (direct.length <= maxChars) return direct;

    const attempts = [
      { maxArrayItems: 8, maxStringChars: 1200 },
      { maxArrayItems: 4, maxStringChars: 700 },
      { maxArrayItems: 2, maxStringChars: 350 },
      { maxArrayItems: 1, maxStringChars: 180 },
      { maxArrayItems: 0, maxStringChars: 120 },
    ];

    for (const limits of attempts) {
      const summarized = EvaluationTool._summarizeForReview(value, limits, 0);
      const json = JSON.stringify(summarized, null, 2);
      if (json.length <= maxChars) return json;
    }

    const finalSummary = EvaluationTool._summarizeForReview(
      value,
      { maxArrayItems: 0, maxStringChars: 80 },
      0,
    );
    return JSON.stringify(finalSummary, null, 2);
  }

  private static _summarizeForReview(
    value: unknown,
    limits: { maxArrayItems: number; maxStringChars: number },
    depth: number,
  ): unknown {
    if (typeof value === "string") {
      return EvaluationTool._truncateTextForReview(value, limits.maxStringChars);
    }
    if (typeof value !== "object" || value === null) return value;

    if (Array.isArray(value)) {
      const kept = value
        .slice(0, limits.maxArrayItems)
        .map((item) => EvaluationTool._summarizeForReview(item, limits, depth + 1));
      const omitted = value.length - kept.length;
      if (omitted > 0) {
        kept.push({ __review_truncated__: `${omitted} array item(s) omitted; field exists in source artifact` });
      }
      return kept;
    }

    if (depth >= 6) {
      return { __review_truncated__: "nested object omitted at review depth limit" };
    }

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = EvaluationTool._summarizeForReview(item, limits, depth + 1);
    }
    return result;
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
    const blockerCount = issues.filter((i) => i.severity === "blocker").length;
    const majorCount = issues.filter((i) => i.severity === "major").length;
    const minorCount = issues.filter((i) => i.severity === "minor").length;
    if (passed && majorCount === 0) return "审查通过，无 blocker/major 问题。";
    if (passed) {
      return `审查未清洁通过。发现 ${issues.length} 个问题（blocker: ${blockerCount}, major: ${majorCount}, minor: ${minorCount}），无 blocker，可尝试自动修复 major。`;
    }
    return `审查未通过。发现 ${issues.length} 个问题（blocker: ${blockerCount}, major: ${majorCount}, minor: ${minorCount}）。`;
  }

}
