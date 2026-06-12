import type { Logger } from "../logger.js";
import type { TraceLogger } from "../traceLogger.js";
import { type LlmCallInfo, type LlmStreamEvent } from "../llmClient.js";
import type { TaskNotification } from "../messaging.js";
import { type InflightWorker, type WorkerKind } from "../shared/types.js";
import {
  createWorkflowEvent,
  type WorkflowEvent,
  type WorkflowEventSink,
} from "../workflowEvents.js";

/** Mutable state dependencies injected as getter functions from MultiAgentRuntime. */
export interface EventBridgeDeps {
  /** Returns the current event sink (null when no run is active). */
  eventSink: () => WorkflowEventSink | null;
  /** Returns the active stream context for the current worker. */
  activeStreamContext: () => {
    workerType: WorkerKind;
    taskId: string;
    taskType: string;
    sessionId: string;
  } | null;
  /** Returns the in-flight worker map keyed by session ID. */
  inflight: () => Map<string, InflightWorker>;
  logger: Logger;
  trace: TraceLogger;
}

/**
 * Centralised event emission bridge for MultiAgentRuntime.
 *
 * All runtime events (backend notifications, LLM stream chunks, trace
 * records, and high-level runtime events) flow through this class so they
 * can be extracted from the runtime monolith without altering call sites.
 */
export class EventBridge {
  private readonly deps: EventBridgeDeps;

  constructor(deps: EventBridgeDeps) {
    this.deps = deps;
  }

  // ── public API (called by MultiAgentRuntime or wired as callbacks) ──────

  emitBackendNotification(
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
        goal: this.deps.activeStreamContext()?.taskType || undefined,
        phase: workerType,
        taskId: notification.taskId,
        taskType: this.deps.activeStreamContext()?.taskType || undefined,
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

  emitLlmChunk(event: LlmStreamEvent): void {
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

  recordLlmTrace(info: LlmCallInfo): void {
    this.deps.trace.log("llm", "llm_call", {
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

  llmEventMessage(event: LlmStreamEvent): string {
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

  streamContextForTag(tag: string): {
    workerType: WorkerKind;
    taskId: string;
    taskType: string;
    sessionId: string;
  } | null {
    const sessionId = tag.match(/\bsession=([^;\s]+)/)?.[1];
    if (sessionId) {
      const inflight = this.deps.inflight().get(sessionId);
      if (inflight) {
        return {
          workerType: inflight.workerType,
          taskId: inflight.taskId,
          taskType: tag.match(/\btype=([^;\s]+)/)?.[1] ?? "",
          sessionId,
        };
      }
    }
    return this.deps.activeStreamContext();
  }

  emitRuntimeEvent(
    kind: string,
    message: string,
    extras: Partial<WorkflowEvent> = {},
  ): void {
    // 记录到统一日志文件 — 高频噪声用 debug，其余用 info
    if (kind === "worker_heartbeat" || kind === "llm_chunk") {
      this.deps.logger.debug(`${kind} | ${message}`);
    } else {
      this.deps.logger.info(`${kind} | ${message}`);
    }
    // 同时作为 WorkflowEvent 发出以供控制台显示
    if (!this.deps.eventSink()) return;
    this.deps.eventSink()!(
      createWorkflowEvent({
        scope: extras.scope ?? "runtime",
        kind,
        message,
        ...extras,
      }),
    );
  }
}
