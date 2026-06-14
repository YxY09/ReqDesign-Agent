import type { Logger } from "../logger.js";
import { isRecord } from "../utils/isRecord.js";
import { WorkerFactory } from "../execution/factory.js";
import { SessionBackend } from "../execution/backend.js";
import { SessionContext, SessionRegistry, type SessionProvenance } from "../session.js";
import { createTaskMessage, TaskMailbox, type TaskMessage } from "../messaging.js";
import type { WorkflowState } from "../state.js";
import {
  createTask,
  type InflightWorker,
  type RuntimeAction,
  type Task,
  type WorkerKind,
} from "../shared/types.js";
import { cloneTask } from "../shared/taskUtils.js";
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

function provenanceFromSnapshots(
  snapshots: Record<string, Record<string, unknown>>,
  scope: SessionProvenance["scope"],
  contentKind: SessionProvenance["contentKind"],
): SessionProvenance {
  const sourceTaskIds = new Set<string>();
  const sourceRevisions: Record<string, number> = {};

  for (const [taskId, snapshot] of Object.entries(snapshots)) {
    sourceTaskIds.add(String(snapshot.taskId ?? taskId));
    const revision = Number(snapshot.revision ?? 0);
    if (revision > 0) {
      sourceRevisions[String(snapshot.taskId ?? taskId)] = revision;
    }

    const nestedIds = snapshot.sourceTaskIds;
    if (Array.isArray(nestedIds)) {
      for (const nestedId of nestedIds) sourceTaskIds.add(String(nestedId));
    }

    const nestedRevisions = snapshot.sourceRevisions;
    if (isRecord(nestedRevisions)) {
      for (const [sourceTaskId, sourceRevision] of Object.entries(nestedRevisions)) {
        sourceTaskIds.add(sourceTaskId);
        sourceRevisions[sourceTaskId] = Number(sourceRevision ?? 0);
      }
    }
  }

  return {
    scope,
    contentKind,
    sourceTaskIds: [...sourceTaskIds].sort(),
    sourceRevisions,
  };
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
      provenance: provenanceFromSnapshots(
        state.artifactSnapshots(),
        "planner",
        "mixed",
      ),
      isDirectMode: state.isDirectMode,
      hints: {
        ...(decision.replanContext ?? {}),
        sectionIndex: state.sectionIndex.length > 0 ? state.sectionIndex : undefined,
      },
    });
    const planTaskIds = new Set(state.getPlanTaskIds());
    const replanPayload = messageType === "replan" && state.plan
      ? {
          current_plan: state.plan,
          completed_task_ids: state.getCompletedPlanTaskIds(),
          failed_task_ids: state.getFailedTaskIds().filter((taskId) => planTaskIds.has(taskId)),
          evaluator_issues: state.latestVerdict?.issues ?? [],
          artifact_summary: state.artifactSummary(),
          replan_reason: decision.reason,
        }
      : undefined;
    const message = createTaskMessage({
      type: messageType,
      taskId: "planner",
      sessionId: "",
      replanContext: decision.replanContext,
      cause: decision.reason,
      payload: replanPayload,
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
    const provenance = provenanceFromSnapshots(
      artifactSnapshots,
      "evaluate",
      evaluateScope.length > 0 ? "raw" : "canonical",
    );
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
      provenance,
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
    const context = this.buildTaskContext(state, task);
    if (decision.action === "regenerate") {
      this.attachPreviousArtifactContext(state, taskId, context, "task");
    }
    return this.submitWorker(
      state,
      "generator",
      context,
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

    const context = this.buildTaskContext(state, task);
    this.attachPreviousArtifactContext(state, taskId, context, "repair");

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

  private attachPreviousArtifactContext(
    state: WorkflowState,
    taskId: string,
    context: SessionContext,
    scope: "repair" | "task",
  ): void {
    const currentArtifact = state.artifacts[taskId];
    if (currentArtifact?.content !== undefined && currentArtifact.content !== null) {
      context.hints.previous_artifact_content = currentArtifact.content;
      context.hints.previous_artifact_type = currentArtifact.type;
      context.hints.previous_artifact_revision =
        currentArtifact.revision || state.currentArtifactRevision(taskId);
      context.artifactSnapshots = {
        ...state.finalArtifactSnapshots(),
        ...state.artifactSnapshots([taskId]),
      };
      context.provenance = provenanceFromSnapshots(
        state.artifactSnapshots([taskId]),
        scope,
        "raw",
      );
      return;
    }

    // Fallback for restored sessions without a current state artifact.
    const prevSession = this.deps.sessions.latestSessionForTask(taskId);
    if (!prevSession) return;
    const descriptor = prevSession.exportDescriptor();
    const lastArtifact = descriptor.intermediateState?.last_artifact;
    if (
      isRecord(lastArtifact) &&
      lastArtifact.content !== undefined &&
      lastArtifact.content !== null
    ) {
      context.hints.previous_artifact_content = lastArtifact.content;
      context.hints.previous_artifact_type = lastArtifact.type;
      if (lastArtifact.revision !== undefined) {
        context.hints.previous_artifact_revision = Number(lastArtifact.revision);
      }
    }
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
        const msg = error instanceof Error ? error.message : String(error);
        this.deps.logger.error(`Failed to submit ${workerType} session: ${msg}`);
        // 提交失败（如排队超时）时回滚登记状态，否则任务会永远停留在
        // running，orchestrator 只能 wait_for_running 直到 idle 暂停。
        this.deps.getInflight().delete(sessionId);
        if (this.deps.getActiveStreamContext()?.sessionId === sessionId) {
          this.deps.setActiveStreamContext(null);
        }
        _state.markTaskStatus(context.taskId, "failed", sessionId, {
          error: `submission failed: ${msg}`,
        });
        _state.stores.execution.addError(
          `${workerType} submission failed for ${context.taskId}: ${msg}`,
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
      task: cloneTask(task),
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
      artifactSnapshots: {},
      provenance: provenanceFromSnapshots(state.finalArtifactSnapshots(), "task", "effective"),
      hints: task.contextHints,
      isDirectMode: state.isDirectMode,
      registry: state.registry ?? undefined,
    });
  }
}
