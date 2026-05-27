import {
  createArtifact,
  createExecutionPlan,
  createPlanMutation,
  createTask,
  createVerdict,
  type Artifact,
  type ExecutionPlan,
  type PlanMutation,
  type Task,
  type Verdict,
} from "./shared/types.js";
import {
  createTaskNotification,
  type TaskMessage,
  type TaskNotification,
} from "./messaging.js";
import { isRecord } from "./utils/isRecord.js";

export function deepToPlainObject(value: unknown): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepToPlainObject(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, deepToPlainObject(item)]),
    );
  }
  return String(value);
}

function restoreTask(value: unknown): Task | null {
  if (!isRecord(value)) return null;
  const type = String(value.type ?? "").trim();
  if (!type) return null;
  return createTask({
    id: String(value.id ?? ""),
    type: type as Task["type"],
    description: String(value.description ?? ""),
    dependsOn: Array.isArray(value.dependsOn)
      ? value.dependsOn.map((item) => String(item))
      : Array.isArray(value.depends_on)
        ? value.depends_on.map((item) => String(item))
        : [],
    contextHints: isRecord(value.contextHints)
      ? value.contextHints
      : isRecord(value.context_hints)
        ? value.context_hints
        : {},
  });
}

function restoreArtifact(value: unknown): Artifact | null {
  if (!isRecord(value)) return null;
  const taskType = String(value.type ?? "").trim();
  if (!taskType) return null;
  return createArtifact({
    taskId: String(value.taskId ?? value.task_id ?? ""),
    type: taskType as Artifact["type"],
    revision: Number(value.revision ?? 0),
    content: value.content ?? null,
    selfCheckPassed: Boolean(value.selfCheckPassed ?? value.self_check_passed ?? true),
    selfCheckIssues: Array.isArray(value.selfCheckIssues)
      ? value.selfCheckIssues.map((item) => String(item))
      : Array.isArray(value.self_check_issues)
        ? value.self_check_issues.map((item) => String(item))
        : [],
    selfCorrectRounds: Number(value.selfCorrectRounds ?? value.self_correct_rounds ?? 0),
    generationDuration: Number(value.generationDuration ?? value.generation_duration ?? 0),
  });
}

function restoreExecutionPlan(value: unknown): ExecutionPlan | null {
  if (!isRecord(value)) return null;
  const tasksRaw = Array.isArray(value.tasks) ? value.tasks : [];
  const tasks = tasksRaw
    .map((item) => restoreTask(item))
    .filter((item): item is Task => item !== null);
  return createExecutionPlan({
    tasks,
    goal: String(value.goal ?? "design"),
    reasoning: String(value.reasoning ?? ""),
  });
}

function restorePlanMutation(value: unknown): PlanMutation | null {
  if (!isRecord(value)) return null;
  const addTasks = (Array.isArray(value.addTasks) ? value.addTasks : Array.isArray(value.add_tasks) ? value.add_tasks : [])
    .map((item) => restoreTask(item))
    .filter((item): item is Task => item !== null);
  const updateTasks = (Array.isArray(value.updateTasks) ? value.updateTasks : Array.isArray(value.update_tasks) ? value.update_tasks : [])
    .map((item) => restoreTask(item))
    .filter((item): item is Task => item !== null);
  const reorderSource = isRecord(value.reorderEdges)
    ? value.reorderEdges
    : isRecord(value.reorder_edges)
      ? value.reorder_edges
      : {};
  const reorderEdges: Record<string, string[]> = {};
  for (const [key, item] of Object.entries(reorderSource)) {
    if (Array.isArray(item)) {
      reorderEdges[key] = item.map((dep) => String(dep));
    }
  }
  return createPlanMutation({
    addTasks,
    updateTasks,
    dropTaskIds: Array.isArray(value.dropTaskIds)
      ? value.dropTaskIds.map((item) => String(item))
      : Array.isArray(value.drop_task_ids)
        ? value.drop_task_ids.map((item) => String(item))
        : [],
    reorderEdges,
    reasoning: String(value.reasoning ?? ""),
  });
}

