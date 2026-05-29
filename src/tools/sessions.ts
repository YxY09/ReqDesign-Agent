import { performance } from "node:perf_hooks";
import type { EvaluationTool } from "./evaluation.js";
import { GenerationTool } from "./generation.js";
import type { PlanningTool } from "./planning.js";
import { RepairTool } from "./repair.js";
import { createArtifact, createTask, type Artifact, type ExecutionPlan, type Task } from "../shared/types.js";
import type { TaskMessage, TaskNotification } from "../messaging.js";
import { SessionContext, WorkerSession } from "../session.js";
import { isRecord } from "../utils/isRecord.js";
import { setupLogger, type Logger } from "../logger.js";
import { cloneTask } from "../shared/taskUtils.js";

function normalizeFixInstructions(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => isRecord(item));
}

function isStrictSelfCheckFailure(artifact: Artifact): boolean {
  if (artifact.selfCheckPassed) return false;
  if (artifact.type === "tests") return false;
  if (artifact.type === "analyze") return true;

  const strictPatterns = [
    "未在需求中识别",
    "未定义",
    "未被测试用例覆盖",
    "未被测试覆盖",
    "缺少项目宪法要求的标题格式",
    "优先级必须使用 P0/P1/P2",
    "引用了未定义",
  ];
  return artifact.selfCheckIssues.some((issue) =>
    strictPatterns.some((pattern) => issue.includes(pattern)),
  );
}

function cloneTaskForRun(context: SessionContext, contextHints: Record<string, unknown>): Task {
  const base = context.task
    ? cloneTask(context.task)
    : createTask({
        id: context.taskId,
        type: context.taskType as Task["type"],
        description: context.taskDescription,
      });

  return cloneTask(base, {
    ...base,
    id: context.taskId || base.id,
    type: (context.taskType || base.type) as Task["type"],
    description: context.taskDescription || base.description,
    contextHints,
  });
}

function pickObjectFields(
  source: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (source[field] !== undefined) picked[field] = source[field];
  }
  return picked;
}

function diagramKindForTask(task: Task): string {
  const hints = (task.contextHints ?? {}) as Record<string, unknown>;
  const explicit = String(hints.diagram_kind ?? hints.diagramKind ?? "").trim();
  if (explicit) return explicit;
  const text = `${task.id} ${task.description}`.toLowerCase();
  if (text.includes("activity") || text.includes("活动")) return "activity_diagram";
  if (text.includes("state") || text.includes("状态")) return "state_diagram";
  if (text.includes("class") || text.includes("类图")) return "class_diagram";
  return "";
}

function requirementForTask(
  task: Task,
  requirementJson: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.keys(requirementJson).length === 0) return {};
  if (task.type === "analyze") return {};
  if (task.type === "design") return requirementJson;
  if (task.type === "tests") {
    return pickObjectFields(requirementJson, [
      "actors",
      "functions",
      "exceptions",
      "constraints",
      "non_functional_requirements",
      "business_processes",
    ]);
  }
  if (task.type === "diagrams") {
    const kind = diagramKindForTask(task);
    if (kind === "class_diagram") {
      return pickObjectFields(requirementJson, [
        "entities",
        "actors",
      ]);
    }
    if (kind === "activity_diagram") {
      return pickObjectFields(requirementJson, [
        "actors",
        "functions",
        "business_processes",
        "constraints",
        "exceptions",
      ]);
    }
    if (kind === "state_diagram") {
      return pickObjectFields(requirementJson, [
        "entities",
        "constraints",
        "exceptions",
      ]);
    }
    return pickObjectFields(requirementJson, [
      "entities",
      "actors",
      "functions",
      "business_processes",
      "constraints",
      "exceptions",
    ]);
  }
  return requirementJson;
}

function designTextForTask(task: Task, designText: string): string {
  if (!designText) return "";
  if (task.type === "design" || task.type === "analyze") return "";
  // Keep design text lossless once it is selected. Token reduction happens by
  // omitting whole irrelevant channels, not by slicing continuous design prose.
  return designText;
}

export class GenerationSession extends WorkerSession {
  private readonly agent: GenerationTool;
  private readonly logger: Logger = setupLogger("reqdesign.GenerationSession");

  constructor(
    sessionId: string,
    context: SessionContext,
    mailbox: { sendNotification: (notif: TaskNotification) => void } | null,
    llm: unknown,
    agent: GenerationTool,
  ) {
    super(sessionId, context, mailbox, llm);
    this.agent = agent;
    this.state.workerType = this.workerType;
  }

  get workerType(): string {
    return "generator";
  }

