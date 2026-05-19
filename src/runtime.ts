import { mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import type { AgentConfig } from "./config.js";
import { ConstitutionLoader, setConstitution } from "./constitution.js";
import { DependencyProvider, WorkerFactory } from "./execution/factory.js";
import { ThreadBackend } from "./execution/backend.js";
import { LLMClient, type LlmStreamEvent } from "./llmClient.js";
import { setupLogger, initSharedLog, type Logger } from "./logger.js";
import { OutputScorer } from "./tools/scorer.js";
import { RequirementNormalizer } from "./tools/normalizer.js";
import {
  TaskMailbox,
  createTaskMessage,
  TERMINAL_EVENTS,
  type TaskNotification,
} from "./messaging.js";
import { setMemory, MemoryStore } from "./memory/store.js";
import {
  extractCoordinatorDecision,
  extractEvaluatorInsight,
  extractGeneratorLesson,
  persistMemoryWrites,
} from "./memory/extractors.js";
import { OrchestrationConfig } from "./orchestration/config.js";
import { BudgetManager } from "./orchestration/budget.js";
import { RunManager } from "./orchestration/runManager.js";
import { RunSummaryBuilder } from "./orchestration/runSummary.js";
import { OutputManager } from "./outputManager.js";
import { SessionContext, SessionRegistry } from "./session.js";
import { WorkflowState } from "./state.js";
import { AgentOrchestrator } from "./agent/orchestrator.js";
import { EvaluationTool } from "./tools/evaluation.js";
import { GenerationTool } from "./tools/generation.js";
import { AnalyzeMerger } from "./generators/merge.js";
import { PlanningTool } from "./tools/planning.js";
import {
  createArtifact,
  createExecutionPlan,
  createTask,
  type Artifact,
  type ExecutionPlan,
  type PlanMutation,
  type RuntimeAction,
  type Task,
  type Verdict,
} from "./agent/types.js";
import { InputLoader } from "./inputLoader.js";
import { TraceLogger } from "./governance/traceLogger.js";
import {
  createWorkflowEvent,
  type WorkflowEvent,
  type WorkflowEventSink,
} from "./workflowEvents.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPlainNotification(notif: TaskNotification): Record<string, unknown> {
  return {
    taskId: notif.taskId,
    sessionId: notif.sessionId,
    status: notif.status,
    event: notif.event,
    summary: notif.summary,
    error: notif.error,
    sequence: notif.sequence,
    timestamp: notif.timestamp,
    progressDelta: notif.progressDelta,
    recommendedAction: notif.recommendedAction,
    replanHint: notif.replanHint,
    terminal: notif.terminal,
  };
}

type WorkerKind = "planner" | "generator" | "evaluator";

interface InflightWorker {
  sessionId: string;
  workerType: WorkerKind;
  taskId: string;
  messageType: "spawn" | "repair" | "replan";
  evaluateScope: string[];
  decision?: RuntimeAction;
}

function isArtifactResult(value: unknown): value is Artifact {
  return (
    isRecord(value) &&
    typeof value.taskId === "string" &&
    typeof value.type === "string"
  );
}

function isVerdictResult(value: unknown): value is Verdict {
  return (
    isRecord(value) &&
    typeof value.passed === "boolean" &&
    Array.isArray(value.issues) &&
    Array.isArray(value.evaluatedTaskIds)
  );
}

function isExecutionPlanResult(value: unknown): value is ExecutionPlan {
  return (
    isRecord(value) &&
    Array.isArray(value.tasks) &&
    typeof value.goal === "string"
  );
}

function isPlanMutationResult(value: unknown): value is PlanMutation {
  return (
    isRecord(value) &&
    Array.isArray(value.addTasks) &&
    Array.isArray(value.updateTasks) &&
    Array.isArray(value.dropTaskIds) &&
    isRecord(value.reorderEdges)
  );
}

export interface RuntimeRunOptions {
  onEvent?: WorkflowEventSink;
}

export class MultiAgentRuntime {
  readonly config: AgentConfig;
  readonly mailbox: TaskMailbox;
  readonly sessions: SessionRegistry;
  readonly coordinator: AgentOrchestrator;
  readonly plannerTool: PlanningTool;
  readonly generatorTool: GenerationTool;
  readonly evaluatorTool: EvaluationTool;
  private readonly analyzeMerger: AnalyzeMerger;
  readonly inputLoader: typeof InputLoader;
  readonly trace: TraceLogger;
  readonly executionBackendName: string;

  private readonly logger: Logger;
  private readonly memoryStore: MemoryStore;
  private readonly llm: LLMClient;
  private readonly factory: WorkerFactory;
  private readonly backend: ThreadBackend;
  private readonly budget: BudgetManager;
  private readonly outputManagerClass = OutputManager;
  private readonly defaultTimeoutSeconds = 900;
  private readonly pollIntervalMs = 20;
  private eventSink: WorkflowEventSink | null = null;
  private activeStreamContext: {
    workerType: WorkerKind;
    taskId: string;
    taskType: string;
    sessionId: string;
  } | null = null;
  private readonly inflight = new Map<string, InflightWorker>();

