/**
 * PlanningTool — 读取需求文档 → 生成执行计划或计划变更。
 * plan() 和 replan() 使用异步 LLM 调用。
 */

import type { LLMClient } from "../llmClient.js";
import { BaseTool } from "./base.js";
import type { ToolCapabilities } from "./types.js";
import {
  type ExecutionPlan,
  type PlanMutation,
  type Task,
  type Issue,
  type EntityRegistry,
  createTask,
  createPlanMutation,
  createExecutionPlan,
} from "../shared/types.js";
import { buildRegistrySummary } from "../shared/registrySummary.js";

/** 合并依赖列表，保持顺序的同时确保必需的 upstream 任务存在。 */
function mergeDeps(existing: string[], required: string[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const dep of [...(existing ?? []), ...(required ?? [])]) {
    if (dep && !seen.has(dep)) {
      merged.push(dep);
      seen.add(dep);
    }
  }
  return merged;
}

/** Return the number of assignedSections in a task's contextHints. */
function getAssignedCount(task: Task): number {
  const sections = task.contextHints?.assignedSections;
  return Array.isArray(sections) ? sections.length : 0;
}

export class PlanningTool extends BaseTool {
  constructor(llm: LLMClient) {
    super(llm);
  }

  get name(): string {
    return "PlanningTool";
  }

  get capabilities(): ToolCapabilities {
    return { requiresLlm: true, supportedTaskTypes: ["plan"] };
  }

  // ------------------------------------------------------------------
  // 公开 API
  // ------------------------------------------------------------------

  async plan(requirementText: string, goal = "design", sectionIndex?: Array<{ id: string; depth: number; title: string; body: string; charRange: [number, number] }>): Promise<ExecutionPlan> {
    if (!requirementText?.trim()) {
      this.logger.warn("plan: 需求文本为空，返回空计划");
      return createExecutionPlan({ tasks: [], goal, reasoning: "需求文本为空" });
    }

    this.logger.info(`plan: 开始规划，目标=${goal}，需求长度=${requirementText.length}`);
    const system = await this._getSystemPrompt("planner.md", "", requirementText.slice(0, 200));
    const userPrompt = PlanningTool._buildUserPrompt(requirementText, goal, sectionIndex);

    let plan: ExecutionPlan;
    try {
      this.llm.streamTag = "[Planner]";
      const response = await this.llm.generateJson(userPrompt, system);
      plan = this._parseResponse(response as Record<string, unknown>, goal);
      this.logger.info(`plan: 规划完成，共 ${plan.tasks.length} 个任务，reasoning=${plan.reasoning?.slice(0, 80)}`);
    } catch (e) {
      this.logger.warn(`plan: LLM 规划失败，使用 fallback: ${e instanceof Error ? e.message : String(e)}`);
      plan = PlanningTool._fallbackPlan(requirementText, goal);
    }

    plan = PlanningTool._ensureSectionCoverage(plan, sectionIndex);
    return plan;
  }

  async replan(
    requirementText: string,
    currentPlan: ExecutionPlan,
    completedTaskIds: string[],
    failedTaskIds: string[],
    evaluatorIssues: Issue[] | null,
    artifactSummary: Record<string, unknown> | null,
    replanReason: string,
  ): Promise<PlanMutation> {
    this.logger.info(`replan: 开始重新规划，原因=${replanReason.slice(0, 80)}，已完成=${completedTaskIds.length}，失败=${failedTaskIds.length}`);
    const system = await this._getReplanPrompt(replanReason.slice(0, 200));
    const userPrompt = PlanningTool._buildReplanUserPrompt(
      requirementText, currentPlan, completedTaskIds, failedTaskIds,
      evaluatorIssues ?? [], artifactSummary ?? {}, replanReason,
    );

    let mutation: PlanMutation;
    try {
      this.llm.streamTag = "[Planner:replan]";
      const response = await this.llm.generateJson(userPrompt, system);
      mutation = this._parseReplanResponse(response as Record<string, unknown>);
      this.logger.info(`replan: 重新规划完成，add=${mutation.addTasks?.length ?? 0}，update=${mutation.updateTasks?.length ?? 0}，drop=${mutation.dropTaskIds?.length ?? 0}`);
    } catch (e) {
      this.logger.warn(`replan: LLM 重规划失败，使用 fallback: ${e instanceof Error ? e.message : String(e)}`);
      mutation = PlanningTool._fallbackReplan(currentPlan, failedTaskIds, replanReason);
    }

    mutation = PlanningTool._ensureIssueTargetedTasks(
      mutation,
      currentPlan,
      completedTaskIds,
      evaluatorIssues ?? [],
      replanReason,
    );
    return mutation;
  }

