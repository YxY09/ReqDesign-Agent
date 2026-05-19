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
    previousIssues?: Array<{ severity: string; description: string; location?: string }>,
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
    if (EvaluationTool._shouldSkipAnalyzeShardLlmReview(snapshots, goal)) {
      this.logger.info("evaluate: 跳过 analyze 分片的 LLM 语义评审，仅保留规则检查");
      llmIssues = [];
    } else if (Object.keys(snapshots).length > 0) {
      const [li] = await this._llmReviewSnapshots(requirementText, snapshots, isDirectMode, reviewMode, previousIssues);
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
    const majors = issues.filter((i) => i.severity === "major");
    const passed = blockers.length === 0 && majors.length === 0;
    this.logger.info(`evaluate: 评审完成，passed=${passed}，blockers=${blockers.length}，majors=${majors.length}，minors=${issues.filter((i) => i.severity === "minor").length}`);

    // 4. Build fix tasks
    const fixes = passed ? [] : EvaluationTool._buildFixes(issues);

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

  static _shouldSkipAnalyzeShardLlmReview(
    snapshots: Record<string, Record<string, unknown>>,
    goal: string,
  ): boolean {
    const entries = Object.entries(snapshots);
    if (entries.length <= 1) return false;
    if (goal.toLowerCase().includes("analyze")) return false;
    return entries.every(([taskId, snapshot]) => {
      if (String(snapshot.type ?? "") !== "analyze") return false;
      return taskId !== "analyze-final" && taskId !== "analyze-comprehensive";
    });
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
          issues.push(
            ...this._checkUndefinedExceptionIds(
              taskId,
              "design",
              "design_text",
              String(content),
              requirementJson,
            ),
          );
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
          if (dtype === "activity_diagram") {
            issues.push(...this._checkActivityDiagramCoverage(taskId, text, requirementJson));
          }
          if (dtype === "state_diagram" && /Coupon|优惠券/.test(text) && /C002|支付超时/.test(text)) {
            issues.push(createIssue({
              severity: "major",
              targetTaskId: taskId,
              targetTaskType: "diagrams",
              targetField: "diagrams.state_diagram",
              description: "状态图中优惠券过期错误使用 C002/支付超时作为触发条件",
              suggestion: "将 Coupon/优惠券 的过期转换改为有效期结束，不要引用支付超时约束",
            }));
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
          issues.push(
            ...this._checkUndefinedExceptionIds(
              taskId,
              "tests",
              "test_cases",
              content as string,
              requirementJson,
            ),
          );
          issues.push(...this._checkTestFlowCoverage(taskId, content as string, requirementJson));
        } catch (e) {
          issues.push(createIssue({ severity: "major", targetTaskId: taskId, targetTaskType: "tests", targetField: "test_cases", description: `测试用例规则校验失败: ${e instanceof Error ? e.message : String(e)}` }));
        }
      }
    }

    // Cross-artifact entity naming consistency check
    issues.push(...this._checkCrossArtifactNaming(snapshots, requirementJson));

    // Cross-artifact constraint boundary test coverage
    issues.push(...this._checkConstraintBoundaryCoverage(snapshots, requirementJson));

    return issues;
  }

  private _checkCrossArtifactNaming(
    snapshots: Record<string, Record<string, unknown>>,
    requirementJson: Record<string, unknown>,
  ): Issue[] {
    const issues: Issue[] = [];
    const entities = (requirementJson.entities ?? []) as Array<Record<string, unknown>>;
    if (entities.length === 0) return issues;

    // Build canonical entity name set from requirement analysis
    const entityNames = new Map<string, string>(); // normalized -> original
    for (const entity of entities) {
      const name = String(entity.name ?? "").trim();
      if (!name || /[\u4e00-\u9fff]/.test(name)) continue;
      const normalized = name.toLowerCase().replace(/[_\-\s]/g, "");
      entityNames.set(normalized, name);
    }
    if (entityNames.size === 0) return issues;

    // Check design text for renamed entities
    for (const [taskId, snapshot] of Object.entries(snapshots)) {
      const taskType = String(snapshot.type ?? "");
      if (taskType !== "design") continue;
      const content = String(snapshot.content ?? "");
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
        const found = content.includes(original) ||
          [...designClasses].some((dc) => dc.toLowerCase().replace(/[_\-\s]/g, "") === normalized);
        if (!found) {
          // Check if a renamed version exists (singular/plural, synonym)
          const similarInDesign = [...designClasses].filter((dc) => {
            const dcNorm = dc.toLowerCase().replace(/[_\-\s]/g, "");
            // Skip if too different in length
            if (Math.abs(dcNorm.length - normalized.length) > 4) return false;
            // Check if one contains the other
            return dcNorm.includes(normalized) || normalized.includes(dcNorm);
          });
          if (similarInDesign.length > 0) {
            issues.push(createIssue({
              severity: "minor",
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
      const content = snapshot.content;
      if (!content || typeof content !== "object") continue;
      const classDiagram = String((content as Record<string, unknown>).class_diagram ?? "");
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
              severity: "minor",
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

      for (const constraint of constraints) {
        const cid = String(constraint.id ?? "").trim();
        if (!cid) continue;
        // Check if this constraint ID appears in any test case
        if (!content.includes(cid)) {
          issues.push(createIssue({
            severity: "major",
            targetTaskId: taskId,
            targetTaskType: "tests",
            targetField: "test_cases",
            description: `约束 ${cid} 未被测试用例覆盖`,
            suggestion: `添加针对约束 ${cid} 的边界测试用例`,
          }));
        }
      }
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
    const defined = new Set(
      ((requirementJson.exceptions ?? []) as Array<Record<string, unknown>>)
        .map((item) => String(item.id ?? "").trim())
        .filter(Boolean),
    );
    if (defined.size === 0) return [];

    const referenced = new Set(text.match(/\b[EX]\d{3}\b/g) ?? []);
    const unknown = [...referenced].filter((id) => !defined.has(id)).sort();
    if (unknown.length === 0) return [];

    return [createIssue({
      severity: "major",
      targetTaskId: taskId,
      targetTaskType: taskType,
      targetField,
      description: `产物引用了未定义的异常 ID: ${unknown.join(", ")}`,
      suggestion: `只引用 requirement_json.exceptions 中已定义的异常 ID: ${[...defined].sort().join(", ")}`,
    })];
  }

  private _checkActivityDiagramCoverage(
    taskId: string,
    text: string,
    requirementJson: Record<string, unknown>,
  ): Issue[] {
    const issues: Issue[] = [];
    if (this._requiresRefundFlow(requirementJson)) {
      const missing = EvaluationTool._missingConcepts(text, [
        ["申请退款/退货", /(申请.*(退款|退货))|refund/i],
        ["商家审核", /商家.*审核|审核.*(通过|拒绝)/],
        ["填写退货物流", /(物流|运单|快递).*(填写|录入|提交)|(填写|录入|提交).*(物流|运单|快递)/],
        ["仓库验收", /仓库.*验收|验收.*(通过|失败)/],
        ["退款到账", /退款.*(到账|成功|原路|返回)|(到账|原路返回)/],
      ]);
      if (missing.length > 0) {
        issues.push(createIssue({
          severity: "major",
          targetTaskId: taskId,
          targetTaskType: "diagrams",
          targetField: "diagrams.activity_diagram",
          description: `活动图未完整覆盖退货退款流程，缺少: ${missing.join(", ")}`,
          suggestion: "补充申请退款/退货、商家审核、填写退货物流、仓库验收、退款到账的完整分支",
        }));
      }
    }

    if (this._hasConstraint(requirementJson, "C001")) {
      const missing = EvaluationTool._missingConcepts(text, [
        ["订单总数量<=99", /(总数量|商品数量|件数).*(99|上限)|(99).*(件|数量)/],
        ["订单金额<=99999", /(金额|实付|总价).*(99999|上限)|(99999).*(元|金额)/],
        ["单商品数量<=10", /(单商品|同一商品|单个商品|限购).*(10|上限)|(10).*(件|限购)/],
        ["地址配送范围", /(地址|收货地址).*(配送范围|可配送)|(配送范围).*(地址|校验)/],
      ]);
      if (missing.length > 0) {
        issues.push(createIssue({
          severity: "major",
          targetTaskId: taskId,
          targetTaskType: "diagrams",
          targetField: "diagrams.activity_diagram",
          description: `活动图未完整覆盖 C001 订单约束校验，缺少: ${missing.join(", ")}`,
          suggestion: "在提交订单前补充总数量、总金额、单商品数量、地址配送范围四类校验及失败出口",
        }));
      }
    }
    return issues;
  }

  private _checkTestFlowCoverage(
    taskId: string,
    text: string,
    requirementJson: Record<string, unknown>,
  ): Issue[] {
    if (!this._requiresRefundFlow(requirementJson)) return [];
    const missing = EvaluationTool._missingConcepts(text, [
      ["申请退款/退货", /(申请.*(退款|退货))|refund/i],
      ["商家审核通过", /商家.*审核.*(通过|同意)|(通过|同意).*退款/],
      ["填写物流单号", /(物流单号|退货物流|快递单号|运单号)/],
      ["仓库验收", /仓库.*验收|验收.*(通过|成功)/],
      ["退款到账", /退款.*(到账|成功|原路返回|72)/],
    ]);
    if (missing.length === 0) return [];
    return [createIssue({
      severity: "major",
      targetTaskId: taskId,
      targetTaskType: "tests",
      targetField: "test_cases",
      description: `测试用例未覆盖完整退货退款正常流程，缺少: ${missing.join(", ")}`,
      suggestion: "添加从申请退款/退货、商家审核通过、填写物流单号、仓库验收通过到退款到账的完整正常场景",
    })];
  }

  private _requiresRefundFlow(requirementJson: Record<string, unknown>): boolean {
    const functions = Array.isArray(requirementJson.functions)
      ? requirementJson.functions as Array<Record<string, unknown>>
      : [];
    return functions.some((item) =>
      /退款|退货|售后|refund|return/i.test(
        `${String(item.name ?? "")} ${String(item.description ?? "")}`,
      ),
    );
  }

  private _hasConstraint(requirementJson: Record<string, unknown>, id: string): boolean {
    const constraints = Array.isArray(requirementJson.constraints)
      ? requirementJson.constraints as Array<Record<string, unknown>>
      : [];
    return constraints.some((item) => String(item.id ?? "").trim() === id);
  }

  private static _missingConcepts(
    text: string,
    concepts: Array<[string, RegExp]>,
  ): string[] {
    return concepts
      .filter(([, pattern]) => !pattern.test(text))
      .map(([label]) => label);
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
    previousIssues?: Array<{ severity: string; description: string; location?: string }>,
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

    // Inject previous evaluation issues for incremental review
    if (previousIssues && previousIssues.length > 0) {
      const issueLines = previousIssues
        .map((issue, idx) => `${idx + 1}. [${issue.severity}] ${issue.description}${issue.location ? ` (${issue.location})` : ""}`)
        .join("\n");
      sections.push(`## 上一轮审查结果\n以下是上一轮审查发现的问题。请重点关注：\n1. 这些问题是否已被修复\n2. 是否有新引入的问题\n3. 保持与上轮相同的审查标准\n\n${issueLines}`);
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

  static _truncateTextForReview(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, Math.max(0, maxChars - 80)) +
      `\n__review_truncated__: ${text.length - Math.max(0, maxChars - 80)} chars omitted`;
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
    if (passed) return "审查通过，无 blocker/major 问题。";
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
