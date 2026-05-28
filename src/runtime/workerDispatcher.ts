import type { Logger } from "../logger.js";
import { isRecord } from "../utils/isRecord.js";
import { WorkerFactory } from "../execution/factory.js";
import { SessionBackend } from "../execution/backend.js";
import { SessionContext, SessionRegistry } from "../session.js";
import { createTaskMessage, TaskMailbox, type TaskMessage } from "../messaging.js";
import type { WorkflowState } from "../state.js";
import {
  createTask,
  type InflightWorker,
  type RuntimeAction,
  type Task,
  type WorkerKind,
} from "../shared/types.js";
import { sliceBySections, type SectionIndex } from "../xmlParser.js";

/** Build a section TOC string from sectionIndex for global context prepending. */
export function buildSectionToc(sectionIndex: SectionIndex[]): string {
  if (sectionIndex.length === 0) return "";
  const lines = ["[文档章节目录]"];
  for (const section of sectionIndex) {
    const indent = "  ".repeat(section.depth - 1);
    lines.push(`${indent}- ${section.title}`);
  }
  return lines.join("\n");
}

/** Mutable state dependencies injected from MultiAgentRuntime. */
export interface WorkerDispatcherDeps {
  factory: WorkerFactory;
  backend: SessionBackend;
  sessions: SessionRegistry;
  logger: Logger;
  defaultTimeoutSeconds: number;
  getActiveStreamContext: () => {
    workerType: WorkerKind;
    taskId: string;
    taskType: string;
    sessionId: string;
  } | null;
  setActiveStreamContext: (
    v: {
      workerType: WorkerKind;
      taskId: string;
      taskType: string;
      sessionId: string;
    } | null,
  ) => void;
  getInflight: () => Map<string, InflightWorker>;
}

export class WorkerDispatcher {
  private readonly deps: WorkerDispatcherDeps;

  constructor(deps: WorkerDispatcherDeps) {
    this.deps = deps;
  }

  dispatchSpawn(state: WorkflowState, decision: RuntimeAction): boolean {
    const taskId = decision.taskId?.trim() ?? "";
    if (!taskId) {
      return false;
    }
    if (taskId === "planner") {
      return this.submitPlanner(state, "spawn", decision);
    }
    if (taskId === "evaluator") {
      return this.submitEvaluator(state, decision.evaluateScope ?? []);
    }
    return this.submitGeneratorTask(state, taskId, decision);
  }

  submitPlanner(
    state: WorkflowState,
    messageType: "spawn" | "replan",
    decision: RuntimeAction,
  ): boolean {
    if (state.taskStatus("planner") === "running") {
      return false;
    }
    const context = new SessionContext({
      taskId: "planner",
      taskType: "planner",
      taskDescription:
        messageType === "replan"
          ? "mutate execution plan"
          : "generate execution plan",
      goal: state.goal,
      requirementText: state.requirementText,
      requirementJson: state.requirementJson,
      designText: state.designText,
      diagrams: state.diagrams,
      testCases: state.testCases,
      artifactSummary: state.artifactSummary(),
      artifactSnapshots: state.artifactSnapshots(),
      isDirectMode: state.isDirectMode,
      hints: {
        ...(decision.replanContext ?? {}),
        sectionIndex: state.sectionIndex.length > 0 ? state.sectionIndex : undefined,
      },
    });
    const message = createTaskMessage({
      type: messageType,
      taskId: "planner",
      sessionId: "",
      replanContext: decision.replanContext,
      cause: decision.reason,
      payload: messageType === "replan" && state.plan
        ? { current_plan: state.plan }
        : undefined,
    });
    return this.submitWorker(
      state,
      "planner",
      context,
      message,
      this.deps.defaultTimeoutSeconds,
      [],
      decision,
    );
  }

  submitEvaluator(
    state: WorkflowState,
    evaluateScope: string[],
  ): boolean {
    if (state.taskStatus("evaluator") === "running") {
      return false;
    }
    // 从上次的裁决构建之前的问题以进行增量审查
    const lastVerdict = state.latestVerdict;
    const previousIssues = lastVerdict?.issues?.map((i) => ({
      severity: i.severity,
      description: `${i.description} (task: ${i.targetTaskId}, field: ${i.targetField})`,
    })) ?? [];
    const artifactSnapshots = evaluateScope.length > 0
      ? state.artifactSnapshots(evaluateScope)
      : state.finalArtifactSnapshots();
    const context = new SessionContext({
      taskId: "evaluator",
      taskType: "evaluator",
      taskDescription: "review workflow outputs",
      goal: state.goal,
      requirementText: state.requirementText,
      requirementJson: state.requirementJson,
      designText: state.designText,
      diagrams: state.diagrams,
      testCases: state.testCases,
      artifactSummary: state.artifactSummary(),
      artifactSnapshots,
      isDirectMode: state.isDirectMode,
      evaluateScope: [...evaluateScope],
      previousIssues,
    });
    const message = createTaskMessage({
      type: "spawn",
      taskId: "evaluator",
      sessionId: "",
    });
    return this.submitWorker(
      state,
      "evaluator",
      context,
      message,
      this.deps.defaultTimeoutSeconds,
      evaluateScope,
    );
  }

