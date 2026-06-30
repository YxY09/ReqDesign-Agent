/**
 * PlanningTool — 读取需求文档 → 生成执行计划或计划变更。
 * plan() 和 replan() 使用异步 LLM 调用。
 */

import type { LLMClient } from "../llmClient.js";
import { RegistryExtractor } from "../generators/registryExtractor.js";
import { ConstraintExtractor } from "../generators/constraintExtractor.js";
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
import type { ConstraintCandidate } from "../shared/constraintCanonicalizer.js";

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

function buildConstraintCandidateSummary(
  candidates?: ConstraintCandidate[],
  sectionIds?: string[],
): string {
  if (!candidates || candidates.length === 0) return "";

  let filtered = candidates;
  if (sectionIds && sectionIds.length > 0) {
    const sectionSet = new Set(sectionIds);
    const sectionMatched = candidates.filter((c) => c.sectionId && sectionSet.has(c.sectionId));
    const noSection = candidates.filter((c) => !c.sectionId);
    if (sectionMatched.length > 0) {
      filtered = [...sectionMatched, ...noSection];
    }
    // If no candidates have sectionId, keep all (fall through)
  }

  const rows = filtered.map((candidate) => {
    const originalIndex = candidates.indexOf(candidate);
    const row: Record<string, unknown> = {
      constraintRef: `C${String(originalIndex + 1).padStart(3, "0")}`,
      description: candidate.description ?? "",
      sourceText: candidate.sourceText ?? "",
    };
    if (candidate.sectionId) row.sectionId = candidate.sectionId;
    if (candidate.relatedFunctionCandidates?.length) {
      row.relatedFunctionCandidates = candidate.relatedFunctionCandidates;
    }
    return row;
  });
  return `\n## 约束候选注册表\n以下是程序预提取的约束候选。规划 analyze 任务时，请保留约束分析职责，并让相关任务通过 context_hints.availableConstraints 复用这些 constraintRef；新发现且不在候选中的约束放入 missingConstraintCandidates。\n\n\`\`\`json\n${JSON.stringify(rows, null, 2)}\n\`\`\`\n`;
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

  /** Set to "llm" to use the LLM planner instead of deterministic (experimental). */
  plannerMode: "deterministic" | "llm" = "deterministic";

  async plan(requirementText: string, goal = "design", sectionIndex?: Array<{ id: string; depth: number; title: string; body: string; charRange: [number, number] }>): Promise<ExecutionPlan> {
    if (!requirementText?.trim()) {
      this.logger.warn("plan: 需求文本为空，返回空计划");
      return createExecutionPlan({ tasks: [], goal, reasoning: "需求文本为空" });
    }

    this.logger.info(`plan: 开始规划，目标=${goal}，需求长度=${requirementText.length}，mode=${this.plannerMode}`);

    // Extract entity registry before building prompt
    let registry: EntityRegistry | undefined;
    try {
      const extractor = new RegistryExtractor(this.llm);
      registry = await this._withStreamTag("[Planner:registry]", () =>
        extractor.extract(requirementText)
      );
      this.logger.info(`plan: registry 提取完成，entities=${registry.entities.length}`);
    } catch (e) {
      this.logger.warn(`plan: registry 提取失败，继续无 registry 规划: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Extract constraint candidates if registry is available
    let constraintCandidates: ConstraintCandidate[] | undefined;
    if (registry && registry.entities.length > 0) {
      try {
        const extractor = new ConstraintExtractor(this.llm);
        constraintCandidates = await this._withStreamTag(
          "[Planner:constraints]",
          () => extractor.extractCandidates(
            requirementText,
            registry.entities.map((e) => ({ id: e.id, canonicalName: e.canonicalName, aliases: e.aliases })),
            (registry.functions ?? []).map((f) => ({ id: f.id, displayId: f.id, name: f.name })),
          ),
        );
        this.logger.info(`plan: constraint candidates 提取完成，count=${constraintCandidates.length}`);
      } catch (e) {
        this.logger.warn(`plan: constraint candidate 提取失败，继续无约束候选: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    let plan: ExecutionPlan;

    if (this.plannerMode === "llm") {
      // Experimental: LLM-based planning (kept for non-standard workflows)
      const system = await this._getSystemPrompt("planner.md", "", requirementText.slice(0, 200));
      const userPrompt = PlanningTool._buildUserPrompt(requirementText, goal, sectionIndex, registry, constraintCandidates);
      try {
        const response = await this._withStreamTag("[Planner:plan]", () =>
          this.llm.generateJson(userPrompt, system)
        );
        plan = this._parseResponse(response as Record<string, unknown>, goal);
        this.logger.info(`plan: LLM 规划完成，共 ${plan.tasks.length} 个任务`);
      } catch (e) {
        this.logger.warn(`plan: LLM 规划失败，降级 deterministic: ${e instanceof Error ? e.message : String(e)}`);
        plan = PlanningTool.buildDeterministicPlan(goal, sectionIndex);
      }
      plan = PlanningTool._ensureSectionCoverage(plan, sectionIndex);
      plan = PlanningTool._capAnalyzeShards(plan, requirementText, sectionIndex);
    } else {
      plan = PlanningTool.buildDeterministicPlan(goal, sectionIndex);
      PlanningTool._logShardMapping(plan, this.logger);
    }

    // Inject availableConstraints into analyze tasks (section-filtered, capped)
    const MAX_CONSTRAINTS_PER_TASK = 30;
    if (constraintCandidates && constraintCandidates.length > 0) {
      // constraintRef 基于全局序号必须稳定；预建 Map 避免每条 indexOf 的 O(n²)
      const candidateIndex = new Map<ConstraintCandidate, number>(
        constraintCandidates.map((candidate, index) => [candidate, index]),
      );
      for (const task of plan.tasks) {
        if (task.type === "analyze") {
          const assignedSections = Array.isArray(task.contextHints?.assignedSections)
            ? (task.contextHints.assignedSections as string[])
            : [];

          let filtered: ConstraintCandidate[];
          if (assignedSections.length > 0) {
            // Try section-based filtering
            const sectionSet = new Set(assignedSections);
            const sectionMatched = constraintCandidates.filter(
              (c) => c.sectionId && sectionSet.has(c.sectionId),
            );
            const noSection = constraintCandidates.filter((c) => !c.sectionId);

            if (sectionMatched.length > 0) {
              // Use section-matched + those without section info
              filtered = [...sectionMatched, ...noSection];
            } else {
              // No candidates have sectionId — fall back to all
              filtered = constraintCandidates;
            }
          } else {
            // Task has no assignedSections — include all
            filtered = constraintCandidates;
          }

          // Apply cap for safety
          if (filtered.length > MAX_CONSTRAINTS_PER_TASK) {
            filtered = filtered.slice(0, MAX_CONSTRAINTS_PER_TASK);
          }

          task.contextHints.availableConstraints = filtered.map((c) => {
            const originalIndex = candidateIndex.get(c) ?? -1;
            return {
              constraintRef: `C${String(originalIndex + 1).padStart(3, "0")}`,
              description: c.description ?? "",
              sourceText: c.sourceText ?? "",
            };
          });
        }
      }
    }

    // Attach registry to plan for downstream consumers
    if (registry) {
      plan.registry = registry;
    }
    // Attach the authoritative constraint registry so the analyze merge can
    // detect (and later re-add) constraints the analyze LLM dropped.
    if (constraintCandidates && constraintCandidates.length > 0) {
      plan.constraintRegistry = constraintCandidates;
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
    this.logger.info(`replan: 开始重新规划，原因=${replanReason.slice(0, 80)}，已完成=${completedTaskIds.length}，失败=${failedTaskIds.length}`);
    const system = await this._getReplanPrompt(replanReason.slice(0, 200));
    const userPrompt = PlanningTool._buildReplanUserPrompt(
      requirementText, currentPlan, completedTaskIds, failedTaskIds,
      evaluatorIssues ?? [], artifactSummary ?? {}, replanReason,
    );

    let mutation: PlanMutation;
    try {
      const response = await this._withStreamTag("[Planner:replan]", () =>
        this.llm.generateJson(userPrompt, system)
      );
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
    mutation = PlanningTool._stabilizeAnalyzeReplanMutation(
      mutation,
      currentPlan,
      completedTaskIds,
      failedTaskIds,
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
    constraintCandidates?: ConstraintCandidate[],
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
    const constraintsSection = buildConstraintCandidateSummary(constraintCandidates);

    if (sectionIndex && sectionIndex.length > 0) {
      // TOC mode: build chapter directory + per-chapter summary
      const tocLines: string[] = [];
      for (const s of sectionIndex) {
        const indent = "  ".repeat(Math.max(0, s.depth - 1));
        const charCount = s.body.length;
        tocLines.push(`${indent}- [${s.id}] ${s.title} (${charCount}字)`);
      }
      const toc = tocLines.join("\n");

      return `${registrySection}${constraintsSection}## 需求文档章节目录（共${sectionIndex.length}个章节）\n\n${toc}\n\n---\n\n请根据上述章节目录，为每个 analyze 任务分配 assignedSections（章节 ID 列表），使各 analyze 任务分工明确。\n约束/异常提取任务不需要 assignedSections（拿全文）。\n${taskSection}\n\n请输出执行计划 JSON。\n\n返回格式：\n\`\`\`json\n{"reasoning": "...", "tasks": [{"id": "...", "type": "analyze|design|diagrams|tests", "description": "...", "depends_on": [...], "context_hints": {}, "assignedSections": ["s1-1", "s2-1"]}]}\n\`\`\``;
    }

    return `${registrySection}${constraintsSection}## 需求文档\n\n${requirementText}\n${taskSection}\n\n请根据上述需求文档，输出执行计划 JSON。\n\n返回格式：\n\`\`\`json\n{"reasoning": "...", "tasks": [{"id": "...", "type": "analyze|design|diagrams|tests", "description": "...", "depends_on": [...], "context_hints": {}}]}\n\`\`\``;
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

  /** 从任务记录中解析 analysisMode，支持 4 级优先级回退：analysis_mode → analysisMode → context_hints.analysisMode → context_hints.analysis_mode */
  private _parseAnalysisMode(ctx: Record<string, unknown>): Task["analysisMode"] {
    let rawMode = String(ctx.analysis_mode ?? ctx.analysisMode ?? "").trim();
    if (!rawMode) {
      const ch = ctx.context_hints;
      if (typeof ch === "object" && ch !== null) {
        const hints = ch as Record<string, unknown>;
        rawMode = String(hints.analysisMode ?? hints.analysis_mode ?? "").trim();
      }
    }
    return rawMode.toLowerCase() === "domain" ? "domain" : undefined;
  }

  _parseResponse(response: Record<string, unknown>, goal: string): ExecutionPlan {
    const tasksRaw = response.tasks as Array<Record<string, unknown>> | undefined;
    let tasks: Task[] = [];

    if (tasksRaw) {
      tasks = tasksRaw
        .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null && !Array.isArray(t))
        .map((t) => {
          const analysisMode = this._parseAnalysisMode(t);

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
        const analysisMode = this._parseAnalysisMode(t);
        return createTask({
          id: String(t.id || "").trim(),
          type: (String(t.type || "analyze").trim()) as Task["type"],
          description: String(t.description || "").trim(),
          dependsOn: Array.isArray(t.depends_on) ? t.depends_on.map((d) => String(d).trim()) : [],
          contextHints: (typeof t.context_hints === "object") ? t.context_hints as Record<string, unknown> : {},
          ...(analysisMode ? { analysisMode } : {}),
        });
      })

    const updateRaw = (response.update_tasks as Array<Record<string, unknown>>) ?? [];
    const updateTasks = updateRaw
      .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
      .map((t) => {
        const analysisMode = this._parseAnalysisMode(t);
        return createTask({
          id: String(t.id || "").trim(),
          type: (String(t.type || "analyze").trim()) as Task["type"],
          description: String(t.description || "").trim(),
          dependsOn: Array.isArray(t.depends_on) ? t.depends_on.map((d) => String(d).trim()) : [],
          contextHints: (typeof t.context_hints === "object") ? t.context_hints as Record<string, unknown> : {},
          ...(analysisMode ? { analysisMode } : {}),
        });
      })

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
  // 确定性 Planner（主路径）
  // ------------------------------------------------------------------

  static buildDeterministicPlan(
    goal: string,
    sectionIndex?: Array<{ id: string; depth: number; title: string; body: string; charRange: [number, number] }>,
  ): ExecutionPlan {
    const shards = PlanningTool._allocateAnalyzeShards(sectionIndex);
    const analyzeTasks = shards.length === 0
      ? [createTask({ id: "analyze-1", type: "analyze", description: "提取角色、功能、实体、约束等结构化信息" })]
      : shards.map((sectionIds, i) => createTask({
          id: `analyze-${i + 1}`,
          type: "analyze",
          description: `提取结构化信息 (shard ${i + 1}/${shards.length})`,
          contextHints: { assignedSections: sectionIds },
        }));

    if (goal.toLowerCase().includes("analyze")) {
      return createExecutionPlan({
        tasks: analyzeTasks,
        goal,
        reasoning: `deterministic: ${analyzeTasks.length} analyze shard(s), analyze-only`,
      });
    }

    const analyzeIds = analyzeTasks.map((t) => t.id);
    return createExecutionPlan({
      tasks: [
        ...analyzeTasks,
        createTask({ id: "domain-model-1", type: "domain_model", description: "生成领域概念模型（实体、枚举、泛化、关联类）", dependsOn: analyzeIds }),
        createTask({ id: "design-1", type: "design", description: "生成模块划分、核心类、接口与数据流", dependsOn: ["domain-model-1"] }),
        createTask({ id: "diagrams-class", type: "diagrams", description: "生成 Mermaid 领域类图", dependsOn: ["domain-model-1"], contextHints: { diagram_kind: "class_diagram" } }),
        createTask({ id: "diagrams-activity", type: "diagrams", description: "生成 Mermaid 活动图", dependsOn: ["design-1"], contextHints: { diagram_kind: "activity_diagram" } }),
        createTask({ id: "diagrams-state", type: "diagrams", description: "生成 Mermaid 状态图", dependsOn: ["design-1"], contextHints: { diagram_kind: "state_diagram" } }),
        createTask({ id: "tests-1", type: "tests", description: "生成正常/异常/边界测试用例", dependsOn: ["design-1"] }),
      ],
      goal,
      reasoning: `deterministic: ${analyzeTasks.length} analyze shard(s), with domain_model stage`,
    });
  }

  /**
   * Allocate leaf sections to analyze shards.
   *
   * Returns `[]` when the doc is simple enough for a single analyze pass.
   * `buildDeterministicPlan` treats `[]` as "create 1 analyze task with NO
   * assignedSections" — the worker receives the full requirement text without
   * slicing. This is intentional: sliceBySections is unnecessary overhead for
   * a single shard, and full-text avoids losing content between sections.
   *
   * Strategy: contiguous splitting with parent-boundary snapping.
   * Ideal cut points are snapped to the nearest parent (##) boundary within
   * ±SNAP_RADIUS positions, keeping same-parent sections together when possible.
   */
  static _allocateAnalyzeShards(
    sectionIndex?: Array<{ id: string; depth: number; title: string; body: string; charRange: [number, number] }>,
  ): string[][] {
    if (!sectionIndex || sectionIndex.length === 0) return [];

    // Collect leaf sections and track which parent each belongs to
    const leafIds: string[] = [];
    const leafParents: string[] = [];
    let currentParent = "";
    for (const s of sectionIndex) {
      if (s.depth <= 1) { currentParent = s.id; continue; }
      leafIds.push(s.id);
      leafParents.push(currentParent);
    }

    if (leafIds.length <= PlanningTool.SINGLE_SHARD_SECTION_LIMIT) return [];

    const shardCount = Math.max(2, Math.ceil(leafIds.length / PlanningTool.SECTIONS_PER_SHARD));

    // Parent boundary = index where the parent heading changes
    const boundarySet = new Set<number>();
    boundarySet.add(0);
    for (let i = 1; i < leafParents.length; i++) {
      if (leafParents[i] !== leafParents[i - 1]) boundarySet.add(i);
    }
    boundarySet.add(leafIds.length);

    // Build cut points, snapping to nearest parent boundary
    const SNAP_RADIUS = 3;
    const cuts: number[] = [0];
    for (let s = 1; s < shardCount; s++) {
      const ideal = Math.round(s * leafIds.length / shardCount);
      let best = ideal;
      for (let r = 0; r <= SNAP_RADIUS; r++) {
        if (boundarySet.has(ideal + r) && ideal + r < leafIds.length) { best = ideal + r; break; }
        if (r > 0 && boundarySet.has(ideal - r) && ideal - r > cuts[cuts.length - 1]) { best = ideal - r; break; }
      }
      if (best <= cuts[cuts.length - 1]) best = cuts[cuts.length - 1] + 1;
      if (best >= leafIds.length) break;
      cuts.push(best);
    }
    cuts.push(leafIds.length);

    const shards: string[][] = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const shard = leafIds.slice(cuts[i], cuts[i + 1]);
      if (shard.length > 0) shards.push(shard);
    }
    return shards;
  }

  private static _logShardMapping(
    plan: ExecutionPlan,
    logger: { info(msg: string): void },
  ): void {
    const analyzeTasks = plan.tasks.filter((t) => t.type === "analyze");
    const lines = analyzeTasks.map((t) => {
      const sections = t.contextHints?.assignedSections as string[] | undefined;
      if (!sections || sections.length === 0) return `  ${t.id}: full-text`;
      return `  ${t.id}: ${sections[0]}..${sections[sections.length - 1]} (${sections.length} sections)`;
    });
    logger.info(`plan: shard mapping (${analyzeTasks.length} shard(s)):\n${lines.join("\n")}`);
  }

  // ------------------------------------------------------------------
  // 降级策略（仅用于 LLM planner 模式的 fallback）
  // ------------------------------------------------------------------

  static _fallbackPlan(_requirementText: string, goal: string): ExecutionPlan {
    return PlanningTool.buildDeterministicPlan(goal);
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

  private static _stabilizeAnalyzeReplanMutation(
    mutation: PlanMutation,
    currentPlan: ExecutionPlan,
    completedTaskIds: string[],
    failedTaskIds: string[],
    evaluatorIssues: Issue[],
    reason: string,
  ): PlanMutation {
    const addedAnalyze = mutation.addTasks.filter((task) => task.type === "analyze");
    if (addedAnalyze.length === 0) return mutation;

    const currentAnalyzeTasks = currentPlan.tasks.filter((task) => task.type === "analyze");
    if (currentAnalyzeTasks.length === 0) return mutation;

    const analyzeIds = new Set(currentAnalyzeTasks.map((task) => task.id));
    const completed = new Set(completedTaskIds);
    const addedAnalyzeIds = new Set(addedAnalyze.map((task) => task.id));
    const issueTarget = evaluatorIssues
      .map((issue) => issue.targetTaskId)
      .find((taskId) => analyzeIds.has(taskId));
    const failedTarget = failedTaskIds.find((taskId) => analyzeIds.has(taskId));
    const latestAnalyze = PlanningTool._latestTaskIdOfType(currentPlan, "analyze", completedTaskIds);
    const targetId = issueTarget ?? failedTarget ?? latestAnalyze ?? currentAnalyzeTasks[0].id;
    const targetTask = currentAnalyzeTasks.find((task) => task.id === targetId) ?? currentAnalyzeTasks[0];
    const firstAdded = addedAnalyze[0];

    const idRemap = new Map<string, string>();
    for (const task of addedAnalyze) {
      idRemap.set(task.id, targetTask.id);
    }

    const rewriteDeps = (deps: string[]): string[] => {
      const result: string[] = [];
      const seen = new Set<string>();
      for (const dep of deps ?? []) {
        const rewritten = idRemap.get(dep) ?? dep;
        if (rewritten && !seen.has(rewritten)) {
          result.push(rewritten);
          seen.add(rewritten);
        }
      }
      return result;
    };

    const rewriteTaskDeps = (task: Task): Task => createTask({
      id: task.id,
      type: task.type,
      description: task.description,
      dependsOn: rewriteDeps(task.dependsOn),
      contextHints: { ...task.contextHints },
      ...(task.analysisMode ? { analysisMode: task.analysisMode } : {}),
    });

    const replacementAnalyze = createTask({
      id: targetTask.id,
      type: "analyze",
      description: firstAdded.description || `[replan] ${targetTask.description}`,
      dependsOn: rewriteDeps(firstAdded.dependsOn.length > 0 ? firstAdded.dependsOn : targetTask.dependsOn),
      contextHints: {
        ...targetTask.contextHints,
        ...firstAdded.contextHints,
        replan_redirected_from: [...addedAnalyzeIds],
        replan_reason: reason,
      },
      ...(firstAdded.analysisMode ?? targetTask.analysisMode
        ? { analysisMode: firstAdded.analysisMode ?? targetTask.analysisMode }
        : {}),
    });

    const addTasks = mutation.addTasks
      .filter((task) => task.type !== "analyze")
      .map(rewriteTaskDeps);
    let updateTasks = mutation.updateTasks
      .filter((task) => !addedAnalyzeIds.has(task.id) && task.id !== targetTask.id)
      .map(rewriteTaskDeps);

    const dropIds = mutation.dropTaskIds.filter(
      (taskId) => !addedAnalyzeIds.has(taskId) && (!completed.has(targetTask.id) || taskId !== targetTask.id),
    );

    if (completed.has(targetTask.id)) {
      updateTasks = [...updateTasks, replacementAnalyze];
    } else {
      addTasks.unshift(replacementAnalyze);
      if (!dropIds.includes(targetTask.id)) dropIds.push(targetTask.id);
    }

    const reorderEdges: Record<string, string[]> = {};
    for (const [taskId, deps] of Object.entries(mutation.reorderEdges)) {
      const rewrittenTaskId = idRemap.get(taskId) ?? taskId;
      reorderEdges[rewrittenTaskId] = rewriteDeps(deps);
    }

    return createPlanMutation({
      addTasks,
      updateTasks,
      dropTaskIds: [...new Set(dropIds)],
      reorderEdges,
      reasoning: mutation.reasoning
        ? `${mutation.reasoning} | stabilized analyze replan: redirected ${[...addedAnalyzeIds].join(", ")} to ${targetTask.id}`
        : `stabilized analyze replan: redirected ${[...addedAnalyzeIds].join(", ")} to ${targetTask.id}`,
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
    const latestDomainModel = PlanningTool._latestTaskIdOfType(currentPlan, "domain_model", completedTaskIds);
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

      let dependsOn: string[];
      if (taskType === "design") {
        dependsOn = latestDomainModel ? [latestDomainModel] : (latestAnalyze ? [latestAnalyze] : []);
      } else if (taskType === "diagrams" && diagramKind === "class_diagram") {
        dependsOn = latestDomainModel ? [latestDomainModel] : (latestDesignForDeps ? [latestDesignForDeps] : []);
      } else {
        dependsOn = latestDesignForDeps ? [latestDesignForDeps] : [];
      }

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


  static _ensureOrder(tasks: Task[]): Task[] {
    const analyzeIds = tasks.filter((t) => t.type === "analyze").map((t) => t.id);
    const domainModelIds = tasks.filter((t) => t.type === "domain_model").map((t) => t.id);
    const designIds = tasks.filter((t) => t.type === "design").map((t) => t.id);

    // Domain model upstream: analyze → domain_model
    const domainModelUpstream = analyzeIds;
    // Design upstream: domain_model (or analyze if no domain_model task)
    const designUpstream = domainModelIds.length > 0 ? domainModelIds : analyzeIds;

    for (const task of tasks) {
      if (task.type === "domain_model") {
        task.dependsOn = mergeDeps(task.dependsOn, domainModelUpstream);
      }
      if (task.type === "design") {
        task.dependsOn = mergeDeps(task.dependsOn, designUpstream);
      }
      if (task.type === "diagrams") {
        // Class diagram depends on domain_model (not design)
        // Activity/state diagrams depend on design
        const kind = String(task.contextHints?.diagram_kind ?? task.contextHints?.diagramKind ?? "").trim();
        if (kind === "class_diagram") {
          task.dependsOn = mergeDeps(task.dependsOn, domainModelIds.length > 0 ? domainModelIds : designIds);
        } else {
          task.dependsOn = mergeDeps(task.dependsOn, designIds);
        }
      }
      if (task.type === "tests") {
        task.dependsOn = mergeDeps(task.dependsOn, designIds);
      }
    }
    return tasks;
  }

  /** Docs with ≤ this many leaf sections collapse to a single analyze shard. */
  static readonly SINGLE_SHARD_SECTION_LIMIT = 20;
  /** Each shard handles roughly this many leaf sections; used to cap excessive shards. */
  static readonly SECTIONS_PER_SHARD = 20;

  /**
   * Smart shard capping based on document structure, not raw byte size.
   *
   * - ≤ SINGLE_SHARD_SECTION_LIMIT leaf sections → collapse to 1 shard
   *   (single-pass avoids merge noise for simple docs)
   * - Above that → keep multi-shard, but cap at ceil(leafSections / SECTIONS_PER_SHARD)
   *   to prevent over-fragmentation on moderately complex docs
   */
  static _capAnalyzeShards(
    plan: ExecutionPlan,
    requirementText: string,
    sectionIndex?: Array<{ id: string; depth: number; title: string; body: string; charRange: [number, number] }>,
  ): ExecutionPlan {
    const analyzeTasks = plan.tasks.filter((t) => t.type === "analyze");
    if (analyzeTasks.length <= 1) return plan;

    const leafSections = sectionIndex && sectionIndex.length > 0
      ? sectionIndex.filter((s) => s.depth >= 2).length
      : (requirementText.match(/^###\s/gm) ?? []).length;

    if (leafSections <= PlanningTool.SINGLE_SHARD_SECTION_LIMIT) {
      return PlanningTool._collapseToOneAnalyze(plan, analyzeTasks);
    }

    const maxShards = Math.max(2, Math.ceil(leafSections / PlanningTool.SECTIONS_PER_SHARD));
    if (analyzeTasks.length <= maxShards) return plan;

    return PlanningTool._trimAnalyzeShards(plan, analyzeTasks, maxShards);
  }

  private static _collapseToOneAnalyze(plan: ExecutionPlan, analyzeTasks: Task[]): ExecutionPlan {
    const keepId = analyzeTasks[0].id;
    const removed = new Set(analyzeTasks.slice(1).map((t) => t.id));

    const tasks: Task[] = [];
    for (const t of plan.tasks) {
      if (removed.has(t.id)) continue;
      if (t.id === keepId) {
        const hints = { ...(t.contextHints ?? {}) } as Record<string, unknown>;
        delete hints.assignedSections;
        tasks.push({ ...t, contextHints: hints });
        continue;
      }
      if (Array.isArray(t.dependsOn) && t.dependsOn.some((d) => removed.has(d))) {
        const deps = [...new Set(t.dependsOn.map((d) => (removed.has(d) ? keepId : d)))];
        tasks.push({ ...t, dependsOn: deps });
        continue;
      }
      tasks.push(t);
    }
    return { ...plan, tasks };
  }

  private static _trimAnalyzeShards(plan: ExecutionPlan, analyzeTasks: Task[], maxShards: number): ExecutionPlan {
    const kept = analyzeTasks.slice(0, maxShards);
    const removed = new Set(analyzeTasks.slice(maxShards).map((t) => t.id));
    const lastKeptId = kept[kept.length - 1].id;

    const tasks: Task[] = [];
    for (const t of plan.tasks) {
      if (removed.has(t.id)) {
        // Merge removed shard's sections into the last kept shard
        const lastKept = tasks.find((k) => k.id === lastKeptId);
        if (lastKept) {
          const existingSections = (lastKept.contextHints?.assignedSections as string[] | undefined) ?? [];
          const extraSections = (t.contextHints?.assignedSections as string[] | undefined) ?? [];
          if (extraSections.length > 0) {
            (lastKept.contextHints as Record<string, unknown>).assignedSections =
              [...new Set([...existingSections, ...extraSections])];
          }
        }
        continue;
      }
      if (Array.isArray(t.dependsOn) && t.dependsOn.some((d) => removed.has(d))) {
        const deps = [...new Set(t.dependsOn.map((d) => (removed.has(d) ? lastKeptId : d)))];
        tasks.push({ ...t, dependsOn: deps });
        continue;
      }
      tasks.push(t);
    }
    return { ...plan, tasks };
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
