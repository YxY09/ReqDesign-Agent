import { EventEmitter } from "node:events";
import type { TaskMessage, TaskNotification } from "../messaging.js";
import { SessionDescriptor, type WorkerSession } from "../session.js";

interface RunningMeta {
  session: WorkerSession;
  sequence: number;
  taskId: string;
  startedAt: number;
  lastHeartbeat: number;
  timeoutAt: number;
  messageType: string;
  promise: Promise<void>;
  settled: boolean;
  runKey: string;
  timeoutHandle: NodeJS.Timeout | null;
  heartbeatHandle: NodeJS.Timeout | null;
}

export interface ExecutionBackend {
  submit(
    sessionDescriptor: SessionDescriptor,
    message: TaskMessage,
    timeoutSeconds: number,
  ): Promise<void>;
  cancel(sessionId: string, reason?: string): void;
  poll(): TaskNotification[];
  inspect(sessionId: string): Record<string, unknown> | null;
  hasInflight(): boolean;
  isRunning(sessionId: string): boolean;
  shutdown(): void;
}

export class ThreadBackend extends EventEmitter implements ExecutionBackend {
  private readonly factory: {
    restore: (descriptor: SessionDescriptor) => WorkerSession;
  } | null;
  private readonly onLifecycle?: (
    session: WorkerSession,
    event: string,
    summary: string,
    status: string,
    sequence: number,
  ) => void;
  private readonly heartbeatInterval: number;
  private readonly onNotification?: (
    session: WorkerSession,
    notification: TaskNotification,
  ) => void;
  private readonly maxConcurrency: number;
  private readonly running = new Map<string, RunningMeta>();
  private readonly settledRuns = new Set<string>();
  private readonly sessionMap = new Map<string, WorkerSession>();
  private readonly pendingNotifications: TaskNotification[] = [];
  private readonly submissionQueue: Array<() => void> = [];

  constructor(options?: {
    factory?: {
      restore: (descriptor: SessionDescriptor) => WorkerSession;
    } | null;
    heartbeatInterval?: number;
    maxConcurrency?: number;
    onLifecycle?: (
      session: WorkerSession,
      event: string,
      summary: string,
      status: string,
      sequence: number,
    ) => void;
    onNotification?: (
      session: WorkerSession,
      notification: TaskNotification,
    ) => void;
  }) {
    super();
    this.factory = options?.factory ?? null;
    this.heartbeatInterval = options?.heartbeatInterval ?? 0.25;
    this.maxConcurrency = options?.maxConcurrency ?? 3;
    this.onLifecycle = options?.onLifecycle;
    this.onNotification = options?.onNotification;
  }

  async submit(
    sessionDescriptor: SessionDescriptor,
    message: TaskMessage,
    timeoutSeconds: number,
  ): Promise<void> {
    if (!this.factory) {
      throw new Error(
        "ThreadBackend has no factory; use submitSession() or provide a factory",
      );
    }
    const session = this.factory.restore(sessionDescriptor);
    await this.submitSession(session, message, timeoutSeconds);
  }

  async submitSession(
    session: WorkerSession,
    message: TaskMessage,
    timeoutSeconds: number,
  ): Promise<void> {
    // 达到并发上限时等待
    while (this.running.size >= this.maxConcurrency) {
      await new Promise<void>((resolve) => {
        this.submissionQueue.push(resolve);
      });
    }

    this.sessionMap.set(session.sessionId, session);
    const sequence = session.beginMessage(message, timeoutSeconds);
    const timeoutAt = Number(session.snapshot().timeoutAt ?? 0);
    const startedAt = Date.now() / 1000;
    const runKey = `${session.sessionId}:${sequence}`;

    this.onLifecycle?.(
      session,
      message.type === "repair" ? "resumed" : "started",
      `${session.workerType} ${message.type} started`,
      "running",
      sequence,
    );
    this.enqueueNotification(
      session,
      session.lifecycleNotification(
        message.type === "repair" ? "resumed" : "started",
        `${session.workerType} ${message.type} started`,
        "running",
        sequence,
      ),
    );

    const meta: RunningMeta = {
      session,
      sequence,
      taskId: session.context.taskId,
      startedAt,
      lastHeartbeat: startedAt,
      timeoutAt,
      messageType: message.type,
      settled: false,
      runKey,
      timeoutHandle: null,
      heartbeatHandle: null,
      promise: Promise.resolve(),
    };

    this.running.set(session.sessionId, meta);
    this.armTimeout(meta);
    this.armHeartbeats(meta);

    meta.promise = session
      .run(message)
      .then((notif) => {
        if (this.settledRuns.has(runKey)) {
          return;
        }
        const result = session.completeMessage(notif, sequence);
        this.settleRun(meta, result);
      })
      .catch((error: unknown) => {
        if (this.settledRuns.has(runKey)) {
          return;
        }
        const result = session.completeMessage(
          session.lifecycleNotification(
            "result",
            `${session.workerType} execution failed`,
            "failed",
            sequence,
            error instanceof Error ? error.message : String(error),
          ),
          sequence,
        );
        this.settleRun(meta, result);
      })
      .finally(() => {
        this.releaseSubmissionSlot();
      });
  }

