/**
 * PlanningTool — reads requirements → produces ExecutionPlan or PlanMutation.
 * Async LLM calls for plan() and replan().
 */

import type { LLMClient } from "../llmClient.js";
import { BaseTool } from "./base.js";
import {
  type ExecutionPlan,
  type PlanMutation,
  type Task,
  type Issue,
  createTask,
  createPlanMutation,
  createExecutionPlan,
} from "../agent/types.js";

/** Merge dependency lists preserving order while ensuring required upstream tasks exist. */
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

export class PlanningTool extends BaseTool {
  private _systemPrompt: string | null = null;

  constructor(llm: LLMClient) {
    super(llm);
  }

  get name(): string {
    return "PlanningTool";
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  async plan(requirementText: string, goal = "design"): Promise<ExecutionPlan> {
    if (!requirementText?.trim()) {
      return createExecutionPlan({ tasks: [], goal, reasoning: "需求文本为空" });
    }

    const system = await this._getSystemPrompt(requirementText.slice(0, 200));
    const userPrompt = PlanningTool._buildUserPrompt(requirementText, goal);

    let plan: ExecutionPlan;
    try {
      if (this.llm) this.llm.streamTag = "[Planner]";
      const response = await this.llm!.generateJson(userPrompt, system);
      plan = this._parseResponse(response as Record<string, unknown>, goal);
    } catch (e) {
      plan = PlanningTool._fallbackPlan(requirementText, goal);
    }

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
    const system = await this._getReplanPrompt(replanReason.slice(0, 200));
    const userPrompt = PlanningTool._buildReplanUserPrompt(
      requirementText, currentPlan, completedTaskIds, failedTaskIds,
      evaluatorIssues ?? [], artifactSummary ?? {}, replanReason,
    );

    let mutation: PlanMutation;
    try {
      if (this.llm) this.llm.streamTag = "[Planner:replan]";
      const response = await this.llm!.generateJson(userPrompt, system);
      mutation = this._parseReplanResponse(response as Record<string, unknown>);
    } catch (e) {
      mutation = PlanningTool._fallbackReplan(currentPlan, failedTaskIds, replanReason);
    }

    return mutation;
  }

  // ------------------------------------------------------------------
  // Prompt building
  // ------------------------------------------------------------------

  private async _getSystemPrompt(queryContext = ""): Promise<string> {
    if (this._systemPrompt === null || queryContext) {
      const prompt = await this._loadPromptWithConstitution("planner.md", "", queryContext);
      if (!queryContext) this._systemPrompt = prompt;
      return prompt;
    }
    return this._systemPrompt;
  }

  private async _getReplanPrompt(queryContext = ""): Promise<string> {
    return await this._loadPromptWithConstitution("planner_replan.md", "", queryContext);
  }

  static _buildUserPrompt(requirementText: string, goal: string): string {
    let text = requirementText.slice(0, 8000);
    if (requirementText.length > 8000) {
      text += "\n\n...(后续内容已截断，核心功能点已覆盖)";
    }

    const taskSection = goal.toLowerCase().includes("analyze")
      ? "\n## 特殊要求\n因为目标是 analyze（仅需求分析），请只规划 analyze 任务，不需要 design/diagrams/tests。"
      : "";

    return `## 需求文档\n\n${text}\n${taskSection}\n\n请根据上述需求文档，输出执行计划 JSON。\n\n返回格式：\n\`\`\`json\n{"reasoning": "...", "tasks": [{"id": "...", "type": "analyze|design|diagrams|tests", "description": "...", "depends_on": [...], "context_hints": {}}]}\n\`\`\``;
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
      target_task_id: iss.targetTaskId,
      description: iss.description.slice(0, 200),
    }));

    return `## Replan Request\n\n**Reason**: ${replanReason}\n\n## Original Requirement (excerpt)\n${reqShort}\n\n## Current Plan\n\`\`\`json\n${JSON.stringify(tasksDesc, null, 2)}\n\`\`\`\n\n## Evaluator Issues\n\`\`\`json\n${JSON.stringify(issuesDesc, null, 2)}\n\`\`\`\n\n## Artifact Summary\n\`\`\`json\n${JSON.stringify(artifactSummary, null, 2)}\n\`\`\`\n\nPlease analyze the failures and produce a plan mutation.`;
  }

  // ------------------------------------------------------------------
  // Response parsing
  // ------------------------------------------------------------------

  _parseResponse(response: Record<string, unknown>, goal: string): ExecutionPlan {
    const tasksRaw = response.tasks as Array<Record<string, unknown>> | undefined;
    let tasks: Task[] = [];

    if (tasksRaw) {
      tasks = tasksRaw
        .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null && !Array.isArray(t))
        .map((t) => createTask({
          id: String(t.id || "").trim(),
          type: (String(t.type || "analyze").trim()) as Task["type"],
          description: String(t.description || "").trim(),
          dependsOn: Array.isArray(t.depends_on) ? t.depends_on.map((d) => String(d).trim()).filter(Boolean) : [],
          contextHints: (typeof t.context_hints === "object" && t.context_hints !== null) ? t.context_hints as Record<string, unknown> : {},
        }));
    }

    if (goal.toLowerCase().includes("analyze")) {
      tasks = tasks.filter((t) => t.type === "analyze");
    }
    tasks = PlanningTool._splitDiagramTasks(tasks);
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
      .map((t) => createTask({
        id: String(t.id || "").trim(),
        type: (String(t.type || "analyze").trim()) as Task["type"],
        description: String(t.description || "").trim(),
        dependsOn: Array.isArray(t.depends_on) ? t.depends_on.map((d) => String(d).trim()) : [],
        contextHints: (typeof t.context_hints === "object") ? t.context_hints as Record<string, unknown> : {},
      }));

    const updateRaw = (response.update_tasks as Array<Record<string, unknown>>) ?? [];
    const updateTasks = updateRaw
      .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
      .map((t) => createTask({
        id: String(t.id || "").trim(),
        type: (String(t.type || "analyze").trim()) as Task["type"],
        description: String(t.description || "").trim(),
        dependsOn: Array.isArray(t.depends_on) ? t.depends_on.map((d) => String(d).trim()) : [],
        contextHints: (typeof t.context_hints === "object") ? t.context_hints as Record<string, unknown> : {},
      }));

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
  // Fallbacks
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
        createTask({ id: "design-1", type: "design", description: "生成模块划分、核心类、接口与数据流", dependsOn: ["analyze-1"] }),
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

  // ------------------------------------------------------------------
  // Static helpers
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
}