  // ------------------------------------------------------------------
  // 构建 Prompt
  // ------------------------------------------------------------------

  private async _getReplanPrompt(queryContext = ""): Promise<string> {
    return await this._loadPromptWithConstitution("planner_replan.md", "", queryContext);
  }

  static _buildUserPrompt(
    requirementText: string,
    goal: string,
    sectionIndex?: Array<{ id: string; depth: number; title: string; body: string; charRange: [number, number] }>,
    registry?: EntityRegistry,
  ): string {
    const taskSection = goal.toLowerCase().includes("analyze")
      ? "\n## 特殊要求\n因为目标是 analyze（仅需求分析），请只规划 analyze 任务，不需要 design/diagrams/tests。"
      : "";

    // Registry summary section
    let registrySection = "";
    if (registry) {
      const summary = buildRegistrySummary(registry);
      if (summary) {
        registrySection = `\n## 全局实体注册表\n以下是已识别的核心实体和功能，规划时请参考这些术语。\n\n${summary}\n`;
      }
    }

    if (sectionIndex && sectionIndex.length > 0) {
      // TOC mode: build chapter directory + per-chapter summary
      const tocLines: string[] = [];
      for (const s of sectionIndex) {
        const indent = "  ".repeat(Math.max(0, s.depth - 1));
        const charCount = s.body.length;
        const summary = s.body.length > 150 ? s.body.slice(0, 150) + "..." : s.body;
        tocLines.push(`${indent}- [${s.id}] ${s.title} (${charCount}字)${summary ? " — " + summary : ""}`);
      }
      const toc = tocLines.join("\n");

      return `${registrySection}## 需求文档章节目录（共${sectionIndex.length}个章节）\n\n${toc}\n\n---\n\n请根据上述章节目录，为每个 analyze 任务分配 assignedSections（章节 ID 列表），使各 analyze 任务分工明确。\n约束/异常提取任务不需要 assignedSections（拿全文）。\n${taskSection}\n\n请输出执行计划 JSON。\n\n返回格式：\n\`\`\`json\n{"reasoning": "...", "tasks": [{"id": "...", "type": "analyze|design|diagrams|tests", "description": "...", "depends_on": [...], "context_hints": {}, "assignedSections": ["s1-1", "s2-1"]}]}\n\`\`\``;
    }

    // Fallback: truncate
    let text = requirementText.slice(0, 8000);
    if (requirementText.length > 8000) {
      text += "\n\n...(后续内容已截断，核心功能点已覆盖)";
    }

    return `${registrySection}## 需求文档\n\n${text}\n${taskSection}\n\n请根据上述需求文档，输出执行计划 JSON。\n\n返回格式：\n\`\`\`json\n{"reasoning": "...", "tasks": [{"id": "...", "type": "analyze|design|diagrams|tests", "description": "...", "depends_on": [...], "context_hints": {}}]}\n\`\`\``;
  }