  constructor(config: AgentConfig, executionBackend?: string | null) {
    this.config = config;
    this.logger = setupLogger("reqdesign.runtime", config.logging.level);
    this.trace = new TraceLogger();
    this.llm = new LLMClient(config);
    this.llm.setTraceSink((info) => this.trace.logLlmCall(
      info.tag || "llm",
      "chat",
      [{ role: "user", content: info.promptPreview }],
      info.responseText,
      info.durationMs / 1000,
    ));

    const projectRoot = resolve(process.cwd());
    const constitution = new ConstitutionLoader([
      projectRoot,
      dirname(projectRoot),
    ]);
    setConstitution(constitution);

    this.memoryStore = new MemoryStore(projectRoot);
    setMemory(this.memoryStore);

    this.mailbox = new TaskMailbox();
    this.sessions = new SessionRegistry();
    this.coordinator = new AgentOrchestrator(this.llm);
    this.plannerTool = new PlanningTool(this.llm);
    this.generatorTool = new GenerationTool(this.llm);
    this.evaluatorTool = new EvaluationTool(this.llm);
    this.analyzeMerger = new AnalyzeMerger(this.llm);
    this.inputLoader = InputLoader;

    this.executionBackendName =
      executionBackend && executionBackend.trim().toLowerCase() === "process"
        ? "thread"
        : executionBackend?.trim().toLowerCase() || "thread";

    const orchestrationRaw = isRecord(config.raw.orchestration)
      ? config.raw.orchestration
      : {};
    const orchestrationConfig = OrchestrationConfig.fromRaw(
      orchestrationRaw as Record<string, unknown>,
    );
    this.budget = new BudgetManager(orchestrationConfig);

    const deps = new DependencyProvider({
      llm: this.llm,
      mailbox: this.mailbox,
      plannerTool: this.plannerTool,
      generatorTool: this.generatorTool,
      evaluatorTool: this.evaluatorTool,
    });
    this.factory = new WorkerFactory(deps);
    this.backend = new ThreadBackend({
      factory: this.factory,
      heartbeatInterval: 0.25,
      onNotification: (session, notification) => {
        this.emitBackendNotification(
          session.workerType as "planner" | "generator" | "evaluator",
          notification,
        );
      },
    });
  }

  cancel(reason = "cancelled by user"): void {
    const sessionId = this.activeStreamContext?.sessionId;
    if (sessionId) {
      this.backend.cancel(sessionId, reason);
    }
    this.emitRuntimeEvent("run_cancel_requested", reason, {
      goal: this.activeStreamContext?.taskType,
      phase: this.activeStreamContext?.workerType,
      taskId: this.activeStreamContext?.taskId,
      taskType: this.activeStreamContext?.taskType,
      sessionId,
      status: "cancelled",
    });
  }