  async run(message: TaskMessage): Promise<TaskNotification> {
    this.state.messageCount += 1;
    this.markHeartbeat();
    this.logger.info(`run: task=${this.context.taskId}，message=${message.type}，msgCount=${this.state.messageCount}`);

    if (message.type === "stop") {
      this.state.finished = true;
      this.logger.info(`run: task=${this.context.taskId} 收到停止指令`);
      return this._makeNotification("cancelled", {
        summary: "session stopped by coordinator",
      });
    }

    const baseTask = cloneTaskForRun(this.context, this.context.hints);
    const ctx = this.buildAgentContext(baseTask);
    const task = cloneTaskForRun(this.context, isRecord(ctx._hints) ? ctx._hints : this.context.hints);

    const artifact = await this.agent.execute(task, ctx);

    this.markHeartbeat();

    if (artifact.content !== null && artifact.content !== undefined) {
      this.state.intermediateState.last_artifact = artifact;
    }

    if (artifact.content === null || artifact.content === undefined) {
      return this._makeNotification("failed", {
        summary: `generation returned None for ${this.context.taskId}`,
        error: artifact.selfCheckIssues[0] ?? "unknown error",
      });
    }

    if (isStrictSelfCheckFailure(artifact)) {
      return this._makeNotification("failed", {
        summary: `strict self-check failed: ${artifact.selfCheckIssues.length} issues`,
        error: artifact.selfCheckIssues.slice(0, 5).join("; "),
        result: artifact,
      });
    }

    if (!artifact.selfCheckPassed) {
      return this._makeNotification("completed", {
        summary: `self-check warning: ${artifact.selfCheckIssues.length} issues after ${artifact.selfCorrectRounds} corrections`,
        result: artifact,
      });
    }

    return this._makeNotification("completed", {
      summary: `generated ${this.context.taskType} in ${artifact.generationDuration.toFixed(1)}s`,
      result: artifact,
    });
  }

  private buildAgentContext(task: Task): Record<string, unknown> {
    const ctx: Record<string, unknown> = {};
    if (task.type === "analyze" && this.context.requirementText) {
      ctx.requirement_text = this.context.requirementText;
    }
    const requirementJson = requirementForTask(task, this.context.requirementJson);
    if (Object.keys(requirementJson).length > 0) ctx.requirement_json = requirementJson;
    const designText = designTextForTask(task, this.context.designText);
    if (designText) ctx.design_text = designText;
    if (!ctx.requirement_json && !ctx.design_text) {
      ctx.requirement_text = this.context.requirementText;
    }
    if (Object.keys(this.context.hints).length > 0) {
      ctx._hints = { ...this.context.hints };
    }
    if (this.context.registry) {
      ctx.registry = this.context.registry;
    }
    ctx._provenance = this.context.provenance;
    return ctx;
  }
}

export class EvaluationSession extends WorkerSession {
  private readonly agent: EvaluationTool;
  private readonly logger: Logger = setupLogger("reqdesign.EvaluationSession");

  constructor(
    sessionId: string,
    context: SessionContext,
    mailbox: { sendNotification: (notif: TaskNotification) => void } | null,
    llm: unknown,
    agent: EvaluationTool,
  ) {
    super(sessionId, context, mailbox, llm);
    this.agent = agent;
    this.state.workerType = this.workerType;
  }

  get workerType(): string {
    return "evaluator";
  }

  async run(message: TaskMessage): Promise<TaskNotification> {
    this.state.messageCount += 1;
    this.markHeartbeat();
    this.logger.info(`run: evaluator，message=${message.type}，scope=${this.context.evaluateScope?.join(",") ?? "all"}`);

    if (message.type === "stop") {
      this.state.finished = true;
      return this._makeNotification("cancelled", {
        summary: "session stopped by coordinator",
      });
    }

    const evaluatedTaskIds = this.context.evaluateScope.length > 0
      ? [...this.context.evaluateScope]
      : undefined;
    // 从上下文构建之前的问题以进行增量审查
    const previousIssues = this.context.previousIssues as Array<{ severity: string; description: string; location?: string }> | undefined;
    const verdict = await this.agent.evaluate(
      this.context.requirementText,
      this.context.requirementJson,
      this.context.designText,
      this.context.diagrams as Record<string, string>,
      this.context.testCases,
      this.context.artifactSummary,
      this.context.artifactSnapshots,
      this.context.goal,
      this.context.isDirectMode,
      evaluatedTaskIds,
      previousIssues,
    );
    verdict.isFinalReview = evaluatedTaskIds === undefined;

    this.markHeartbeat();

    const suggestions = verdict.fixes.map((fix) => {
      const targetTaskId = fix.dependsOn[0] ?? fix.id;
      const matching = verdict.issues.filter((issue) => issue.targetTaskId === targetTaskId);
      const severity = matching[0]?.severity ?? "major";
      const targetFields = matching
        .map((issue) => issue.targetField)
        .filter(Boolean);
      return {
        task_id: targetTaskId,
        repair_task_id: fix.id,
        task_type: fix.type,
        target_field: targetFields.join(", "),
        description: fix.description,
        suggestion: Array.isArray(fix.contextHints.fix_instructions)
          ? fix.contextHints.fix_instructions.map((item) => String(item)).join("; ")
          : "",
        severity,
        issues: matching.map((issue) => ({
          severity: issue.severity,
          target_field: issue.targetField,
          description: issue.description,
          suggestion: issue.suggestion,
        })),
      };
    });

    return this._makeNotification(verdict.passed ? "completed" : "rejected", {
      summary: `evaluation ${verdict.passed ? "passed" : "rejected"} (issues=${verdict.issues.length}, blockers=${verdict.issues.filter((issue) => issue.severity === "blocker").length})`,
      result: verdict,
      suggestions,
    });
  }
}

