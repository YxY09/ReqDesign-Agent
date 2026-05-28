import { mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import type { AgentConfig } from "./config.js";
import { ConstitutionLoader, setConstitution } from "./constitution.js";
import { WorkerFactory } from "./execution/factory.js";
import { SessionBackend } from "./execution/backend.js";
import { LLMClient, type LlmCallInfo, type LlmStreamEvent } from "./llmClient.js";
import { setupLogger, initSharedLog, type Logger } from "./logger.js";
import { isRecord } from "./utils/isRecord.js";

import { TaskMailbox, type TaskNotification } from "./messaging.js";
import { setMemory, MemoryStore } from "./memory/store.js";
import { extractCoordinatorDecision, persistMemoryWrites } from "./memory/extractors.js";
import { OrchestrationConfig } from "./orchestration/budget.js";
import { BudgetManager } from "./orchestration/budget.js";
import { RunManager } from "./orchestration/runManager.js";
import { RunSummaryBuilder } from "./orchestration/runManager.js";
import { OutputManager } from "./outputManager.js";
import { EventBridge } from "./runtime/eventBridge.js";
import { PersistenceService } from "./runtime/persistenceService.js";
import { WorkerDispatcher } from "./runtime/workerDispatcher.js";
import { ResultHandler } from "./runtime/resultHandler.js";

import { SessionRegistry } from "./session.js";
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
  type InflightWorker,
  type RuntimeAction,
  type WorkerKind,
} from "./shared/types.js";
import { InputLoader } from "./inputLoader.js";
import { TraceLogger } from "./traceLogger.js";
import {
  type WorkflowEvent,
  type WorkflowEventSink,
} from "./workflowEvents.js";

// Re-export for downstream compatibility (tests reference buildSectionToc from runtime.ts)
export { buildSectionToc } from "./runtime/workerDispatcher.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
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
  private readonly eventBridge: EventBridge;
  private readonly persistenceService: PersistenceService;
  private readonly workerDispatcher: WorkerDispatcher;
  private readonly resultHandler: ResultHandler;

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

    // Instantiate extracted services (wiring via getters for mutable state)
    this.eventBridge = new EventBridge({
      eventSink: () => this.eventSink,
      activeStreamContext: () => this.activeStreamContext,
      inflight: () => this.inflight,
      logger: this.logger,
      trace: this.trace,
    });
    this.persistenceService = new PersistenceService({
      outputManagerCtor: this.outputManagerClass,
      trace: this.trace,
      mailbox: this.mailbox,
      logger: this.logger,
      onEmitRuntimeEvent: (kind, message, extras) =>
        this.eventBridge.emitRuntimeEvent(kind, message, extras),
      onSnapshotState: (state) => this.snapshotState(state),
    });

    this.workerDispatcher = new WorkerDispatcher({
      factory: this.factory,
      backend: this.backend,
      sessions: this.sessions,
      logger: this.logger,
      defaultTimeoutSeconds: this.defaultTimeoutSeconds,
      getActiveStreamContext: () => this.activeStreamContext,
      setActiveStreamContext: (v) => { this.activeStreamContext = v; },
      getInflight: () => this.inflight,
    });

    this.resultHandler = new ResultHandler({
      backend: this.backend,
      mailbox: this.mailbox,
      logger: this.logger,
      analyzeMerger: this.analyzeMerger,
      outputManagerCtor: this.outputManagerClass,
      getInflight: () => this.inflight,
      getActiveStreamContext: () => this.activeStreamContext,
      setActiveStreamContext: (v) => { this.activeStreamContext = v; },
      onEmitRuntimeEvent: (kind, message, extras) =>
        this.eventBridge.emitRuntimeEvent(kind, message, extras),
      onSnapshotState: (state) => this.snapshotState(state),
      onSaveArtifactIncrementally: (state, artifact) =>
        this.persistenceService.saveArtifactIncrementally(state, artifact),
      onPersistValidatedCoordinatorDecision: (state, decision, validation) =>
        this.persistValidatedCoordinatorDecision(state, decision, validation),
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
        await this.resultHandler.drainBackendNotifications(state);

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

      await this.resultHandler.drainBackendNotifications(state);
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
        didDispatch: this.workerDispatcher.dispatchSpawn(state, decision),
        breakLoop: false,
        skipFinalSave: false,
      };
    }

    if (decision.action === "spawn_all_ready") {
      const ready = state.getReadyTaskIds();
      let submitted = false;
      for (const taskId of ready) {
        submitted =
          this.workerDispatcher.dispatchSpawn(state, { ...decision, action: "spawn", taskId }) ||
          submitted;
      }
      return { didDispatch: submitted, breakLoop: false, skipFinalSave: false };
    }

    if (decision.action === "repair") {
      if (!decision.taskId) {
        return { didDispatch: false, breakLoop: false, skipFinalSave: false };
      }
      return {
        didDispatch: this.workerDispatcher.submitRepairTask(
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
        didDispatch: this.workerDispatcher.submitGeneratorTask(
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
        didDispatch: this.workerDispatcher.submitPlanner(state, "replan", decision),
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

  // ── Persistence delegation ───────────────────────────────────────────────

  private actionSave(state: WorkflowState): boolean {
    return this.persistenceService.actionSave(state);
  }

  /** 如果 reviewResult 有内容则立即保存，用于 pause/finish 等提前退出的路径。 */
  private saveReviewIfPresent(state: WorkflowState): void {
    this.persistenceService.saveReviewIfPresent(state);
  }

  private actionSaveIfQualityGatePassed(
    state: WorkflowState,
    reason: string,
  ): boolean {
    return this.persistenceService.actionSaveIfQualityGatePassed(state, reason);
  }

  private exportTrace(state: WorkflowState): void {
    this.persistenceService.exportTrace(state);
  }

  // ── EventBridge delegation ───────────────────────────────────────────────

  private emitBackendNotification(
    workerType: "planner" | "generator" | "evaluator" | "repair",
    notification: TaskNotification,
  ): void {
    this.eventBridge.emitBackendNotification(workerType, notification);
  }

  private emitLlmChunk(event: LlmStreamEvent): void {
    this.eventBridge.emitLlmChunk(event);
  }

  private recordLlmTrace(info: LlmCallInfo): void {
    this.eventBridge.recordLlmTrace(info);
  }

  private emitRuntimeEvent(
    kind: string,
    message: string,
    extras: Partial<WorkflowEvent> = {},
  ): void {
    this.eventBridge.emitRuntimeEvent(kind, message, extras);
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
