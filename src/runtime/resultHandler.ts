import type { Logger } from "../logger.js";
import type { AnalyzeMerger } from "../generators/merge.js";
import type { OutputManager } from "../outputManager.js";
import type { WorkflowState } from "../state.js";
import type { WorkflowEvent } from "../workflowEvents.js";
import { isRecord } from "../utils/isRecord.js";
import { RequirementNormalizer } from "../shared/normalizer.js";
import { PostGenerationValidator } from "../tools/validator.js";
import { persistMemoryWrites } from "../memory/extractors.js";
import { extractGeneratorLesson } from "../memory/extractors.js";
import { extractEvaluatorInsight } from "../memory/extractors.js";
import {
  TERMINAL_EVENTS,
  type TaskNotification,
  type TaskMailbox,
} from "../messaging.js";
import type { SessionBackend } from "../execution/backend.js";
import {
  type Artifact,
  type ExecutionPlan,
  type InflightWorker,
  type PlanMutation,
  type RuntimeAction,
  type Verdict,
  type WorkerKind,
} from "../shared/types.js";

// ── Private helpers ──────────────────────────────────────────────────────────

export function asPlainNotification(notif: TaskNotification): Record<string, unknown> {
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

export function isArtifactResult(value: unknown): value is Artifact {
  return (
    isRecord(value) &&
    typeof value.taskId === "string" &&
    typeof value.type === "string"
  );
}

export function isVerdictResult(value: unknown): value is Verdict {
  return (
    isRecord(value) &&
    typeof value.passed === "boolean" &&
    Array.isArray(value.issues) &&
    Array.isArray(value.evaluatedTaskIds)
  );
}

export function isExecutionPlanResult(value: unknown): value is ExecutionPlan {
  return (
    isRecord(value) &&
    Array.isArray(value.tasks) &&
    typeof value.goal === "string"
  );
}

export function isPlanMutationResult(value: unknown): value is PlanMutation {
  return (
    isRecord(value) &&
    Array.isArray(value.addTasks) &&
    Array.isArray(value.updateTasks) &&
    Array.isArray(value.dropTaskIds) &&
    isRecord(value.reorderEdges)
  );
}

// ── Deps interface ───────────────────────────────────────────────────────────

export interface ResultHandlerDeps {
  backend: SessionBackend;
  mailbox: TaskMailbox;
  logger: Logger;
  analyzeMerger: AnalyzeMerger;
  outputManagerCtor: typeof OutputManager;
  getInflight: () => Map<string, InflightWorker>;
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
  onEmitRuntimeEvent: (
    kind: string,
    message: string,
    extras: Partial<WorkflowEvent>,
  ) => void;
  onSnapshotState: (state: WorkflowState) => Record<string, unknown>;
  onSaveArtifactIncrementally: (
    state: WorkflowState,
    artifact: Artifact,
  ) => void;
  onPersistValidatedCoordinatorDecision: (
    state: WorkflowState,
    decision: RuntimeAction,
    validation: string,
  ) => void;
}

// ── ResultHandler class ──────────────────────────────────────────────────────

export class ResultHandler {
  private readonly deps: ResultHandlerDeps;

  constructor(deps: ResultHandlerDeps) {
    this.deps = deps;
  }

  async drainBackendNotifications(state: WorkflowState): Promise<void> {
    const notifications = this.deps.backend.poll();
    for (const notif of notifications) {
      this.deps.mailbox.sendNotification(notif);
      state.recordNotification(asPlainNotification(notif));
      if (TERMINAL_EVENTS.has(notif.event)) {
        await this.applyTerminalNotification(state, notif);
      }
    }
  }

  async applyTerminalNotification(
    state: WorkflowState,
    notif: TaskNotification,
  ): Promise<void> {
    const inflight = this.deps.getInflight().get(notif.sessionId);
    if (inflight) {
      this.deps.getInflight().delete(notif.sessionId);
    }
    if (this.deps.getActiveStreamContext()?.sessionId === notif.sessionId) {
      this.deps.setActiveStreamContext(null);
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

  applyPlannerCompletion(
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
    this.deps.onEmitRuntimeEvent("planning_completed", "planner completed", {
      goal: state.goal,
      phase: "planning",
      status: "completed",
      data: this.deps.onSnapshotState(state),
    });
    if (messageType === "replan" && decision) {
      this.deps.onPersistValidatedCoordinatorDecision(
        state,
        decision,
        "planner completed replan without mutation errors",
      );
    }
  }

  async applyGeneratorCompletion(
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

    // 生成后验证：清理多余的类、幽灵 ID、重命名。
    const cleaned = PostGenerationValidator.validate(
      state.requirementJson,
      artifact.type,
      artifact.content,
    );
    if (cleaned !== null) {
      artifact.content = cleaned;
    }
    state.addArtifact(artifact);

    state.markTaskStatus(taskId, "completed", notif.sessionId);

    // 如果这是一个 analyze 任务，检查是否所有 analyze 任务都已完成。
    // 如果是，运行 LLM 合并以生成统一的 requirementJson。
    if (artifact.type === "analyze") {
      await this.tryMergeAnalyzeResults(state);
    }

    this.deps.onSaveArtifactIncrementally(state, artifact);
    this.deps.onEmitRuntimeEvent(
      messageType === "repair" ? "repair_task_completed" : "task_completed",
      `${taskId} completed`,
      {
        goal: state.goal,
        phase: messageType === "repair" ? "repair" : "generation",
        taskId,
        taskType: artifact.type,
        status: "completed",
        data: this.deps.onSnapshotState(state),
      },
    );
    if (decision?.action === "regenerate") {
      this.deps.onPersistValidatedCoordinatorDecision(
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
  async tryMergeAnalyzeResults(state: WorkflowState): Promise<void> {
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

    this.deps.onEmitRuntimeEvent(
      "merge_started",
      "all analyze tasks completed, merging results",
      { goal: state.goal, phase: "merge", data: { artifactCount: artifacts.length } },
    );

    try {
      const merged = await this.deps.analyzeMerger.merge(
        artifacts,
        state.requirementText ?? "",
      );
      state.setRequirementJson(RequirementNormalizer.normalize(merged));
      RequirementNormalizer.normalizeAgainstSource(merged, state.requirementText ?? "");

      // 将合并结果持久化到磁盘
      const outputManager = new (this.deps.outputManagerCtor)(state.outputDir);
      outputManager.saveRequirementAnalysis(merged);

      this.deps.onEmitRuntimeEvent(
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
      this.deps.onEmitRuntimeEvent("merge_failed", `merge failed: ${msg}`, {
        goal: state.goal,
        phase: "merge",
      });
      // 合并失败：回退到程序化并集作为 requirementJson
      try {
        const fallback = this.deps.analyzeMerger.preMerge(artifacts);
        state.setRequirementJson(RequirementNormalizer.normalize(fallback));
        RequirementNormalizer.normalizeAgainstSource(fallback, state.requirementText ?? "");
        const outputManager = new (this.deps.outputManagerCtor)(state.outputDir);
        outputManager.saveRequirementAnalysis(fallback);
        this.deps.onEmitRuntimeEvent("merge_failed_with_fallback", "merge failed, persisted preMerge fallback", {
          goal: state.goal,
          phase: "merge",
          data: { fallbackReason: msg },
        });
      } catch (fallbackErr) {
        const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        this.deps.onEmitRuntimeEvent("merge_failed_fallback_error", `preMerge fallback also failed: ${fbMsg}`, {
          goal: state.goal,
          phase: "merge",
        });
      }
    }
  }

  applyEvaluatorTerminal(
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
    this.deps.onEmitRuntimeEvent(
      "evaluation_completed",
      verdict.summary || "evaluation finished",
      {
        goal: state.goal,
        phase: "evaluation",
        status: notif.status === "rejected" ? "rejected" : "completed",
        data: this.deps.onSnapshotState(state),
      },
    );
    persistMemoryWrites(extractEvaluatorInsight(verdict, state.goal));
  }
}