  cancel(sessionId: string, reason = ""): void {
    const session = this.sessionMap.get(sessionId);
    session?.requestCancel(reason || "cancelled via backend");
  }

  poll(): TaskNotification[] {
    const results = [...this.pendingNotifications];
    this.pendingNotifications.length = 0;
    return results;
  }

  inspect(sessionId: string): Record<string, unknown> | null {
    return this.sessionMap.get(sessionId)?.snapshot() ?? null;
  }

  hasInflight(): boolean {
    return this.running.size > 0;
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  shutdown(): void {
    for (const meta of this.running.values()) {
      this.clearTimers(meta);
    }
    this.running.clear();
    this.sessionMap.clear();
    this.settledRuns.clear();
    while (this.submissionQueue.length > 0) {
      const nextSubmission = this.submissionQueue.shift();
      nextSubmission?.();
    }
  }

  /**
   * 等待后端状态变化（新通知或 Worker 完成）。
   * 如果已有待处理任务则立即返回，否则最多等待 timeoutMs。
   */
  async waitForChange(timeoutMs = 5000): Promise<void> {
    if (this.pendingNotifications.length > 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.off("state_changed", handler);
        resolve();
      }, timeoutMs);

      const handler = () => {
        clearTimeout(timer);
        this.off("state_changed", handler);
        resolve();
      };

      this.once("state_changed", handler);
    });
  }

  private enqueueNotification(
    session: WorkerSession,
    notification: TaskNotification,
    wakeRuntime = true,
  ): void {
    this.pendingNotifications.push(notification);
    this.onNotification?.(session, notification);
    if (wakeRuntime) {
      this.emit("state_changed");
    }
  }

  private armTimeout(meta: RunningMeta): void {
    if (!meta.timeoutAt) {
      return;
    }
    const timeoutMs = Math.max(0, Math.round((meta.timeoutAt - meta.startedAt) * 1000));
    meta.timeoutHandle = setTimeout(() => {
      if (meta.settled) {
        return;
      }
      meta.session.markTimeout(
        `${meta.session.workerType} session exceeded ${(meta.timeoutAt - meta.startedAt).toFixed(1)}s timeout`,
      );
      const notification = meta.session.lifecycleNotification(
        "timeout",
        `${meta.session.workerType} session timed out`,
        "failed",
        meta.sequence,
        String(meta.session.snapshot().error ?? ""),
      );
      this.settleRun(meta, notification);
    }, timeoutMs);
  }

  private armHeartbeats(meta: RunningMeta): void {
    if (this.heartbeatInterval <= 0) {
      return;
    }
    const heartbeatMs = Math.max(1, Math.round(this.heartbeatInterval * 1000));
    meta.heartbeatHandle = setInterval(() => {
      if (meta.settled) {
        this.clearHeartbeat(meta);
        return;
      }
      meta.session.markHeartbeat();
      meta.lastHeartbeat = Date.now() / 1000;
      this.enqueueNotification(
        meta.session,
        meta.session.lifecycleNotification(
          "heartbeat",
          `${meta.session.workerType} ${meta.messageType} heartbeat`,
          "running",
          meta.sequence,
        ),
        false,
      );
    }, heartbeatMs);
  }

  private settleRun(meta: RunningMeta, notification: TaskNotification | null): void {
    if (meta.settled) {
      return;
    }
    meta.settled = true;
    this.clearTimers(meta);
    this.running.delete(meta.session.sessionId);
    this.settledRuns.add(meta.runKey);
    if (notification) {
      this.enqueueNotification(meta.session, notification);
    }
  }

  private clearTimers(meta: RunningMeta): void {
    if (meta.timeoutHandle) {
      clearTimeout(meta.timeoutHandle);
      meta.timeoutHandle = null;
    }
    this.clearHeartbeat(meta);
  }

  private clearHeartbeat(meta: RunningMeta): void {
    if (meta.heartbeatHandle) {
      clearInterval(meta.heartbeatHandle);
      meta.heartbeatHandle = null;
    }
  }

  private releaseSubmissionSlot(): void {
    const nextSubmission = this.submissionQueue.shift();
    if (nextSubmission) {
      nextSubmission();
    }
  }
}