function restoreVerdict(value: unknown): Verdict | null {
  if (!isRecord(value)) return null;
  const fixesSource = Array.isArray(value.fixes) ? value.fixes : [];
  const fixes = fixesSource
    .map((item) => restoreTask(item))
    .filter((item): item is Task => item !== null);
  const issuesSource = Array.isArray(value.issues) ? value.issues : [];
  const issues = issuesSource
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => ({
      severity: String(item.severity ?? "major") as Verdict["issues"][number]["severity"],
      targetTaskId: String(item.targetTaskId ?? item.target_task_id ?? ""),
      targetTaskType: String(item.targetTaskType ?? item.target_task_type ?? ""),
      targetField: String(item.targetField ?? item.target_field ?? ""),
      description: String(item.description ?? ""),
      suggestion: String(item.suggestion ?? ""),
      scope: String(item.scope ?? "") as Verdict["issues"][number]["scope"],
    }));
  return createVerdict({
    passed: Boolean(value.passed),
    issues,
    fixes,
    summary: String(value.summary ?? ""),
    evaluatedTaskIds: Array.isArray(value.evaluatedTaskIds)
      ? value.evaluatedTaskIds.map((item) => String(item))
      : Array.isArray(value.evaluated_task_ids)
        ? value.evaluated_task_ids.map((item) => String(item))
        : [],
    evaluatedRevisions: isRecord(value.evaluatedRevisions)
      ? Object.fromEntries(
        Object.entries(value.evaluatedRevisions).map(([key, item]) => [key, Number(item)]),
      )
      : isRecord(value.evaluated_revisions)
        ? Object.fromEntries(
          Object.entries(value.evaluated_revisions).map(([key, item]) => [key, Number(item)]),
        )
        : {},
    isFinalReview: Boolean(value.isFinalReview ?? value.is_final_review ?? false),
  });
}

export class SessionContext {
  taskId = "";
  taskType = "";
  taskDescription = "";
  goal = "design";
  requirementText = "";
  requirementJson: Record<string, unknown> = {};
  designText = "";
  diagrams: Record<string, unknown> = {};
  testCases = "";
  artifactSummary: Record<string, unknown> = {};
  artifactSnapshots: Record<string, Record<string, unknown>> = {};
  minReviewScore = 0.6;
  isDirectMode = false;
  evaluateScope: string[] = [];
  hints: Record<string, unknown> = {};
  previousIssues: Array<{ severity: string; description: string; location?: string }> = [];
  registry?: import("./shared/types.js").EntityRegistry = undefined;

  constructor(init?: Partial<SessionContext>) {
    Object.assign(this, init);
  }

  toDict(): Record<string, unknown> {
    return deepToPlainObject({
      taskId: this.taskId,
      taskType: this.taskType,
      taskDescription: this.taskDescription,
      goal: this.goal,
      requirementText: this.requirementText,
      requirementJson: this.requirementJson,
      designText: this.designText,
      diagrams: this.diagrams,
      testCases: this.testCases,
      artifactSummary: this.artifactSummary,
      artifactSnapshots: this.artifactSnapshots,
      minReviewScore: this.minReviewScore,
      isDirectMode: this.isDirectMode,
      evaluateScope: this.evaluateScope,
      hints: this.hints,
    }) as Record<string, unknown>;
  }

  static fromDict(data: Record<string, unknown>): SessionContext {
    return new SessionContext({
      taskId: String(data.taskId ?? data.task_id ?? ""),
      taskType: String(data.taskType ?? data.task_type ?? ""),
      taskDescription: String(data.taskDescription ?? data.task_description ?? ""),
      goal: String(data.goal ?? "design"),
      requirementText: String(data.requirementText ?? data.requirement_text ?? ""),
      requirementJson: isRecord(data.requirementJson)
        ? data.requirementJson
        : isRecord(data.requirement_json)
          ? data.requirement_json
          : {},
      designText: String(data.designText ?? data.design_text ?? ""),
      diagrams: isRecord(data.diagrams) ? data.diagrams : {},
      testCases: String(data.testCases ?? data.test_cases ?? ""),
      artifactSummary: isRecord(data.artifactSummary)
        ? data.artifactSummary
        : isRecord(data.artifact_summary)
          ? data.artifact_summary
          : {},
      artifactSnapshots: isRecord(data.artifactSnapshots)
        ? data.artifactSnapshots as Record<string, Record<string, unknown>>
        : isRecord(data.artifact_snapshots)
          ? data.artifact_snapshots as Record<string, Record<string, unknown>>
          : {},
      minReviewScore: Number(data.minReviewScore ?? data.min_review_score ?? 0.6),
      isDirectMode: Boolean(data.isDirectMode ?? data.is_direct_mode ?? false),
      evaluateScope: Array.isArray(data.evaluateScope)
        ? data.evaluateScope.map((item) => String(item))
        : Array.isArray(data.evaluate_scope)
          ? data.evaluate_scope.map((item) => String(item))
          : [],
      hints: isRecord(data.hints) ? data.hints : {},
    });
  }
}

