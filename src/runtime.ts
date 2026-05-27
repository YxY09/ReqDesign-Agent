import { mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import type { AgentConfig } from "./config.js";
import { ConstitutionLoader, setConstitution } from "./constitution.js";
import { WorkerFactory } from "./execution/factory.js";
import { SessionBackend } from "./execution/backend.js";
import { LLMClient, type LlmCallInfo, type LlmStreamEvent } from "./llmClient.js";
import { setupLogger, initSharedLog, type Logger } from "./logger.js";
import { isRecord } from "./utils/isRecord.js";
import { OutputScorer } from "../evaluate/scorer.js";
import { RequirementNormalizer } from "./shared/normalizer.js";
import { PostGenerationValidator } from "./tools/validator.js";
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
import { OrchestrationConfig } from "./orchestration/budget.js";
import { BudgetManager } from "./orchestration/budget.js";
import { RunManager } from "./orchestration/runManager.js";
import { RunSummaryBuilder } from "./orchestration/runManager.js";
import { OutputManager } from "./outputManager.js";
import { SessionContext, SessionRegistry } from "./session.js";
import { WorkflowState } from "./state.js";
import { AgentOrchestrator } from "./orchestration/orchestrator.js";
import { EvaluationTool } from "./tools/evaluation.js";
import { GenerationTool } from "./tools/generation.js";
import { RepairTool } from "./tools/repair.js";
import { AnalyzeMerger } from "./generators/merge.js";
import { PlanningTool } from "./tools/planning.js";
import {
  createExecutionPlan,
  createTask,
  type Artifact,
  type ExecutionPlan,
  type PlanMutation,
  type RuntimeAction,
  type Task,
  type Verdict,
  type WorkerKind,
} from "./shared/types.js";
import { InputLoader } from "./inputLoader.js";
import { sliceBySections, type SectionIndex } from "./xmlParser.js";
import { TraceLogger } from "./traceLogger.js";
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
  readonly repairTool: RepairTool;
  private readonly analyzeMerger: AnalyzeMerger;
  readonly inputLoader: typeof InputLoader;
  readonly trace: TraceLogger;
  readonly executionBackendName: string;

  private readonly logger: Logger;
  private readonly memoryStore: MemoryStore;
  private readonly llm: LLMClient;
  private readonly factory: WorkerFactory;
  private readonly backend: SessionBackend;
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
    this.llm.setTraceSink((info) => this.recordLlmTrace(info));

    const projectRoot = resolve(process.cwd());
    const constitution = new ConstitutionLoader([
      projectRoot,
      dirname(projectRoot),
    ]);
    setConstitution(constitution);

    this.memoryStore = new MemoryStore(projectRoot, this.llm);
    setMemory(this.memoryStore);

    this.mailbox = new TaskMailbox();
    this.sessions = new SessionRegistry();
    this.plannerTool = new PlanningTool(this.llm);
    this.generatorTool = new GenerationTool(this.llm);
    this.evaluatorTool = new EvaluationTool(this.llm);
    this.repairTool = new RepairTool(this.llm);
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

    this.coordinator = new AgentOrchestrator(this.llm, this.budget);

    this.factory = new WorkerFactory(
      this.llm,
      this.mailbox,
      this.plannerTool,
      this.generatorTool,
      this.evaluatorTool,
      this.repairTool,
    );
    this.backend = new SessionBackend({
      factory: this.factory,
      heartbeatInterval: 0.25,
      maxConcurrency: parseInt(process.env.MAX_CONCURRENCY ?? "", 10) || 5,
      onNotification: (session, notification) => {
        this.emitBackendNotification(
          session.workerType as "planner" | "generator" | "evaluator" | "repair",
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

    // 设置实时追踪持久化
    const traceDir = join(outputDir, "traces");
    this.trace.setPersistPath(join(traceDir, "llm_trace.json"));
    state.startTime = Date.now() / 1000;

    // 打开运行日志
    // 在 logs/ 目录中打开统一日志文件
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
      // Load section index for XML inputs
      try {
        const loadResult = this.inputLoader.loadWithSections(inputPath);
        state.sectionIndex = loadResult.sectionIndex ?? [];
      } catch {
        state.sectionIndex = [];
      }
      this.trace.log("system", "input_loaded", { inputPath, goal });
      this.emitRuntimeEvent("input_loaded", `loaded input ${inputPath}`, {
        goal,
        data: this.snapshotState(state),
      });

      if (goal === "analyze") {
        state.setPlan(createExecutionPlan({
          goal: "analyze",
          reasoning: "analyze mode bootstrap",
          tasks: [
            createTask({
              id: "analyze-1",
              type: "analyze",
              description: "提取角色、功能、实体、约束等结构化信息",
            }),
          ],
        }));
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
        didDispatch: this.submitRepairTask(
          state,
          decision.taskId,
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
      state.recordRegenerateAttempt(decision.taskId);
      return {
        didDispatch: this.submitGeneratorTask(
          state,
          decision.taskId,
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
      // finish 前保存 review result，防止最终保存被跳过时丢失审查结果
      this.saveReviewIfPresent(state);
      return { didDispatch: true, breakLoop: true, skipFinalSave: true };
    }

    if (decision.action === "pause") {
      RunManager.markPaused(state);
      this.logger.info("Workflow paused: " + (decision.reason || "user requested"));
      // 暂停前保存 review result，防止最终保存被跳过时丢失审查结果
      this.saveReviewIfPresent(state);
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
    return this.submitGeneratorTask(state, taskId, decision);
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
      this.defaultTimeoutSeconds,
      evaluateScope,
    );
  }

  private submitGeneratorTask(
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
      this.defaultTimeoutSeconds,
      [],
      decision,
    );
  }

  private submitRepairTask(
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
    const prevSession = this.sessions.latestSessionForTask(taskId);
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

    // 提交（带并发控制，fire-and-forget）
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
      } else if (workerType === "generator" || workerType === "repair") {
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
      state.setPlan(notif.result);
    } else {
      state.markTaskStatus("planner", "failed", notif.sessionId, {
        error: "planner returned invalid result",
      });
      state.errors.push("planner returned invalid result");
      return;
    }

    // Copy registry from plan to state for downstream consumers
    if (state.plan?.registry) {
      state.registry = state.plan.registry;
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

    // 生成后验证：清理多余的类、幽灵 ID、重命名。
    // 必须在 addArtifact 之后运行，以便 requirementJson 可用。
    const cleaned = PostGenerationValidator.validate(
      state.requirementJson,
      artifact.type,
      artifact.content,
    );
    if (cleaned !== null) {
      artifact.content = cleaned;
      state.addArtifact(artifact);
    }

    state.markTaskStatus(taskId, "completed", notif.sessionId);

    // 如果这是一个 analyze 任务，检查是否所有 analyze 任务都已完成。
    // 如果是，运行 LLM 合并以生成统一的 requirementJson。
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
   * 检查计划中的所有 analyze 任务是否都已完成。
   * 如果是，收集它们的产品并运行 LLM 合并。
   */
  private async tryMergeAnalyzeResults(state: WorkflowState): Promise<void> {
    const plan = state.plan;
    if (!plan) return;

    const analyzeTasks = plan.tasks.filter((t) => t.type === "analyze");
    if (analyzeTasks.length <= 1) return; // single analyze: no merge needed

    const allDone = analyzeTasks.every((t) => state.isTaskCompleted(t.id));
    if (!allDone) return;

    // 收集所有 analyze 产物
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
      state.setRequirementJson(RequirementNormalizer.normalize(merged));
      RequirementNormalizer.normalizeAgainstSource(merged, state.requirementText ?? "");

      // 将合并结果持久化到磁盘
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
      // 合并失败：回退到程序化并集作为 requirementJson
      try {
        const fallback = this.analyzeMerger.preMerge(artifacts);
        state.setRequirementJson(RequirementNormalizer.normalize(fallback));
        RequirementNormalizer.normalizeAgainstSource(fallback, state.requirementText ?? "");
        const outputManager = new (this.outputManagerClass)(state.outputDir);
        outputManager.saveRequirementAnalysis(fallback);
        this.emitRuntimeEvent("merge_failed_with_fallback", "merge failed, persisted preMerge fallback", {
          goal: state.goal,
          phase: "merge",
          data: { fallbackReason: msg },
        });
      } catch (fallbackErr) {
        const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        this.emitRuntimeEvent("merge_failed_fallback_error", `preMerge fallback also failed: ${fbMsg}`, {
          goal: state.goal,
          phase: "merge",
        });
      }
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

  private saveArtifactIncrementally(
    state: WorkflowState,
    artifact: Artifact,
  ): void {
    const manager = new this.outputManagerClass(state.outputDir);
    if (
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

  /** 如果 reviewResult 有内容则立即保存，用于 pause/finish 等提前退出的路径。 */
  private saveReviewIfPresent(state: WorkflowState): void {
    if (Object.keys(state.reviewResult).length > 0) {
      try {
        const manager = new (this.outputManagerClass)(state.outputDir);
        manager.saveReviewReport("", state.reviewResult);
      } catch (err) {
        this.logger.warn(
          `Failed to save review before pause/finish: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private actionSaveIfQualityGatePassed(
    state: WorkflowState,
    reason: string,
  ): boolean {
    // 无论质量门通过与否，先保存 review result
    if (Object.keys(state.reviewResult).length > 0) {
      const manager = new (this.outputManagerClass)(state.outputDir);
      manager.saveReviewReport("", state.reviewResult);
    }

    const consistencyIssues = this.findOutputConsistencyIssues(state);
    if (consistencyIssues.length > 0) {
      for (const issue of consistencyIssues) {
        state.errors.push(`output consistency failed: ${issue}`);
      }
      state.setQualityStatus("rejected");
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

      // 对输出质量进行评分
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
    workerType: "planner" | "generator" | "evaluator" | "repair",
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
    const context = this.streamContextForTag(event.tag);
    if (event.kind === "start") {
      this.emitRuntimeEvent("llm_started", this.llmEventMessage(event), {
        scope: "llm",
        phase: context?.workerType,
        taskId: context?.taskId,
        taskType: context?.taskType,
        sessionId: context?.sessionId,
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
        phase: context?.workerType,
        taskId: context?.taskId,
        taskType: context?.taskType,
        sessionId: context?.sessionId,
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
      phase: context?.workerType,
      taskId: context?.taskId,
      taskType: context?.taskType,
      sessionId: context?.sessionId,
      status: "running",
      tag: event.tag,
      chunk: event.text ?? "",
      data: {
        provider: event.provider,
        model: event.model,
      },
    });
  }

  private recordLlmTrace(info: LlmCallInfo): void {
    this.trace.log("llm", "llm_call", {
      tag: info.tag,
      provider: info.provider,
      model: info.model,
      duration_ms: info.durationMs,
      input_messages: info.inputMessageCount,
      input_chars: info.inputChars,
      prompt_preview: info.promptPreview,
      response_chars: info.responseChars,
      response_text: info.responseText,
      prompt_tokens: info.promptTokens,
      completion_tokens: info.completionTokens,
      total_tokens: info.totalTokens,
    });
  }

  private llmEventMessage(event: LlmStreamEvent): string {
    const contextForTag = this.streamContextForTag(event.tag);
    const context = [
      contextForTag?.workerType,
      contextForTag?.taskId,
      contextForTag?.taskType,
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

  private streamContextForTag(tag: string): {
    workerType: WorkerKind;
    taskId: string;
    taskType: string;
    sessionId: string;
  } | null {
    const sessionId = tag.match(/\bsession=([^;\s]+)/)?.[1];
    if (sessionId) {
      const inflight = this.inflight.get(sessionId);
      if (inflight) {
        return {
          workerType: inflight.workerType,
          taskId: inflight.taskId,
          taskType: tag.match(/\btype=([^;\s]+)/)?.[1] ?? "",
          sessionId,
        };
      }
    }
    return this.activeStreamContext;
  }

  private emitRuntimeEvent(
    kind: string,
    message: string,
    extras: Partial<WorkflowEvent> = {},
  ): void {
    // 记录到统一日志文件 — 高频噪声用 debug，其余用 info
    if (kind === "worker_heartbeat" || kind === "llm_chunk") {
      this.logger.debug(`${kind} | ${message}`);
    } else {
      this.logger.info(`${kind} | ${message}`);
    }
    // 同时作为 WorkflowEvent 发出以供控制台显示
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