  static _buildReplanUserPrompt(
    requirementText: string,
    currentPlan: ExecutionPlan,
    completedTaskIds: string[],
    failedTaskIds: string[],
    evaluatorIssues: Issue[],
    artifactSummary: Record<string, unknown>,
    replanReason: string,
  ): string {
    const reqShort = requirementText.slice(0, 4000);

    const tasksDesc = currentPlan.tasks.map((t) => {
      const status = completedTaskIds.includes(t.id) ? "completed"
        : failedTaskIds.includes(t.id) ? "failed" : "pending";
      return {
        id: t.id, type: t.type,
        description: t.description.slice(0, 200),
        depends_on: t.dependsOn, status,
      };
    });

    const issuesDesc = evaluatorIssues.slice(0, 20).map((iss) => ({
      severity: iss.severity,
      scope: iss.scope,
      target_task_id: iss.targetTaskId,
      target_task_type: iss.targetTaskType,
      target_field: iss.targetField,
      description: iss.description.slice(0, 200),
      suggestion: iss.suggestion.slice(0, 200),
    }));

    return `## Replan Request\n\n**Reason**: ${replanReason}\n\n## Original Requirement (excerpt)\n${reqShort}\n\n## Current Plan\n\`\`\`json\n${JSON.stringify(tasksDesc, null, 2)}\n\`\`\`\n\n## Evaluator Issues\n\`\`\`json\n${JSON.stringify(issuesDesc, null, 2)}\n\`\`\`\n\n## Artifact Summary\n\`\`\`json\n${JSON.stringify(artifactSummary, null, 2)}\n\`\`\`\n\nPlease analyze the failures and produce a plan mutation. Every major/blocker local issue must have a matching add_task or update_task for its target type. For diagrams-final, use target_field to create the concrete diagram task (activity_diagram -> diagrams-activity-N, class_diagram -> diagrams-class-N, state_diagram -> diagrams-state-N). For tests issues, add a tests-N task.`;
  }

  // ------------------------------------------------------------------
  // 解析响应
  // ------------------------------------------------------------------

  _parseResponse(response: Record<string, unknown>, goal: string): ExecutionPlan {
    const tasksRaw = response.tasks as Array<Record<string, unknown>> | undefined;
    let tasks: Task[] = [];

    if (tasksRaw) {
      tasks = tasksRaw
        .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null && !Array.isArray(t))
        .map((t) => {
          const rawMode = String(t.analysis_mode ?? t.analysisMode ?? "").trim();
          const analysisMode: Task["analysisMode"] =
            rawMode === "constraints" ? "constraints"
            : rawMode === "domain" ? "domain"
            : rawMode ? "domain"
            : undefined;

          // Read assignedSections from LLM output (camelCase or snake_case)
          const contextHints: Record<string, unknown> =
            (typeof t.context_hints === "object" && t.context_hints !== null) ? t.context_hints as Record<string, unknown> : {};
          const assignedSections = Array.isArray(t.assignedSections ?? t.assigned_sections)
            ? ((t.assignedSections ?? t.assigned_sections) as unknown[]).map(String).filter(Boolean)
            : undefined;
          if (assignedSections && assignedSections.length > 0) {
            contextHints.assignedSections = assignedSections;
          }

          return createTask({
            id: String(t.id || "").trim(),
            type: (String(t.type || "analyze").trim()) as Task["type"],
            description: String(t.description || "").trim(),
            dependsOn: Array.isArray(t.depends_on) ? t.depends_on.map((d) => String(d).trim()).filter(Boolean) : [],
            contextHints,
            ...(analysisMode ? { analysisMode } : {}),
          });
        });
    }

    if (goal.toLowerCase().includes("analyze")) {
      tasks = tasks.filter((t) => t.type === "analyze");
    }
    tasks = PlanningTool._splitDiagramTasks(tasks);
    tasks = PlanningTool._ensureConstraintTask(tasks, goal);
    tasks = PlanningTool._ensureOrder(tasks);

