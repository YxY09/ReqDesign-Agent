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

function normalizeFixInstructions(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => isRecord(item));
}

function isStrictSelfCheckFailure(artifact: Artifact): boolean {
  if (artifact.selfCheckPassed) return false;
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

    const ctx = this.buildAgentContext();
    const fixInstructions = normalizeFixInstructions(message.payload.fix_instructions);
    if (message.type === "repair" && fixInstructions.length > 0) {
      const nextHints = isRecord(ctx._hints) ? { ...ctx._hints } : {};
      nextHints.fix_instructions = fixInstructions;
      nextHints.revision = this.state.resumeCount;
      ctx._hints = nextHints;
    }

    const previousArtifact = this.state.intermediateState.last_artifact as Artifact | undefined;
    if (previousArtifact?.content !== null && previousArtifact?.content !== undefined) {
      ctx.previous_artifact = previousArtifact.content;
      ctx.previous_artifact_type = previousArtifact.type;
      ctx.revision_history = Array.isArray(this.state.intermediateState.fix_history)
        ? this.state.intermediateState.fix_history
        : [];
    }

    const task = createTask({
      id: this.context.taskId,
      type: this.context.taskType as Task["type"],
      description: this.context.taskDescription,
      contextHints: isRecord(ctx._hints) ? ctx._hints : this.context.hints,
    });

    const artifact = message.type === "repair" && previousArtifact?.content !== undefined
      ? await this.repairFromPrevious(task, ctx, previousArtifact, fixInstructions)
      : await this.agent.execute(task, ctx);

    this.markHeartbeat();

    if (artifact.content !== null && artifact.content !== undefined) {
      this.state.intermediateState.last_artifact = artifact;
    }

    if (message.type === "repair") {
      const history = Array.isArray(this.state.intermediateState.fix_history)
        ? [...(this.state.intermediateState.fix_history as Array<Record<string, unknown>>)]
        : [];
      history.push({
        timestamp: Date.now() / 1000,
        fix_instructions: fixInstructions,
        used_previous_artifact: previousArtifact !== undefined,
        self_check_passed: artifact.selfCheckPassed,
        self_correct_rounds: artifact.selfCorrectRounds,
        issues_count: artifact.selfCheckIssues.length,
      });
      this.state.intermediateState.fix_history = history.slice(-10);
      this.state.intermediateState.last_fix_instructions = fixInstructions;

      const selfCheckHistory = Array.isArray(this.state.intermediateState.self_check_history)
        ? [...(this.state.intermediateState.self_check_history as Array<Record<string, unknown>>)]
        : [];
      selfCheckHistory.push({
        timestamp: Date.now() / 1000,
        passed: artifact.selfCheckPassed,
        issues: artifact.selfCheckIssues.slice(0, 5),
        correct_rounds: artifact.selfCorrectRounds,
      });
      this.state.intermediateState.self_check_history = selfCheckHistory.slice(-20);
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

  private async repairFromPrevious(
    task: Task,
    ctx: Record<string, unknown>,
    previousArtifact: Artifact,
    fixInstructions: Array<Record<string, unknown>>,
  ): Promise<Artifact> {
    const started = performance.now();
    if (this.agent.llm === null) {
      return createArtifact({
        taskId: task.id,
        type: task.type,
        content: null,
        selfCheckPassed: false,
        selfCheckIssues: ["repair requires an LLM client"],
        generationDuration: (performance.now() - started) / 1000,
      });
    }

    const repairAgent = new RepairTool(this.agent.llm);
    const repaired = await repairAgent.repair(
      task,
      previousArtifact.content,
      fixInstructions,
      ctx,
    );

    if (repaired === null || repaired === undefined) {
      return createArtifact({
        taskId: task.id,
        type: task.type,
        content: null,
        selfCheckPassed: false,
        selfCheckIssues: ["session repair returned no content"],
        generationDuration: (performance.now() - started) / 1000,
      });
    }

    const issues = GenerationTool._ruleCheck(task, repaired, ctx);
    return createArtifact({
      taskId: task.id,
      type: task.type,
      content: repaired,
      selfCheckPassed: issues.length === 0,
      selfCheckIssues: issues,
      selfCorrectRounds: 1,
      generationDuration: (performance.now() - started) / 1000,
    });
  }

  private buildAgentContext(): Record<string, unknown> {
    const ctx: Record<string, unknown> = {};
    if (this.context.requirementText) ctx.requirement_text = this.context.requirementText;
    if (Object.keys(this.context.requirementJson).length > 0) ctx.requirement_json = this.context.requirementJson;
    if (this.context.designText) ctx.design_text = this.context.designText;
    if (!ctx.requirement_json && !ctx.design_text) {
      ctx.requirement_text = this.context.requirementText;
    }
    if (Object.keys(this.context.hints).length > 0) {
      ctx._hints = { ...this.context.hints };
    }
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
    // Build previous issues from context for incremental review
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

    const plan = await this.agent.plan(this.context.requirementText, this.context.goal);
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