  submitGeneratorTask(
    state: WorkflowState,
    taskId: string,
    decision: RuntimeAction,
  ): boolean {
    if (state.taskStatus(taskId) === "running") {
      return false;
    }

    let task = state.plan?.tasks.find((item) => item.id === taskId) ?? null;
    if (!task && taskId === "direct_diagrams") {
      task = createTask({
        id: "direct_diagrams",
        type: "diagrams",
        description: "generate diagrams in direct mode",
      });
      state.isDirectMode = true;
    }
    if (!task && state.goal === "analyze" && taskId === "analyze-1") {
      task = createTask({
        id: "analyze-1",
        type: "analyze",
        description: "提取角色、功能、实体、约束等结构化信息",
      });
    }
    if (!task) {
      return false;
    }

    const message = createTaskMessage({
      type: "spawn",
      taskId,
      sessionId: "",
      cause: decision.reason,
      payload: {},
    });
    return this.submitWorker(
      state,
      "generator",
      this.buildTaskContext(state, task),
      message,
      this.deps.defaultTimeoutSeconds,
      [],
      decision,
    );
  }

  submitRepairTask(
    state: WorkflowState,
    taskId: string,
    decision: RuntimeAction,
  ): boolean {
    if (state.taskStatus(taskId) === "running") {
      return false;
    }

    const task = state.plan?.tasks.find((item) => item.id === taskId) ?? null;
    if (!task) {
      return false;
    }

    const issues = state.latestVerdict
      ? state.latestVerdict.issues.filter((issue) => issue.targetTaskId === taskId)
      : [];

    const message = createTaskMessage({
      type: "repair",
      taskId,
      sessionId: "",
      cause: decision.reason,
      payload: {
        fix_instructions: issues.map((issue) => ({
          severity: issue.severity,
          target_field: issue.targetField,
          description: issue.description,
          suggestion: issue.suggestion,
          task_id: issue.targetTaskId,
          task_type: issue.targetTaskType,
        })),
      },
      repairScope: "local",
    });

    // Extract previous artifact content from recent session for repair context
    const context = this.buildTaskContext(state, task);
    const prevSession = this.deps.sessions.latestSessionForTask(taskId);
    if (prevSession) {
      const descriptor = prevSession.exportDescriptor();
      const lastArtifact = descriptor.intermediateState?.last_artifact;
      if (
        isRecord(lastArtifact) &&
        lastArtifact.content !== undefined &&
        lastArtifact.content !== null
      ) {
        context.hints.previous_artifact_content = lastArtifact.content;
        context.hints.previous_artifact_type = lastArtifact.type;
      }
    }

    return this.submitWorker(
      state,
      "repair",
      context,
      message,
      this.deps.defaultTimeoutSeconds,
      [],
      decision,
    );
  }

  submitWorker(
    _state: WorkflowState,
    workerType: WorkerKind,
    context: SessionContext,
    message: TaskMessage,
    timeoutSeconds: number,
    evaluateScope: string[],
    decision?: RuntimeAction,
  ): boolean {
    const sessionId =
      message.sessionId || TaskMailbox.generateSessionId(context.taskId);
    message.sessionId = sessionId;
    context.taskId = context.taskId || message.taskId;

    const session = this.deps.factory.createSession(workerType, sessionId, context);

    this.deps.sessions.register(session);
    this.deps.setActiveStreamContext({
      workerType,
      taskId: context.taskId,
      taskType: context.taskType,
      sessionId,
    });

    // 提交（带并发控制，fire-and-forget）
    this.deps.backend
      .submitSession(session, message, timeoutSeconds)
      .catch((error) => {
        this.deps.logger.error(
          `Failed to submit ${workerType} session: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    this.deps.getInflight().set(sessionId, {
      sessionId,
      workerType,
      taskId: context.taskId,
      messageType: message.type as "spawn" | "repair" | "replan",
      evaluateScope: [...evaluateScope],
      decision,
    });
    _state.markTaskStatus(context.taskId, "running", sessionId, {
      workerType,
      messageType: message.type,
    });
    return true;
  }

  buildTaskContext(state: WorkflowState, task: Task): SessionContext {
    // When task has assignedSections and we have a section index, slice the requirement text
    let effectiveText = state.requirementText;
    const assignedSections = task.contextHints?.assignedSections;
    if (Array.isArray(assignedSections) && assignedSections.length > 0 && state.sectionIndex.length > 0) {
      // Prepend global context (section TOC) so each analyze shard sees the full document structure
      const toc = buildSectionToc(state.sectionIndex);
      const sliced = sliceBySections(state.requirementText, state.sectionIndex, assignedSections as string[]);
      effectiveText = toc + "\n\n" + sliced;
    }

    return new SessionContext({
      taskId: task.id,
      taskType: task.type,
      taskDescription: task.description,
      goal: state.goal,
      requirementText: effectiveText,
      requirementJson: state.requirementJson,
      designText: state.designText,
      diagrams: state.diagrams,
      testCases: state.testCases,
      artifactSummary: state.artifactSummary(),
      artifactSnapshots: state.artifactSnapshots(),
      hints: task.contextHints,
      isDirectMode: state.isDirectMode,
      registry: state.registry ?? undefined,
    });
  }
}