    return createExecutionPlan({
      tasks,
      goal,
      reasoning: String(response.reasoning || "").trim(),
    });
  }

  _parseReplanResponse(response: Record<string, unknown>): PlanMutation {
    const addTasksRaw = (response.add_tasks as Array<Record<string, unknown>>) ?? [];
    const addTasks = addTasksRaw
      .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
      .map((t) => {
        const rawMode = String(t.analysis_mode ?? t.analysisMode ?? "").trim();
        const analysisMode: Task["analysisMode"] =
          rawMode === "constraints" ? "constraints"
          : rawMode === "domain" ? "domain"
          : rawMode ? "domain"
          : undefined;
        return createTask({
          id: String(t.id || "").trim(),
          type: (String(t.type || "analyze").trim()) as Task["type"],
          description: String(t.description || "").trim(),
          dependsOn: Array.isArray(t.depends_on) ? t.depends_on.map((d) => String(d).trim()) : [],
          contextHints: (typeof t.context_hints === "object") ? t.context_hints as Record<string, unknown> : {},
          ...(analysisMode ? { analysisMode } : {}),
        });
      });

    const updateRaw = (response.update_tasks as Array<Record<string, unknown>>) ?? [];
    const updateTasks = updateRaw
      .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
      .map((t) => {
        const rawMode = String(t.analysis_mode ?? t.analysisMode ?? "").trim();
        const analysisMode: Task["analysisMode"] =
          rawMode === "constraints" ? "constraints"
          : rawMode === "domain" ? "domain"
          : rawMode ? "domain"
          : undefined;
        return createTask({
          id: String(t.id || "").trim(),
          type: (String(t.type || "analyze").trim()) as Task["type"],
          description: String(t.description || "").trim(),
          dependsOn: Array.isArray(t.depends_on) ? t.depends_on.map((d) => String(d).trim()) : [],
          contextHints: (typeof t.context_hints === "object") ? t.context_hints as Record<string, unknown> : {},
          ...(analysisMode ? { analysisMode } : {}),
        });
      });

    const dropIds = ((response.drop_task_ids as string[]) ?? [])
      .map((d) => String(d).trim())
      .filter(Boolean);

    const reorder: Record<string, string[]> = {};
    const reorderRaw = response.reorder_edges as Record<string, unknown> | undefined;
    if (reorderRaw) {
      for (const [k, v] of Object.entries(reorderRaw)) {
        if (Array.isArray(v)) reorder[k.trim()] = v.map((d) => String(d).trim());
      }
    }

    return createPlanMutation({
      addTasks,
      updateTasks,
      dropTaskIds: dropIds,
      reorderEdges: reorder,
      reasoning: String(response.reasoning || ""),
    });
  }

  // ------------------------------------------------------------------
  // 降级策略
  // ------------------------------------------------------------------

  static _fallbackPlan(_requirementText: string, goal: string): ExecutionPlan {
    if (goal.toLowerCase().includes("analyze")) {
      return createExecutionPlan({
        tasks: [createTask({ id: "analyze-1", type: "analyze", description: "提取角色、功能、实体、约束等结构化信息" })],
        goal,
        reasoning: "fallback: analyze only",
      });
    }

    return createExecutionPlan({
      tasks: [
        createTask({ id: "analyze-1", type: "analyze", description: "提取角色、功能、实体、约束等结构化信息" }),
        createTask({ id: "analyze-constraints", type: "analyze", description: "约束提取：扫描全文提取所有业务约束和异常", analysisMode: "constraints", contextHints: { focus_areas: [], note: "约束提取：扫描全文提取所有业务约束和异常" } }),
        createTask({ id: "design-1", type: "design", description: "生成模块划分、核心类、接口与数据流", dependsOn: ["analyze-1", "analyze-constraints"] }),
        createTask({ id: "diagrams-class", type: "diagrams", description: "生成 Mermaid 类图", dependsOn: ["design-1"], contextHints: { diagram_kind: "class_diagram" } }),
        createTask({ id: "diagrams-activity", type: "diagrams", description: "生成 Mermaid 活动图", dependsOn: ["design-1"], contextHints: { diagram_kind: "activity_diagram" } }),
        createTask({ id: "diagrams-state", type: "diagrams", description: "生成 Mermaid 状态图", dependsOn: ["design-1"], contextHints: { diagram_kind: "state_diagram" } }),
        createTask({ id: "tests-1", type: "tests", description: "生成正常/异常/边界测试用例", dependsOn: ["design-1"] }),
      ],
      goal,
      reasoning: "fallback: 标准流程，diagrams 拆分为 3 个独立任务",
    });
  }

  static _fallbackReplan(
    currentPlan: ExecutionPlan,
    failedTaskIds: string[],
    reason: string,
  ): PlanMutation {
    const addTasks: Task[] = [];
    const dropIds: string[] = [];

    for (const failedId of failedTaskIds) {
      const original = currentPlan.tasks.find((t) => t.id === failedId);
      if (!original) continue;
      dropIds.push(failedId);
      const newId = `${original.type}-${currentPlan.tasks.length + addTasks.length + 1}`;
      addTasks.push(createTask({
        id: newId,
        type: original.type,
        description: `[replan] ${original.description}`,
        dependsOn: original.dependsOn.filter((d) => !failedTaskIds.includes(d)),
        contextHints: { ...original.contextHints },
      }));
    }

    return createPlanMutation({
      addTasks,
      dropTaskIds: dropIds,
      reasoning: `fallback replan: ${reason}`,
    });
  }

  static _ensureIssueTargetedTasks(
    mutation: PlanMutation,
    currentPlan: ExecutionPlan,
    completedTaskIds: string[],
    evaluatorIssues: Issue[],
    reason: string,
  ): PlanMutation {
    const importantIssues = evaluatorIssues.filter((issue) =>
      (issue.severity === "blocker" || issue.severity === "major") &&
      issue.scope !== "upstream" &&
      issue.scope !== "systemic",
    );
    if (importantIssues.length === 0) return mutation;

    const existingIds = new Set([
      ...currentPlan.tasks.map((task) => task.id),
      ...mutation.addTasks.map((task) => task.id),
    ]);
    const added = [...mutation.addTasks];
    const latestAnalyze = PlanningTool._latestTaskIdOfType(currentPlan, "analyze", completedTaskIds);
    const latestExistingDesign = PlanningTool._latestTaskIdOfType(currentPlan, "design", completedTaskIds);
    let latestDesignForDeps = [...added].reverse().find((task) => task.type === "design")?.id ??
      latestExistingDesign;

    for (const issue of importantIssues) {
      const taskType = PlanningTool._issueTaskType(issue);
      if (!["design", "diagrams", "tests"].includes(taskType)) continue;

      const diagramKind = taskType === "diagrams"
        ? PlanningTool._diagramKindFromIssue(issue)
        : "";
      if (PlanningTool._mutationAlreadyCoversIssue(added, mutation.updateTasks, taskType, diagramKind)) {
        continue;
      }

      const prefix = taskType === "diagrams" && diagramKind
        ? `diagrams-${diagramKind.replace("_diagram", "")}`
        : taskType;
      const id = PlanningTool._nextTaskId(prefix, existingIds);
      existingIds.add(id);

      const dependsOn = taskType === "design"
        ? (latestAnalyze ? [latestAnalyze] : [])
        : (latestDesignForDeps ? [latestDesignForDeps] : []);

      const task = createTask({
        id,
        type: taskType as Task["type"],
        description: `[replan:${reason.slice(0, 60)}] 修复 ${issue.targetTaskId || issue.targetField}: ${issue.description}`,
        dependsOn,
        contextHints: {
          ...(diagramKind ? { diagram_kind: diagramKind } : {}),
          source_issue_target: issue.targetTaskId,
          source_issue_field: issue.targetField,
          fix_instructions: [
            issue.suggestion || issue.description,
            issue.description,
          ].filter(Boolean),
        },
      });
      added.push(task);
      if (task.type === "design") {
        latestDesignForDeps = task.id;
      }
    }

    return createPlanMutation({
      addTasks: added,
      updateTasks: mutation.updateTasks,
      dropTaskIds: mutation.dropTaskIds,
      reorderEdges: mutation.reorderEdges,
      reasoning: mutation.reasoning
        ? `${mutation.reasoning} | ensured issue-targeted remediation`
        : "ensured issue-targeted remediation",
    });
  }

  private static _issueTaskType(issue: Issue): string {
    if (issue.targetTaskType) return issue.targetTaskType;
    const field = issue.targetField.toLowerCase();
    if (field.includes("diagram")) return "diagrams";
    if (field.includes("test")) return "tests";
    if (field.includes("design")) return "design";
    return "";
  }

  private static _diagramKindFromIssue(issue: Issue): string {
    const text = `${issue.targetField} ${issue.description}`.toLowerCase();
    if (text.includes("activity") || text.includes("活动图")) return "activity_diagram";
    if (text.includes("class") || text.includes("类图")) return "class_diagram";
    if (text.includes("state") || text.includes("状态图")) return "state_diagram";
    return "";
  }

  private static _mutationAlreadyCoversIssue(
    addTasks: Task[],
    updateTasks: Task[],
    taskType: string,
    diagramKind: string,
  ): boolean {
    const tasks = [...addTasks, ...updateTasks];
    return tasks.some((task) => {
      if (task.type !== taskType) return false;
      if (taskType !== "diagrams") return true;
      if (!diagramKind) return true;
      const hintKind = String(task.contextHints?.diagram_kind ?? "");
      const taskText = `${task.id} ${task.description}`.toLowerCase();
      return hintKind === diagramKind ||
        taskText.includes(diagramKind.replace("_diagram", "")) ||
        (diagramKind === "activity_diagram" && taskText.includes("活动图")) ||
        (diagramKind === "class_diagram" && taskText.includes("类图")) ||
        (diagramKind === "state_diagram" && taskText.includes("状态图"));
    });
  }

  private static _latestTaskIdOfType(
    plan: ExecutionPlan,
    type: Task["type"],
    completedTaskIds: string[],
  ): string {
    const completed = new Set(completedTaskIds);
    const candidates = plan.tasks.filter((task) => task.type === type);
    const completedCandidates = candidates.filter((task) => completed.has(task.id));
    const list = completedCandidates.length > 0 ? completedCandidates : candidates;
    return list.length > 0 ? list[list.length - 1].id : "";
  }

  private static _nextTaskId(prefix: string, existingIds: Set<string>): string {
    for (let i = 1; i < 1000; i++) {
      const id = `${prefix}-${i}`;
      if (!existingIds.has(id)) return id;
    }
    return `${prefix}-${Date.now()}`;
  }

  // ------------------------------------------------------------------
  // 静态辅助函数
  // ------------------------------------------------------------------

  static _splitDiagramTasks(tasks: Task[]): Task[] {
    const validKinds = new Set(["class_diagram", "activity_diagram", "state_diagram"]);
    const result: Task[] = [];
    for (const task of tasks) {
      if (task.type !== "diagrams") {
        result.push(task);
        continue;
      }
      const kind = String(task.contextHints?.diagram_kind ?? "").trim();
      if (kind && validKinds.has(kind)) {
        result.push(task);
        continue;
      }
      for (const k of [...validKinds].sort()) {
        const suffix = k.replace("_diagram", "");
        result.push(createTask({
          id: `diagrams-${suffix}`,
          type: "diagrams" as const,
          description: `生成 ${k} 的 Mermaid 代码`,
          dependsOn: [...task.dependsOn],
          contextHints: { ...task.contextHints, diagram_kind: k },
        }));
      }
    }
    return result;
  }

  static _ensureConstraintTask(tasks: Task[], goal: string): Task[] {
    // Only inject for design goals
    if (!goal.toLowerCase().includes("design")) return tasks;

    // Check if a constraints task already exists
    const hasConstraintTask = tasks.some(
      (t) => t.type === "analyze" && t.analysisMode === "constraints",
    );
    if (hasConstraintTask) return tasks;

    // Find a unique id for the constraint task
    const existingIds = new Set(tasks.map((t) => t.id));
    let constraintId = "analyze-constraints";
    if (existingIds.has(constraintId)) {
      for (let i = 1; i < 100; i++) {
        constraintId = `analyze-constraints-${i}`;
        if (!existingIds.has(constraintId)) break;
      }
    }

    // Insert before the first design task
    const constraintTask = createTask({
      id: constraintId,
      type: "analyze",
      description: "约束提取：扫描全文提取所有业务约束和异常",
      analysisMode: "constraints",
      contextHints: {
        focus_areas: [],
        note: "约束提取：扫描全文提取所有业务约束和异常",
      },
    });

    const designIdx = tasks.findIndex((t) => t.type === "design");
    if (designIdx >= 0) {
      tasks.splice(designIdx, 0, constraintTask);
    } else {
      tasks.push(constraintTask);
    }

    return tasks;
  }

  static _ensureOrder(tasks: Task[]): Task[] {
    const analyzeIds = tasks.filter((t) => t.type === "analyze").map((t) => t.id);
    const designIds = tasks.filter((t) => t.type === "design").map((t) => t.id);

    for (const task of tasks) {
      if (task.type === "design") {
        task.dependsOn = mergeDeps(task.dependsOn, analyzeIds);
      }
      if (task.type === "diagrams" || task.type === "tests") {
        task.dependsOn = mergeDeps(task.dependsOn, designIds);
      }
    }
    return tasks;
  }

  /**
   * After parsing, verify all sections from sectionIndex are assigned to at least
   * one analyze task. Unassigned sections are appended to the analyze task with
   * the fewest assigned sections. Returns the plan as-is when sectionIndex is
   * not provided or there are no analyze tasks.
   */
  static _ensureSectionCoverage(
    plan: ExecutionPlan,
    sectionIndex?: Array<{ id: string; depth: number; title: string; body: string; charRange: [number, number] }>,
  ): ExecutionPlan {
    if (!sectionIndex || sectionIndex.length === 0) return plan;

    const analyzeTasks = plan.tasks.filter((t) => t.type === "analyze");
    if (analyzeTasks.length === 0) return plan;

    // Collect all section IDs that must be covered
    const requiredIds = new Set(sectionIndex.map((s) => s.id));

    // Collect all already-assigned section IDs across analyze tasks
    const assignedSet = new Set<string>();
    for (const task of analyzeTasks) {
      const sections = task.contextHints?.assignedSections;
      if (Array.isArray(sections)) {
        for (const id of sections) {
          assignedSet.add(id);
        }
      }
    }

    // Find unassigned sections
    const unassigned: string[] = [];
    for (const id of requiredIds) {
      if (!assignedSet.has(id)) {
        unassigned.push(id);
      }
    }

    if (unassigned.length === 0) return plan;

    // Find the analyze task with the fewest assigned sections (lightest)
    let lightest = analyzeTasks[0];
    let lightestCount = getAssignedCount(lightest);
    for (let i = 1; i < analyzeTasks.length; i++) {
      const count = getAssignedCount(analyzeTasks[i]);
      if (count < lightestCount) {
        lightest = analyzeTasks[i];
        lightestCount = count;
      }
    }

    // Append unassigned sections to the lightest task
    const existing = (Array.isArray(lightest.contextHints?.assignedSections)
      ? lightest.contextHints!.assignedSections as string[]
      : []) as string[];
    lightest.contextHints = {
      ...lightest.contextHints,
      assignedSections: [...existing, ...unassigned],
    };

    return plan;
  }
}