export interface SessionState {
  sessionId: string;
  workerType: string;
  context: SessionContext;
  createdAt: number;
  lastActiveAt: number;
  heartbeatAt: number;
  startedAt: number;
  finishedAt: number;
  messageCount: number;
  notificationCount: number;
  resumeCount: number;
  currentSequence: number;
  lastMessageType: string;
  status: string;
  timeoutSeconds: number;
  timeoutAt: number;
  cancelRequested: boolean;
  cancelReason: string;
  timedOut: boolean;
  intermediateState: Record<string, unknown>;
  toolHistory: Array<Record<string, unknown>>;
  error: string;
  finished: boolean;
}

export class SessionDescriptor {
  sessionId = "";
  workerType = "";
  context: Record<string, unknown> = {};
  intermediateState: Record<string, unknown> = {};
  resumeCount = 0;
  currentSequence = 0;
  messageCount = 0;
  notificationCount = 0;
  status = "idle";

  constructor(init?: Partial<SessionDescriptor>) {
    if (init) {
      this.sessionId = init.sessionId ?? "";
      this.workerType = init.workerType ?? "";
      this.resumeCount = init.resumeCount ?? 0;
      this.currentSequence = init.currentSequence ?? 0;
      this.messageCount = init.messageCount ?? 0;
      this.notificationCount = init.notificationCount ?? 0;
      this.status = init.status ?? "idle";
      // Deep copy reference-type fields to prevent shared mutation
      this.context = init.context ? structuredClone(init.context) : {};
      this.intermediateState = init.intermediateState ? structuredClone(init.intermediateState) : {};
    }
  }

  toDict(): Record<string, unknown> {
    return deepToPlainObject(this) as Record<string, unknown>;
  }

  static fromDict(data: Record<string, unknown>): SessionDescriptor {
    const contextRaw = isRecord(data.context) ? data.context : isRecord(data.context_json) ? data.context_json : {};
    const intermediateRaw = isRecord(data.intermediateState)
      ? data.intermediateState
      : isRecord(data.intermediate_state)
        ? data.intermediate_state
        : {};
    return new SessionDescriptor({
      sessionId: String(data.sessionId ?? data.session_id ?? ""),
      workerType: String(data.workerType ?? data.worker_type ?? ""),
      context: structuredClone(contextRaw) as Record<string, unknown>,
      intermediateState: structuredClone(intermediateRaw) as Record<string, unknown>,
      resumeCount: Number(data.resumeCount ?? data.resume_count ?? 0),
      currentSequence: Number(data.currentSequence ?? data.current_sequence ?? 0),
      messageCount: Number(data.messageCount ?? data.message_count ?? 0),
      notificationCount: Number(data.notificationCount ?? data.notification_count ?? 0),
      status: String(data.status ?? "idle"),
    });
  }
}

export abstract class WorkerSession {
  readonly sessionId: string;
  readonly context: SessionContext;
  protected readonly mailbox: { sendNotification: (notif: TaskNotification) => void } | null;
  protected readonly llm: unknown;
  state: SessionState;

  constructor(
    sessionId: string,
    context: SessionContext,
    mailbox: { sendNotification: (notif: TaskNotification) => void } | null,
    llm: unknown,
  ) {
    this.sessionId = sessionId;
    this.context = context;
    this.mailbox = mailbox;
    this.llm = llm;

    const now = Date.now() / 1000;
    this.state = {
      sessionId,
      workerType: "",
      context,
      createdAt: now,
      lastActiveAt: now,
      heartbeatAt: now,
      startedAt: 0,
      finishedAt: 0,
      messageCount: 0,
      notificationCount: 0,
      resumeCount: 0,
      currentSequence: 0,
      lastMessageType: "",
      status: "idle",
      timeoutSeconds: 0,
      timeoutAt: 0,
      cancelRequested: false,
      cancelReason: "",
      timedOut: false,
      intermediateState: {},
      toolHistory: [],
      error: "",
      finished: false,
    };
  }

  abstract get workerType(): string;

  abstract run(message: TaskMessage): Promise<TaskNotification>;

  runInLlmStreamContext<T>(fn: () => Promise<T>): Promise<T> {
    const runner = this.llm as {
      runWithStreamTagContext?: (
        initialTag: string,
        suffix: string,
        callback: () => Promise<T>,
      ) => Promise<T>;
    };
    if (!runner || typeof runner.runWithStreamTagContext !== "function") {
      return fn();
    }
    return runner.runWithStreamTagContext(
      `[${this.workerType}:${this.context.taskType || this.context.taskId}]`,
      `session=${this.sessionId};task=${this.context.taskId};type=${this.context.taskType}`,
      fn,
    );
  }