  async run(
    goal: string,
    inputPath: string,
    outputDir: string,
    options?: RuntimeRunOptions,
  ): Promise<WorkflowState> {
    this.eventSink = options?.onEvent ?? null;
    this.llm.setStreamListener((event) => this.emitLlmChunk(event));
    const state = new WorkflowState();
    state.goal = goal;
    state.inputPath = inputPath;
    state.outputDir = outputDir;

    // Set up real-time trace persistence
    const traceDir = join(outputDir, "traces");
    this.trace.setPersistPath(join(traceDir, "llm_trace.json"));
    state.startTime = Date.now() / 1000;

    // Open run log
    // Open unified log file in logs/ directory
    try {
      const logDir = this.config.logging.logDir || "logs";
      mkdirSync(logDir, { recursive: true });
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      initSharedLog(`${logDir}/reqdesign_${ts}.log`, this.config.logging.level);
    } catch { /* non-fatal */ }
    this.emitRuntimeEvent("run_started", `runtime started for ${goal}`, {
      goal,
      data: {
        inputPath,
        outputDir,
      },
    });

    let skipFinalSave = false;
    try {
      state.requirementText = this.inputLoader.load(inputPath);
      this.trace.log("system", "input_loaded", { inputPath, goal });
      this.emitRuntimeEvent("input_loaded", `loaded input ${inputPath}`, {
        goal,
        data: this.snapshotState(state),
      });

      if (goal === "analyze") {
        state.plan = createExecutionPlan({
          goal: "analyze",
          reasoning: "analyze mode bootstrap",
          tasks: [
            createTask({
              id: "analyze-1",
              type: "analyze",
              description: "提取角色、功能、实体、约束等结构化信息",
            }),
          ],
        });
      }

      let consecutiveNoAction = 0;
      while (true) {
        await this.drainBackendNotifications(state);

        if (this.budget.runtimeExhausted(state.startTime)) {
          RunManager.markPartial(state, "runtime budget exhausted");
          this.emitRuntimeEvent(
            "runtime_budget_exhausted",
            "runtime budget exhausted",
            {
              goal,
              status: state.runStatus,
              data: this.snapshotState(state),
            },
          );
          break;
        }

        const decision = await this.coordinator.decide(state, this.mailbox);
        state.actionHistory.push({
          timestamp: Date.now() / 1000,
          decisionCount: state.decisionCount,
          action: decision.action,
          taskId: decision.taskId,
          reason: decision.reason,
        });

        const control = await this.dispatchAction(state, decision);
        if (control.didDispatch) {
          consecutiveNoAction = 0;
        } else if (!this.backend.hasInflight()) {
          consecutiveNoAction += 1;
        }
        if (control.breakLoop) {
          skipFinalSave = control.skipFinalSave;
          break;
        }

        if (this.budget.decisionExhausted(state.decisionCount)) {
          RunManager.markPartial(state, "decision budget exhausted");
          this.emitRuntimeEvent(
            "decision_budget_exhausted",
            "decision budget exhausted",
            {
              goal,
              status: state.runStatus,
              data: this.snapshotState(state),
            },
          );
          break;
        }

        if (consecutiveNoAction >= 3 && !this.backend.hasInflight()) {
          RunManager.markPaused(state);
          this.emitRuntimeEvent(
            "orchestration_idle",
            "no actionable decision and no inflight workers",
            {
              goal,
              status: state.runStatus,
              data: this.snapshotState(state),
            },
          );
          break;
        }

        if (this.backend.hasInflight()) {
          await this.backend.waitForChange();
        } else {
          await sleep(this.pollIntervalMs);
        }
      }

      await this.drainBackendNotifications(state);
      if (!skipFinalSave && !state.persisted) {
        this.emitRuntimeEvent("persist_started", "attempting final persist", {
          goal,
          phase: "persist",
          data: this.snapshotState(state),
        });
        if (!this.actionSaveIfQualityGatePassed(state, "workflow completed")) {
          if (state.runStatus === "running") {
            RunManager.markPartial(
              state,
              "final quality gate is not satisfied",
            );
          }
          this.emitRuntimeEvent(
            "persist_skipped",
            "final quality gate rejected persist",
            {
              goal,
              status: state.persistStatus,
              data: this.snapshotState(state),
            },
          );
        } else {
          this.emitRuntimeEvent("persist_completed", "final outputs saved", {
            goal,
            status: state.persistStatus,
            data: this.snapshotState(state),
          });
        }
      }

      if (state.runStatus === "running") {
        if (state.persisted) {
          RunManager.markCompleted(state);
        } else {
          RunManager.markPaused(state);
        }
      }
      state.finished = true;
      this.emitRuntimeEvent("run_completed", "workflow completed", {
        goal,
        status: state.runStatus,
        data: this.snapshotState(state),
      });
      return state;
    } catch (error: unknown) {
      RunManager.markFailed(
        state,
        error instanceof Error ? error.message : String(error),
      );
      this.logger.error(
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      this.actionSave(state);
      state.finished = true;
      this.emitRuntimeEvent(
        "run_failed",
        error instanceof Error ? error.message : String(error),
        {
          goal,
          status: state.runStatus,
          data: this.snapshotState(state),
        },
      );
      return state;
    } finally {
      state.endTime = Date.now() / 1000;
      state.runSummary = RunSummaryBuilder.build(state);
      this.exportTrace(state);
      this.backend.shutdown();
      this.llm.setStreamListener();
      this.activeStreamContext = null;
      this.eventSink = null;

      // Close run log
      // run log closed by main.ts at process exit
    }
  }

  private async dispatchAction(
    state: WorkflowState,
    decision: RuntimeAction,
  ): Promise<{
    didDispatch: boolean;
    breakLoop: boolean;
    skipFinalSave: boolean;
  }> {
    if (decision.action === "spawn") {
      return {
        didDispatch: this.dispatchSpawn(state, decision),
        breakLoop: false,
        skipFinalSave: false,
      };
    }

    if (decision.action === "spawn_all_ready") {
      const ready = state.getReadyTaskIds();
      let submitted = false;
      for (const taskId of ready) {
        submitted =
          this.dispatchSpawn(state, { ...decision, action: "spawn", taskId }) ||
          submitted;
      }
      return { didDispatch: submitted, breakLoop: false, skipFinalSave: false };
    }

    if (decision.action === "repair") {
      if (!decision.taskId) {
        return { didDispatch: false, breakLoop: false, skipFinalSave: false };
      }
      return {
        didDispatch: this.submitGeneratorTask(
          state,
          decision.taskId,
          "repair",
          decision,
        ),
        breakLoop: false,
        skipFinalSave: false,
      };
    }

    if (decision.action === "regenerate") {
      if (!decision.taskId) {
        return { didDispatch: false, breakLoop: false, skipFinalSave: false };
      }
      return {
        didDispatch: this.submitGeneratorTask(
          state,
          decision.taskId,
          "spawn",
          decision,
        ),
        breakLoop: false,
        skipFinalSave: false,
      };
    }

    if (decision.action === "replan") {
      return {
        didDispatch: this.submitPlanner(state, "replan", decision),
        breakLoop: false,
        skipFinalSave: false,
      };
    }

    if (decision.action === "save") {
      const saved = this.actionSaveIfQualityGatePassed(
        state,
        decision.reason || "explicit save action",
      );
      if (saved) {
        this.persistValidatedCoordinatorDecision(
          state,
          decision,
          "save action passed quality gate and persisted outputs",
        );
        RunManager.markCompleted(state);
        return { didDispatch: true, breakLoop: true, skipFinalSave: false };
      }
      return { didDispatch: true, breakLoop: false, skipFinalSave: false };
    }

    if (decision.action === "finish") {
      if (state.runStatus === "running" && !state.persisted) {
        RunManager.markPaused(state);
      } else if (state.persisted) {
        this.persistValidatedCoordinatorDecision(
          state,
          decision,
          "finish action reached after outputs were already persisted",
        );
      }
      return { didDispatch: true, breakLoop: true, skipFinalSave: true };
    }

    if (decision.action === "pause") {
      RunManager.markPaused(state);
      this.logger.info("Workflow paused: " + (decision.reason || "user requested"));
      return { didDispatch: true, breakLoop: true, skipFinalSave: true };
    }

    return { didDispatch: false, breakLoop: false, skipFinalSave: false };
  }

  private persistValidatedCoordinatorDecision(
    state: WorkflowState,
    decision: RuntimeAction,
    validation: string,
  ): void {
    const reason = decision.reason
      ? `${decision.reason}; validated: ${validation}`
      : `validated: ${validation}`;
    persistMemoryWrites(
      extractCoordinatorDecision(
        { ...decision, reason },
        this.coordinatorMemoryStateSummary(state),
      ),
    );
  }

  private coordinatorMemoryStateSummary(state: WorkflowState): {
    planReady: boolean;
    artifactCount: number;
    verdictStatus: string;
    pendingTasks: number;
  } {
    return {
      planReady: state.plan !== null,
      artifactCount: Object.keys(state.artifacts).length,
      verdictStatus:
        state.latestVerdict?.passed === false
          ? "rejected"
          : state.finalReviewPassed
            ? "passed"
            : state.finalReviewDone
              ? "reviewed"
              : "unknown",
      pendingTasks: Math.max(
        0,
        (state.plan?.tasks.length ?? 0) -
          Object.values(state.taskStatuses).filter((status) => status === "completed").length,
      ),
    };
  }

  private dispatchSpawn(
    state: WorkflowState,
    decision: RuntimeAction,
  ): boolean {
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
    return this.submitGeneratorTask(state, taskId, "spawn", decision);
  }

  private submitPlanner(
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
      hints: decision.replanContext,
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
      this.defaultTimeoutSeconds,
      [],
      decision,
    );
  }