export class PlanningSession extends WorkerSession {
  private readonly agent: PlanningTool;
  private readonly logger: Logger = setupLogger("reqdesign.PlanningSession");

  constructor(
    sessionId: string,
    context: SessionContext,
    mailbox: { sendNotification: (notif: TaskNotification) => void } | null,
    llm: unknown,
    agent: PlanningTool,
  ) {
    super(sessionId, context, mailbox, llm);
    this.agent = agent;
    this.state.workerType = this.workerType;
  }

  get workerType(): string {
    return "planner";
  }

  async run(message: TaskMessage): Promise<TaskNotification> {
    this.state.messageCount += 1;
    this.markHeartbeat();
    this.logger.info(`run: planner，message=${message.type}`);

    if (message.type === "stop") {
      this.state.finished = true;
      return this._makeNotification("cancelled", {
        summary: "session stopped by coordinator",
      });
    }

    if (message.type === "repair" || message.type === "replan") {
      return this.runReplan(message);
    }

    const sectionIndex = Array.isArray(this.context.hints?.sectionIndex)
      ? this.context.hints.sectionIndex as Array<{ id: string; depth: number; title: string; body: string; charRange: [number, number] }>
      : undefined;
    const plan = await this.agent.plan(this.context.requirementText, this.context.goal, sectionIndex);
    this.markHeartbeat();
    this.state.intermediateState.last_plan = plan;
    this.logger.info(`run: 规划完成，${plan.tasks.length} 个任务`);

    return this._makeNotification(plan.tasks.length > 0 ? "completed" : "failed", {
      summary: `planned ${plan.tasks.length} tasks`,
      result: plan,
      error: plan.tasks.length > 0 ? "" : "plan returned no tasks",
    });
  }

  private async runReplan(message: TaskMessage): Promise<TaskNotification> {
    this.markHeartbeat();

    const payload = message.payload ?? {};
    const currentPlan = (payload.current_plan as ExecutionPlan | undefined)
      ?? (this.state.intermediateState.last_plan as ExecutionPlan | undefined);
    if (!currentPlan) {
      return this._makeNotification("failed", {
        summary: "replan failed: no current plan available",
        error: "no plan to mutate",
      });
    }

    const completedTaskIds = Array.isArray(payload.completed_task_ids)
      ? payload.completed_task_ids.map((item) => String(item))
      : [];
    const failedTaskIds = Array.isArray(payload.failed_task_ids)
      ? payload.failed_task_ids.map((item) => String(item))
      : [];
    const replanReason = String(payload.replan_reason ?? "coordinator requested replan");
    const evaluatorIssues = Array.isArray(payload.evaluator_issues)
      ? payload.evaluator_issues.filter((item): item is Record<string, unknown> => isRecord(item)).map((item) => ({
        severity: String(item.severity ?? "major") as "blocker" | "major" | "minor",
        targetTaskId: String(item.targetTaskId ?? item.target_task_id ?? ""),
        targetTaskType: String(item.targetTaskType ?? item.target_task_type ?? ""),
        targetField: String(item.targetField ?? item.target_field ?? ""),
        description: String(item.description ?? ""),
        suggestion: String(item.suggestion ?? ""),
        scope: String(item.scope ?? "") as "" | "local" | "upstream" | "systemic",
      }))
      : [];
    const mutation = await this.agent.replan(
      this.context.requirementText,
      currentPlan,
      completedTaskIds,
      failedTaskIds,
      evaluatorIssues,
      isRecord(payload.artifact_summary) ? payload.artifact_summary : {},
      replanReason,
    );

    this.markHeartbeat();
    this.state.intermediateState.last_mutation = mutation;
    this.state.intermediateState.replan_count = Number(this.state.intermediateState.replan_count ?? 0) + 1;

    return this._makeNotification("completed", {
      summary: `replanned: +${mutation.addTasks.length} ~${mutation.updateTasks.length} -${mutation.dropTaskIds.length}`,
      result: mutation,
    });
  }
}