  recordToolCall(toolName: string, inputData: unknown, outputData: unknown): void {
    this.state.toolHistory.push({
      tool: toolName,
      input: deepToPlainObject(inputData),
      output: deepToPlainObject(outputData),
      timestamp: Date.now() / 1000,
    });
    this.markHeartbeat();
  }

  exportDescriptor(): SessionDescriptor {
    return new SessionDescriptor({
      sessionId: this.sessionId,
      workerType: this.workerType,
      context: this.context.toDict(),
      intermediateState: this._serializeIntermediateState(),
      resumeCount: this.state.resumeCount,
      currentSequence: this.state.currentSequence,
      messageCount: this.state.messageCount,
      notificationCount: this.state.notificationCount,
      status: this.state.status,
    });
  }

  restoreFromDescriptor(descriptor: SessionDescriptor): void {
    this.state.resumeCount = descriptor.resumeCount;
    this.state.currentSequence = descriptor.currentSequence;
    this.state.messageCount = descriptor.messageCount;
    this.state.notificationCount = descriptor.notificationCount;
    this.state.status = descriptor.status;
    // Deep clone to prevent shared reference mutation
    const clonedIntermediate = structuredClone(descriptor.intermediateState);
    this.state.intermediateState = this._deserializeIntermediateState(clonedIntermediate);
  }

  protected _serializeIntermediateState(): Record<string, unknown> {
    return deepToPlainObject(this.state.intermediateState) as Record<string, unknown>;
  }