  private submitEvaluator(
    state: WorkflowState,
    evaluateScope: string[],
  ): boolean {
    if (state.taskStatus("evaluator") === "running") {
      return false;
    }
    // Build previous issues from last verdict for incremental review
    const lastVerdict = state.latestVerdict;
    const previousIssues = lastVerdict?.issues?.map((i) => ({
      severity: i.severity,
      description: `${i.description} (task: ${i.targetTaskId}, field: ${i.targetField})`,
    })) ?? [];
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
      artifactSnapshots: state.artifactSnapshots(
        evaluateScope.length > 0 ? evaluateScope : undefined,
      ),
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
      this.defaultTimeoutSeconds,
      evaluateScope,
    );
  }

  private submitGeneratorTask(
    state: WorkflowState,
    taskId: string,
    mode: "spawn" | "repair",
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

    const issues =
      mode === "repair" && state.latestVerdict
        ? state.latestVerdict.issues.filter(
            (issue) => issue.targetTaskId === taskId,
          )
        : [];
    const message = createTaskMessage({
      type: mode,
      taskId,
      sessionId: "",
      cause: decision.reason,
      payload:
        mode === "repair"
          ? {
              fix_instructions: issues.map((issue) => ({
                severity: issue.severity,
                target_field: issue.targetField,
                description: issue.description,
                suggestion: issue.suggestion,
                task_id: issue.targetTaskId,
                task_type: issue.targetTaskType,
              })),
            }
          : {},
      repairScope: mode === "repair" ? "local" : "",
    });
    return this.submitWorker(
      state,
      "generator",
      this.buildTaskContext(state, task),
      message,
      this.defaultTimeoutSeconds,
      [],
      decision,
    );
  }

  private submitWorker(
    state: WorkflowState,
    workerType: WorkerKind,
    context: SessionContext,
    message: ReturnType<typeof createTaskMessage>,
    timeoutSeconds: number,
    evaluateScope: string[],
    decision?: RuntimeAction,
  ): boolean {
    const sessionId =
      message.sessionId || TaskMailbox.generateSessionId(context.taskId);
    message.sessionId = sessionId;
    context.taskId = context.taskId || message.taskId;

    const session = this.factory.createSession(workerType, sessionId, context);
    this.sessions.register(session);
    this.activeStreamContext = {
      workerType,
      taskId: context.taskId,
      taskType: context.taskType,
      sessionId,
    };

    // Submit with concurrency control (fire-and-forget)
    this.backend
      .submitSession(session, message, timeoutSeconds)
      .catch((error) => {
        this.logger.error(
          `Failed to submit ${workerType} session: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    this.inflight.set(sessionId, {
      sessionId,
      workerType,
      taskId: context.taskId,
      messageType: message.type as "spawn" | "repair" | "replan",
      evaluateScope: [...evaluateScope],
      decision,
    });
    state.markTaskStatus(context.taskId, "running", sessionId, {
      workerType,
      messageType: message.type,
    });
    return true;
  }

  private async drainBackendNotifications(state: WorkflowState): Promise<void> {
    const notifications = this.backend.poll();
    for (const notif of notifications) {
      this.mailbox.sendNotification(notif);
      state.recordNotification(asPlainNotification(notif));
      if (TERMINAL_EVENTS.has(notif.event)) {
        await this.applyTerminalNotification(state, notif);
      }
    }
  }

  private async applyTerminalNotification(
    state: WorkflowState,
    notif: TaskNotification,
  ): Promise<void> {
    const inflight = this.inflight.get(notif.sessionId);
    if (inflight) {
      this.inflight.delete(notif.sessionId);
    }
    if (this.activeStreamContext?.sessionId === notif.sessionId) {
      this.activeStreamContext = null;
    }

    const taskId = inflight?.taskId || notif.taskId;
    const workerType: WorkerKind =
      inflight?.workerType ||
      (taskId === "planner"
        ? "planner"
        : taskId === "evaluator"
          ? "evaluator"
          : "generator");
    const messageType = inflight?.messageType ?? "spawn";

    if (notif.status === "completed") {
      if (workerType === "planner") {
        this.applyPlannerCompletion(state, notif, messageType, inflight?.decision);
      } else if (workerType === "generator") {
        await this.applyGeneratorCompletion(
          state,
          taskId,
          notif,
          messageType,
          inflight?.decision,
        );
      } else {
        this.applyEvaluatorTerminal(
          state,
          notif,
          inflight?.evaluateScope ?? [],
        );
      }
      return;
    }

    if (workerType === "evaluator" && notif.status === "rejected") {
      this.applyEvaluatorTerminal(state, notif, inflight?.evaluateScope ?? []);
      return;
    }

    state.markTaskStatus(taskId, notif.status, notif.sessionId, {
      event: notif.event,
      summary: notif.summary,
    });
    if (notif.error || notif.summary) {
      state.errors.push(notif.error || notif.summary);
    }
  }

  private applyPlannerCompletion(
    state: WorkflowState,
    notif: TaskNotification,
    messageType: "spawn" | "repair" | "replan",
    decision?: RuntimeAction,
  ): void {
    if (messageType === "replan" && isPlanMutationResult(notif.result)) {
      const errors = state.mutatePlan(notif.result);
      if (errors.length > 0) {
        state.markTaskStatus("planner", "failed", notif.sessionId, {
          errors,
        });
        state.errors.push(...errors);
        return;
      }
    } else if (isExecutionPlanResult(notif.result)) {
      state.plan = notif.result;
    } else {
      state.markTaskStatus("planner", "failed", notif.sessionId, {
        error: "planner returned invalid result",
      });
      state.errors.push("planner returned invalid result");
      return;
    }

    state.markTaskStatus("planner", "completed", notif.sessionId);
    this.emitRuntimeEvent("planning_completed", "planner completed", {
      goal: state.goal,
      phase: "planning",
      status: "completed",
      data: this.snapshotState(state),
    });
    if (messageType === "replan" && decision) {
      this.persistValidatedCoordinatorDecision(
        state,
        decision,
        "planner completed replan without mutation errors",
      );
    }
  }

  private async applyGeneratorCompletion(
    state: WorkflowState,
    taskId: string,
    notif: TaskNotification,
    messageType: "spawn" | "repair" | "replan",
    decision?: RuntimeAction,
  ): Promise<void> {
    if (!isArtifactResult(notif.result)) {
      state.markTaskStatus(taskId, "failed", notif.sessionId, {
        error: "generator returned invalid artifact",
      });
      state.errors.push(`generator returned invalid artifact for ${taskId}`);
      return;
    }
    const artifact = notif.result;
    artifact.taskId = taskId;
    if (messageType === "repair") {
      state.recordRepairAttempt(taskId);
    }
    state.addArtifact(artifact);
    state.markTaskStatus(taskId, "completed", notif.sessionId);

    // If this is an analyze task, check if ALL analyze tasks are done.
    // If so, run LLM merge to produce a unified requirementJson.
    if (artifact.type === "analyze") {
      await this.tryMergeAnalyzeResults(state);
    }

    this.saveArtifactIncrementally(state, artifact);
    this.emitRuntimeEvent(
      messageType === "repair" ? "repair_task_completed" : "task_completed",
      `${taskId} completed`,
      {
        goal: state.goal,
        phase: messageType === "repair" ? "repair" : "generation",
        taskId,
        taskType: artifact.type,
        status: "completed",
        data: this.snapshotState(state),
      },
    );
    if (decision?.action === "regenerate") {
      this.persistValidatedCoordinatorDecision(
        state,
        decision,
        `${taskId} regenerated and produced a valid artifact`,
      );
    }
    persistMemoryWrites(extractGeneratorLesson(artifact));
  }

  /**
   * Check if all analyze tasks in the plan are completed.
   * If so, gather their artifacts and run LLM merge.
   */
  private async tryMergeAnalyzeResults(state: WorkflowState): Promise<void> {
    const plan = state.plan;
    if (!plan) return;

    const analyzeTasks = plan.tasks.filter((t) => t.type === "analyze");
    if (analyzeTasks.length <= 1) return; // single analyze: no merge needed

    const allDone = analyzeTasks.every((t) => state.isTaskCompleted(t.id));
    if (!allDone) return;

    // Gather all analyze artifacts
    const artifacts = analyzeTasks
      .map((t) => {
        const art = state.artifactsState.artifacts[t.id];
        if (!art || !art.content || typeof art.content !== "object") return null;
        return { taskId: t.id, content: art.content as Record<string, unknown> };
      })
      .filter((a): a is { taskId: string; content: Record<string, unknown> } => a !== null);

    if (artifacts.length <= 1) return;

    this.emitRuntimeEvent(
      "merge_started",
      "all analyze tasks completed, merging results",
      { goal: state.goal, phase: "merge", data: { artifactCount: artifacts.length } },
    );

    try {
      const merged = await this.analyzeMerger.merge(
        artifacts,
        state.requirementText ?? "",
      );
      state.requirementJson = RequirementNormalizer.normalize(merged);

      // Persist merged result to disk
      const outputManager = new (this.outputManagerClass)(state.outputDir);
      outputManager.saveRequirementAnalysis(merged);

      this.emitRuntimeEvent(
        "merge_completed",
        "analyze results merged successfully",
        {
          goal: state.goal,
          phase: "merge",
          data: {
            actorCount: (merged.actors as unknown[])?.length ?? 0,
            entityCount: (merged.entities as unknown[])?.length ?? 0,
            functionCount: (merged.functions as unknown[])?.length ?? 0,
          },
        },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.emitRuntimeEvent("merge_failed", `merge failed: ${msg}`, {
        goal: state.goal,
        phase: "merge",
      });
      // Merge failed: last analyze result remains as requirementJson
    }
  }

  private applyEvaluatorTerminal(
    state: WorkflowState,
    notif: TaskNotification,
    evaluateScope: string[],
  ): void {
    if (!isVerdictResult(notif.result)) {
      state.markTaskStatus("evaluator", "failed", notif.sessionId, {
        error: "evaluator returned invalid verdict",
      });
      state.errors.push("evaluator returned invalid verdict");
      return;
    }
    const verdict = notif.result;
    if (verdict.evaluatedTaskIds.length === 0 && evaluateScope.length > 0) {
      verdict.evaluatedTaskIds = [...evaluateScope];
    }
    state.addVerdict(verdict);

    // Deterministic post-evaluation fix: repair artifacts in-place for fixable issues
    if (!verdict.passed) {
      this._applyDeterministicFixes(state, verdict);
    }

    state.markTaskStatus(
      "evaluator",
      notif.status === "rejected" ? "rejected" : "completed",
      notif.sessionId,
    );
    this.emitRuntimeEvent(
      "evaluation_completed",
      verdict.summary || "evaluation finished",
      {
        goal: state.goal,
        phase: "evaluation",
        status: notif.status === "rejected" ? "rejected" : "completed",
        data: this.snapshotState(state),
      },
    );
    persistMemoryWrites(extractEvaluatorInsight(verdict, state.goal));
  }

  private buildTaskContext(state: WorkflowState, task: Task): SessionContext {
    return new SessionContext({
      taskId: task.id,
      taskType: task.type,
      taskDescription: task.description,
      goal: state.goal,
      requirementText: state.requirementText,
      requirementJson: state.requirementJson,
      designText: state.designText,
      diagrams: state.diagrams,
      testCases: state.testCases,
      artifactSummary: state.artifactSummary(),
      artifactSnapshots: state.artifactSnapshots(),
      hints: task.contextHints,
      isDirectMode: state.isDirectMode,
    });
  }

  private saveArtifactIncrementally(
    state: WorkflowState,
    artifact: Artifact,
  ): void {
    const manager = new this.outputManagerClass(state.outputDir);
    if (artifact.type === "analyze" && isRecord(artifact.content)) {
      manager.saveRequirementAnalysis(artifact.content);
    } else if (
      artifact.type === "design" &&
      typeof artifact.content === "string"
    ) {
      manager.saveSystemDesign(artifact.content);
    } else if (artifact.type === "diagrams" && isRecord(artifact.content)) {
      manager.saveDiagrams(state.diagrams);
    } else if (
      artifact.type === "tests" &&
      typeof artifact.content === "string"
    ) {
      manager.saveTestCases(artifact.content);
    }
    manager.saveArtifactByTask(
      artifact.taskId,
      artifact.type,
      artifact.content,
    );
    this.emitRuntimeEvent(
      "artifact_saved",
      `saved artifact for ${artifact.taskId}`,
      {
        goal: state.goal,
        phase: "persist",
        taskId: artifact.taskId,
        taskType: artifact.type,
        status: "completed",
        data: this.snapshotState(state),
      },
    );
  }

  private actionSave(state: WorkflowState): boolean {
    mkdirSync(state.outputDir, { recursive: true });
    const manager = new this.outputManagerClass(state.outputDir);
    const hasOutput = Boolean(
      Object.keys(state.requirementJson).length > 0 ||
      state.designText ||
      Object.keys(state.diagrams).length > 0 ||
      state.testCases,
    );
    if (!hasOutput) return false;

    if (state.goal === "analyze") {
      manager.saveRequirementAnalysis(
        state.requirementJson,
        state.requirementText,
      );
    } else {
      manager.saveAll(
        state.requirementJson,
        state.requirementText,
        state.designText,
        state.diagrams,
        state.testCases,
        state.reviewResult,
      );
    }
    state.persisted = true;
    state.persistStatus = "final_saved";
    return true;
  }

  private actionSaveIfQualityGatePassed(
    state: WorkflowState,
    reason: string,
  ): boolean {
    const consistencyIssues = this.findOutputConsistencyIssues(state);
    if (consistencyIssues.length > 0) {
      for (const issue of consistencyIssues) {
        state.errors.push(`output consistency failed: ${issue}`);
      }
      state.qualityStatus = "rejected";
      state.finalReviewPassed = false;
      return false;
    }
    const latestVerdict = state.latestVerdict;
    if (latestVerdict && !latestVerdict.passed) {
      this.logger.warn(
        `skip final persist after ${reason}: final quality gate is not satisfied`,
      );
      state.persistStatus = "partial_saved";
      return false;
    }
    return this.actionSave(state);
  }

  private findOutputConsistencyIssues(state: WorkflowState): string[] {
    const functions = Array.isArray(state.requirementJson.functions)
      ? state.requirementJson.functions
      : [];
    const defined = new Set(
      functions
        .filter(
          (item): item is Record<string, unknown> =>
            isRecord(item) && Boolean(item.id),
        )
        .map((item) => String(item.id)),
    );
    if (defined.size === 0) return [];

    const refTexts = [
      state.designText,
      state.testCases,
      ...Object.values(state.diagrams).filter(
        (item): item is string => typeof item === "string",
      ),
    ];
    const referenced = new Set<string>();
    for (const text of refTexts) {
      for (const match of text.match(/\bF\d{3}\b/g) ?? []) {
        referenced.add(match);
      }
    }
    const unknown = [...referenced].filter((item) => !defined.has(item)).sort();
    return unknown.length > 0
      ? [
          `design/tests/diagrams reference undefined function IDs: ${unknown.join(", ")}`,
        ]
      : [];
  }

  private exportTrace(state: WorkflowState): void {
    try {
      mkdirSync(state.outputDir, { recursive: true });
      const manager = new this.outputManagerClass(state.outputDir);
      manager.saveTraceJson("run_summary.json", state.runSummary);
      manager.saveTraceJson("multi_agent_trace.json", {
        summary: state.runSummary,
        goal: state.goal,
        finished: state.finished,
        persisted: state.persisted,
        run_status: state.runStatus,
        quality_status: state.qualityStatus,
        persist_status: state.persistStatus,
        duration: state.duration(),
        notifications: this.mailbox.peekAllNotifications(),
      });
      if (this.trace.entries.length > 0) {
        manager.saveTrace("llm_trace.json", this.trace.exportJson());
      }
      this.emitRuntimeEvent("trace_exported", "trace files exported", {
        goal: state.goal,
        phase: "persist",
        status: "completed",
        data: this.snapshotState(state),
      });

      // Score output quality
      try {
        const score = OutputScorer.score(
          state.requirementJson as Record<string, unknown>,
          state.designText ?? "",
          state.diagrams as Record<string, unknown>,
          state.testCases ?? "",
          state.requirementJson as Record<string, unknown>,
          state.requirementText,
        );
        this.logger.info("\n" + OutputScorer.format(score));
        manager.saveTraceJson("quality_score.json", score as unknown as Record<string, unknown>);
      } catch (scoringError: unknown) {
        this.logger.warn(
          "quality scoring failed: " + (scoringError instanceof Error ? scoringError.message : String(scoringError)),
        );
      }
    } catch (error: unknown) {
      this.logger.warn(
        `trace export failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private emitBackendNotification(
    workerType: "planner" | "generator" | "evaluator",
    notification: TaskNotification,
  ): void {
    const kindByEvent: Record<string, string> = {
      started: "worker_started",
      resumed: "worker_resumed",
      heartbeat: "worker_heartbeat",
      timeout: "worker_timeout",
      result: "worker_result",
    };
    this.emitRuntimeEvent(
      kindByEvent[notification.event] ?? "worker_event",
      notification.summary || `${workerType} ${notification.event}`,
      {
        goal: this.activeStreamContext?.taskType || undefined,
        phase: workerType,
        taskId: notification.taskId,
        taskType: this.activeStreamContext?.taskType || undefined,
        sessionId: notification.sessionId,
        status: notification.status,
        data: {
          sequence: notification.sequence,
          event: notification.event,
          progressDelta: notification.progressDelta,
          error: notification.error,
        },
      },
    );
  }

  private emitLlmChunk(event: LlmStreamEvent): void {
    if (event.kind === "start") {
      this.emitRuntimeEvent("llm_started", this.llmEventMessage(event), {
        scope: "llm",
        phase: this.activeStreamContext?.workerType,
        taskId: this.activeStreamContext?.taskId,
        taskType: this.activeStreamContext?.taskType,
        sessionId: this.activeStreamContext?.sessionId,
        status: "running",
        tag: event.tag,
        data: {
          provider: event.provider,
          model: event.model,
          messageCount: event.messageCount,
          promptChars: event.promptChars,
          temperature: event.temperature,
          messageRoles: event.messageRoles,
          promptPreview: event.promptPreview,
        },
      });
      return;
    }

    if (event.kind === "end") {
      this.emitRuntimeEvent("llm_completed", this.llmEventMessage(event), {
        scope: "llm",
        phase: this.activeStreamContext?.workerType,
        taskId: this.activeStreamContext?.taskId,
        taskType: this.activeStreamContext?.taskType,
        sessionId: this.activeStreamContext?.sessionId,
        status: event.text ? "error" : "completed",
        tag: event.tag,
        data: {
          provider: event.provider,
          model: event.model,
          responseChars: event.responseChars,
          promptTokens: event.promptTokens,
          completionTokens: event.completionTokens,
          totalTokens: event.totalTokens,
          error: event.text,
        },
      });
      return;
    }

    this.emitRuntimeEvent("llm_chunk", event.text ?? "", {
      scope: "llm",
      phase: this.activeStreamContext?.workerType,
      taskId: this.activeStreamContext?.taskId,
      taskType: this.activeStreamContext?.taskType,
      sessionId: this.activeStreamContext?.sessionId,
      status: "running",
      tag: event.tag,
      chunk: event.text ?? "",
      data: {
        provider: event.provider,
        model: event.model,
      },
    });
  }

  private llmEventMessage(event: LlmStreamEvent): string {
    const context = [
      this.activeStreamContext?.workerType,
      this.activeStreamContext?.taskId,
      this.activeStreamContext?.taskType,
    ]
      .filter(Boolean)
      .join(" / ");
    if (event.kind === "start") {
      return [
        `asking ${event.provider}:${event.model}`,
        event.tag ? `tag ${event.tag}` : "",
        context ? `context ${context}` : "",
        event.promptChars !== undefined
          ? `prompt ${event.promptChars} chars`
          : "",
      ]
        .filter(Boolean)
        .join(" | ");
    }
    return [
      `completed ${event.provider}:${event.model}`,
      event.tag ? `tag ${event.tag}` : "",
      event.responseChars !== undefined
        ? `response ${event.responseChars} chars`
        : "",
      event.text ? event.text : "",
    ]
      .filter(Boolean)
      .join(" | ");
  }

  private emitRuntimeEvent(
    kind: string,
    message: string,
    extras: Partial<WorkflowEvent> = {},
  ): void {
    // Log to unified log file — debug for high-frequency noise, info for the rest
    if (kind === "worker_heartbeat" || kind === "llm_chunk") {
      this.logger.debug(`${kind} | ${message}`);
    } else {
      this.logger.info(`${kind} | ${message}`);
    }
    // Also emit as WorkflowEvent for console display
    if (!this.eventSink) return;
    this.eventSink(
      createWorkflowEvent({
        scope: extras.scope ?? "runtime",
        kind,
        message,
        ...extras,
      }),
    );
  }

  /**
   * Apply deterministic fixes to artifacts based on evaluation issues.
   * This bypasses the broken RepairTool session path by fixing directly.
   */
  private _applyDeterministicFixes(state: WorkflowState, verdict: Verdict): void {
    const fixablePatterns = [
      // Naming mismatch: "命名不一致.*为 'X'.*使用了 'Y'"
      { re: /命名不一致.*为\s*'(\w+)'.*使用了\s*'(\w+)'/, fix: 'naming' },
      // Ghost function ID: "功能ID不一致.*不存在的功能ID: F009, F010"
      { re: /功能ID不一致.*不存在的功能ID:\s*([F\d,\s]+)/, fix: 'ghostId' },
      // Missing entity in class diagram: "类图缺少需求分析中的核心实体: X, Y"
      { re: /类图缺少需求分析中的核心实体:\s*(.+)/, fix: 'missingEntity' },
    ];

    for (const issue of verdict.issues) {
      const desc = String(issue.description ?? "");
      for (const pattern of fixablePatterns) {
        const match = desc.match(pattern.re);
        if (!match) continue;

        const taskId = String(issue.targetTaskId ?? "");
        const artifactData = state.artifactsState.artifacts[taskId];
        if (!artifactData) continue;
        const artifactContent = artifactData.content;
        const artifactType = artifactData.type;

        let fixed = false;
        if (pattern.fix === 'naming') {
          const [, correctName, wrongName] = match;
          if (correctName && wrongName && correctName !== wrongName) {
            fixed = this._fixArtifactNaming(state, taskId, artifactContent, artifactType, correctName, wrongName);
          }
        } else if (pattern.fix === 'ghostId') {
          const ghostIds = match[1].split(/,\s*/).filter((s: string) => /^F\d+$/.test(s.trim()));
          if (ghostIds.length > 0) {
            fixed = this._fixArtifactGhostIds(state, taskId, artifactContent, artifactType, ghostIds);
          }
        } else if (pattern.fix === 'missingEntity') {
          const entityNames = match[1].split(/,\s*/).map((s: string) => s.trim()).filter(Boolean);
          if (entityNames.length > 0) {
            fixed = this._fixMissingEntities(state, taskId, artifactContent, artifactType, entityNames);
          }
        }

        if (fixed) {
          this.logger.info(`deterministic fix applied: ${pattern.fix} for task ${taskId}`);
        }
      }
    }
  }

  private _fixArtifactNaming(
    state: WorkflowState,
    taskId: string,
    content: unknown,
    artifactType: string,
    correctName: string,
    wrongName: string,
  ): boolean {
    if (artifactType === "diagrams" && typeof content === "object" && content !== null) {
      const obj = content as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      let changed = false;
      for (const [key, val] of Object.entries(obj)) {
        if (typeof val === "string") {
          let fixed = val.replace(
            new RegExp(`class ${this._escapeRegex(wrongName)}\\s*\\{`, "g"),
            `class ${correctName} {`,
          );
          fixed = fixed.replace(
            new RegExp(`\\b${this._escapeRegex(wrongName)}\\b`, "g"),
            correctName,
          );
          if (fixed !== val) changed = true;
          result[key] = fixed;
        } else {
          result[key] = val;
        }
      }
      if (changed) {
        state.addArtifact(createArtifact({ taskId, type: artifactType as "diagrams", content: result }));
        return true;
      }
    }
    if (typeof content === "string") {
      let fixed = content.replace(
        new RegExp(`\\*\\*${this._escapeRegex(wrongName)}\\*\\*`, "g"),
        `**${correctName}**`,
      );
      fixed = fixed.replace(
        new RegExp(`\\b${this._escapeRegex(wrongName)}\\b`, "g"),
        correctName,
      );
      if (fixed !== content) {
        state.addArtifact(createArtifact({ taskId, type: artifactType as "design", content: fixed }));
        return true;
      }
    }
    return false;
  }

  private _fixArtifactGhostIds(
    state: WorkflowState,
    taskId: string,
    content: unknown,
    artifactType: string,
    ghostIds: string[],
  ): boolean {
    const str = typeof content === "string"
      ? content
      : JSON.stringify(content ?? "");

    let fixed = str;
    for (const ghostId of ghostIds) {
      fixed = fixed.replace(
        new RegExp(`\\b${this._escapeRegex(ghostId)}\\b`, "g"),
        "",
      );
    }
    if (fixed !== str) {
      state.addArtifact(createArtifact({
        taskId,
        type: artifactType as "tests",
        content: fixed,
      }));
      return true;
    }
    return false;
  }

  private _fixMissingEntities(
    state: WorkflowState,
    taskId: string,
    content: unknown,
    artifactType: string,
    entityNames: string[],
  ): boolean {
    if (artifactType !== "diagrams" || typeof content !== "object" || content === null) return false;
    const obj = content as Record<string, unknown>;
    const classDiagram = String(obj.class_diagram ?? "");
    if (!classDiagram) return false;

    // Find entities from analysis that have attributes for generating stub class
    const reqEntities = (state.requirementJson.entities ?? []) as Array<Record<string, unknown>>;
    const entityMap = new Map<string, Record<string, unknown>>();
    for (const e of reqEntities) {
      const name = String(e.name ?? "").trim();
      if (name) entityMap.set(name, e);
    }

    const stubs: string[] = [];
    for (const name of entityNames) {
      const entity = entityMap.get(name);
      if (!entity) continue;
      const attrs = Array.isArray(entity.attributes)
        ? (entity.attributes as Array<Record<string, string>>)
            .map(a => `-${String(a.type ?? "String")} ${String(a.name ?? "id")}`)
            .slice(0, 5)
            .join("\n        ")
        : "-Long id";
      stubs.push(`    class ${name} {\n        ${attrs}\n    }`);
    }

    if (stubs.length === 0) return false;

    // Append stubs to class diagram
    const fixed = classDiagram.trimEnd() + "\n" + stubs.join("\n");
    const result = { ...obj, class_diagram: fixed };
    state.addArtifact(createArtifact({ taskId, type: "diagrams" as const, content: result }));
    this.logger.info(`deterministic: added ${stubs.length} missing entities to class diagram: ${entityNames.join(", ")}`);
    return true;
  }

  private _escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private snapshotState(state: WorkflowState): Record<string, unknown> {
    return {
      goal: state.goal,
      outputDir: state.outputDir,
      runStatus: state.runStatus,
      qualityStatus: state.qualityStatus,
      persistStatus: state.persistStatus,
      finished: state.finished,
      persisted: state.persisted,
      totalArtifacts: state.totalArtifacts,
      plannedTasks: state.plan?.tasks.length ?? 0,
      completedTasks: state.getCompletedPlanTaskIds().length,
      runningTasks: state.getRunningTaskIds().length,
      pendingTasks: state.getPendingTaskIds().length,
      blockedTasks: state.getBlockedTaskIds().length,
      failedTasks: state.getFailedTaskIds().length,
      readyTasks: state.getReadyTaskIds().length,
      verdicts: state.verdicts.length,
      errors: state.errors.length,
    };
  }
}