// ---------------------------------------------------------------------------
// RepairSession（修复会话）
// ---------------------------------------------------------------------------

export class RepairSession extends WorkerSession {
  private readonly agent: RepairTool;
  private readonly logger: Logger = setupLogger("reqdesign.RepairSession");

  constructor(
    sessionId: string,
    context: SessionContext,
    mailbox: { sendNotification: (notif: TaskNotification) => void } | null,
    llm: unknown,
    agent: RepairTool,
  ) {
    super(sessionId, context, mailbox, llm);
    this.agent = agent;
    this.state.workerType = this.workerType;
  }

  get workerType(): string {
    return "repair";
  }

  async run(message: TaskMessage): Promise<TaskNotification> {
    this.state.messageCount += 1;
    this.markHeartbeat();
    this.logger.info(`run: task=${this.context.taskId}，message=repair，msgCount=${this.state.messageCount}`);

    const started = performance.now();
    const baseTask = cloneTaskForRun(this.context, this.context.hints);
    const ctx = this._buildRepairContext(message, baseTask);

    if (this.agent.llm === null) {
      return this._makeNotification("failed", {
        summary: `repair failed: no LLM client`,
        error: "repair requires an LLM client",
      });
    }

    const previousContent = ctx.previous_artifact as unknown;
    if (previousContent === null || previousContent === undefined) {
      return this._makeNotification("failed", {
        summary: `repair failed: no previous artifact to repair`,
        error: "no previous artifact content available",
      });
    }

    const task = cloneTaskForRun(this.context, isRecord(ctx._hints) ? ctx._hints : this.context.hints);

    const fixInstructions = normalizeFixInstructions(message.payload.fix_instructions);
    const repaired = await this.agent.repair(task, previousContent, fixInstructions, ctx);

    this.markHeartbeat();

    if (repaired === null || repaired === undefined) {
      return this._makeNotification("failed", {
        summary: `repair returned no content`,
        error: "repair returned no content",
      });
    }

    const issues = GenerationTool._ruleCheck(task, repaired, ctx);
    const totalRounds = fixInstructions.length > 0 ? 1 : 0;
    const elapsed = (performance.now() - started) / 1000;

    const artifact = createArtifact({
      taskId: task.id,
      type: task.type,
      content: repaired,
      selfCheckPassed: issues.length === 0,
      selfCheckIssues: issues,
      selfCorrectRounds: totalRounds,
      generationDuration: elapsed,
    });

    this.state.intermediateState.last_artifact = artifact;

    const history = Array.isArray(this.state.intermediateState.fix_history)
      ? [...(this.state.intermediateState.fix_history as Array<Record<string, unknown>>)]
      : [];
    history.push({
      timestamp: Date.now() / 1000,
      fix_instructions: fixInstructions,
      self_check_passed: artifact.selfCheckPassed,
      self_correct_rounds: artifact.selfCorrectRounds,
      issues_count: artifact.selfCheckIssues.length,
    });
    this.state.intermediateState.fix_history = history.slice(-10);
    this.state.intermediateState.last_fix_instructions = fixInstructions;

    return this._makeNotification("completed", {
      summary: `repaired ${this.context.taskType} in ${elapsed.toFixed(1)}s`,
      result: artifact,
    });
  }

  private _buildRepairContext(message: TaskMessage, task: Task): Record<string, unknown> {
    const ctx: Record<string, unknown> = {};

    // 从 context.hints 中获取之前的 artifact（由 runtime 从之前的会话中获取）
    if (this.context.hints.previous_artifact_content !== undefined) {
      ctx.previous_artifact = this.context.hints.previous_artifact_content;
    }
    if (this.context.hints.previous_artifact_type !== undefined) {
      ctx.previous_artifact_type = this.context.hints.previous_artifact_type;
    }
    if (this.context.hints.previous_artifact_revision !== undefined) {
      ctx.previous_artifact_revision = this.context.hints.previous_artifact_revision;
    }

    // 修订历史记录
    const fixHistory = this.state.intermediateState.fix_history;
    if (Array.isArray(fixHistory)) {
      ctx.revision_history = fixHistory;
    }

    // 需求上下文
    const requirementJson = requirementForTask(task, this.context.requirementJson);
    if (Object.keys(requirementJson).length > 0) ctx.requirement_json = requirementJson;
    const designText = designTextForTask(task, this.context.designText);
    if (designText) ctx.design_text = designText;
    ctx._provenance = this.context.provenance;

    // 修复指令作为 hints
    const fixInstructions = normalizeFixInstructions(message.payload.fix_instructions);
    if (fixInstructions.length > 0) {
      ctx._hints = {
        ...this.context.hints,
        fix_instructions: fixInstructions,
        revision: this.state.resumeCount,
      };
    }

    return ctx;
  }
}