  protected _deserializeIntermediateState(data: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data ?? {})) {
      result[key] = this._restoreValue(key, value);
    }
    return result;
  }

  protected _restoreValue(key: string, value: unknown): unknown {
    if (!isRecord(value)) return value;
    if (key === "last_artifact" || key === "lastArtifact") {
      return restoreArtifact(value) ?? value;
    }
    if (key === "last_plan" || key === "lastPlan") {
      return restoreExecutionPlan(value) ?? value;
    }
    if (key === "last_mutation" || key === "lastMutation") {
      return restorePlanMutation(value) ?? value;
    }
    if (key === "last_verdict" || key === "lastVerdict") {
      return restoreVerdict(value) ?? value;
    }
    return value;
  }

  beginMessage(message: TaskMessage, timeoutSeconds: number): number {
    const now = Date.now() / 1000;
    this.state.currentSequence += 1;
    this.state.lastMessageType = message.type;
    this.state.status = "running";
    this.state.startedAt = now;
    this.state.lastActiveAt = now;
    this.state.heartbeatAt = now;
    this.state.timeoutSeconds = timeoutSeconds;
    this.state.timeoutAt = timeoutSeconds > 0 ? now + timeoutSeconds : 0;
    this.state.cancelRequested = false;
    this.state.cancelReason = "";
    this.state.timedOut = false;
    this.state.finished = false;
    this.state.error = "";
    if (message.type === "repair") {
      this.state.resumeCount += 1;
    }
    return this.state.currentSequence;
  }

  markHeartbeat(): void {
    const now = Date.now() / 1000;
    this.state.lastActiveAt = now;
    this.state.heartbeatAt = now;
  }

  requestCancel(reason: string): void {
    this.state.cancelRequested = true;
    this.state.cancelReason = reason;
    this.state.lastActiveAt = Date.now() / 1000;
  }

  markTimeout(reason = "session timed out"): void {
    this.state.timedOut = true;
    this.state.cancelRequested = true;
    this.state.cancelReason = reason;
    this.state.status = "failed";
    this.state.finished = true;
    this.state.error = reason;
    this.state.finishedAt = Date.now() / 1000;
  }

  canAccept(message: TaskMessage): boolean {
    if (this.state.status === "running") return false;
    if (message.type === "repair") {
      return this.workerType === "generator" && !this.state.timedOut;
    }
    if (message.type === "replan") {
      return this.workerType === "planner" && !this.state.timedOut;
    }
    if (message.type === "spawn") {
      return ["idle", "completed", "failed", "rejected", "cancelled"].includes(this.state.status);
    }
    if (message.type === "stop" || message.type === "inspect") {
      return true;
    }
    return false;
  }

  snapshot(): Record<string, unknown> {
    return {
      sessionId: this.state.sessionId,
      taskId: this.context.taskId,
      workerType: this.state.workerType,
      status: this.state.status,
      createdAt: this.state.createdAt,
      startedAt: this.state.startedAt,
      lastActiveAt: this.state.lastActiveAt,
      heartbeatAt: this.state.heartbeatAt,
      finishedAt: this.state.finishedAt,
      messageCount: this.state.messageCount,
      notificationCount: this.state.notificationCount,
      resumeCount: this.state.resumeCount,
      currentSequence: this.state.currentSequence,
      timeoutAt: this.state.timeoutAt,
      cancelRequested: this.state.cancelRequested,
      timedOut: this.state.timedOut,
      finished: this.state.finished,
      error: this.state.error,
    };
  }

  isRunning(): boolean {
    return this.state.status === "running";
  }

  completeMessage(
    notification: TaskNotification,
    sequence: number,
  ): TaskNotification | null {
    if (sequence !== this.state.currentSequence) return null;
    if (this.state.timedOut) return null;
    if (this.state.finished && this.state.status !== "running") return null;

    let finalNotification = notification;
    if (
      this.state.cancelRequested &&
      !["failed", "cancelled"].includes(notification.status)
    ) {
      finalNotification = this._makeNotification(
        "cancelled",
        {
          summary: this.state.cancelReason || "session cancelled",
          event: "result",
          sequence,
        },
      );
    }

    const now = Date.now() / 1000;
    this.state.lastActiveAt = now;
    this.state.heartbeatAt = now;
    this.state.finishedAt = now;
    this.state.notificationCount += 1;
    this.state.finished = true;
    this.state.status = finalNotification.status;
    this.state.error = finalNotification.error;
    return finalNotification;
  }

  lifecycleNotification(
    event: TaskNotification["event"],
    summary: string,
    status: TaskNotification["status"] = "running",
    sequence?: number,
    error = "",
  ): TaskNotification {
    return this._makeNotification(status, {
      summary,
      error,
      event,
      terminal: event === "result" || event === "timeout",
      sequence: sequence ?? this.state.currentSequence,
    });
  }

  protected _makeNotification(
    status: TaskNotification["status"],
    overrides: Partial<TaskNotification> = {},
  ): TaskNotification {
    return createTaskNotification({
      taskId: overrides.taskId ?? this.context.taskId,
      sessionId: this.sessionId,
      status,
      event: overrides.event ?? "result",
      summary: overrides.summary ?? "",
      result: overrides.result ?? null,
      usage: overrides.usage ?? {
        steps: this.state.messageCount,
        toolCalls: this.state.toolHistory.length,
      },
      error: overrides.error ?? "",
      suggestions: overrides.suggestions ?? [],
      sequence: overrides.sequence ?? this.state.currentSequence,
      progressDelta: overrides.progressDelta ?? {},
      recommendedAction: overrides.recommendedAction ?? "",
      replanHint: overrides.replanHint ?? "",
      terminal: overrides.terminal ?? ((overrides.event ?? "result") === "result" || (overrides.event ?? "result") === "timeout"),
    });
  }
}

export class SessionRegistry {
  private readonly sessions = new Map<string, WorkerSession>();
  private readonly taskToSessions = new Map<string, string[]>();

  register(session: WorkerSession): string {
    this.sessions.set(session.sessionId, session);
    const existing = this.taskToSessions.get(session.context.taskId) ?? [];
    existing.push(session.sessionId);
    this.taskToSessions.set(session.context.taskId, existing);
    return session.sessionId;
  }

  get(sessionId: string): WorkerSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  getByTask(taskId: string): WorkerSession[] {
    const ids = this.taskToSessions.get(taskId) ?? [];
    return ids
      .map((id) => this.sessions.get(id))
      .filter((session): session is WorkerSession => session !== undefined);
  }

  latestSessionForTask(taskId: string): WorkerSession | null {
    const ids = this.taskToSessions.get(taskId) ?? [];
    if (ids.length === 0) return null;
    return this.sessions.get(ids[ids.length - 1]) ?? null;
  }

  unregister(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    const ids = this.taskToSessions.get(session.context.taskId) ?? [];
    const next = ids.filter((id) => id !== sessionId);
    if (next.length > 0) {
      this.taskToSessions.set(session.context.taskId, next);
    } else {
      this.taskToSessions.delete(session.context.taskId);
    }
  }

  activeCount(): number {
    return this.sessions.size;
  }

  allSessions(): WorkerSession[] {
    return [...this.sessions.values()];
  }

  allFinished(): boolean {
    return this.allSessions().every((session) => session.state.finished);
  }
}
