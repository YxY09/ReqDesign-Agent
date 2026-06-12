/**
 * 执行后端抽象的测试。
 *
 * 移植自 tests/test_execution_backends.py。
 *
 * 验证 SessionBackend 的行为是否一致和正确。
 */
import { describe, it, expect } from "vitest";
import { SessionBackend } from "../src/execution/backend.js";
import { TaskMailbox, createTaskMessage, type TaskNotification } from "../src/messaging.js";
import {
  SessionContext,
  SessionDescriptor,
  WorkerSession,
} from "../src/session.js";
import { createArtifact, type Artifact } from "../src/shared/types.js";

// -----------------------------------------------------------------------
// 辅助函数 — 存根会话
// -----------------------------------------------------------------------

/** 立即完成的会话。 */
class FastSession extends WorkerSession {
  get workerType(): string {
    return "generator";
  }

  async run(_message: TaskNotification): Promise<TaskNotification> {
    this.state.messageCount += 1;
    this.state.finished = true;
    return this._makeNotification("completed", {
      summary: "fast generation done",
      result: createArtifact({
        taskId: this.context.taskId,
        type: this.context.taskType as "design",
        content: "generated",
      }),
    });
  }
}

/** 大约 50ms 后完成的会话。 */
class SlowSession extends WorkerSession {
  get workerType(): string {
    return "generator";
  }

  async run(_message: TaskNotification): Promise<TaskNotification> {
    this.state.messageCount += 1;
    await delay(50);
    return this._makeNotification("completed", {
      summary: "slow generation done",
      result: createArtifact({
        taskId: this.context.taskId,
        type: this.context.taskType as "design",
        content: "generated",
      }),
    });
  }
}

/** 总是抛出异常的会话。 */
class FailingSession extends WorkerSession {
  get workerType(): string {
    return "generator";
  }

  async run(_message: TaskNotification): Promise<TaskNotification> {
    throw new Error("intentional failure for test");
  }
}

/** 阻塞很长时间的会话（用于卡住会话测试）。 */
class StuckSession extends WorkerSession {
  get workerType(): string {
    return "generator";
  }

  async run(_message: TaskNotification): Promise<TaskNotification> {
    // 阻塞时间远长于任何测试超时
    await delay(300_000);
    return this._makeNotification("completed", { summary: "stuck" });
  }
}

/** 在超过超时的延迟后完成的会话。 */
class EventuallyFinishesSession extends WorkerSession {
  get workerType(): string {
    return "generator";
  }

  async run(_message: TaskNotification): Promise<TaskNotification> {
    await delay(80);
    return this._makeNotification("completed", {
      summary: "late result",
      result: createArtifact({
        taskId: this.context.taskId,
        type: this.context.taskType as "design",
        content: "late",
      }),
    });
  }
}

// -----------------------------------------------------------------------
// 辅助函数 — 工厂
// -----------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSession(
  SessionClass: new (
    sessionId: string,
    context: SessionContext,
    mailbox: { sendNotification: (n: TaskNotification) => void } | null,
    llm: unknown,
  ) => WorkerSession,
  taskId = "design-1",
  taskType = "design",
): WorkerSession {
  const mailbox = new TaskMailbox();
  const context = new SessionContext({ taskId, taskType });
  const sessionId = TaskMailbox.generateSessionId(taskId);
  return new SessionClass(sessionId, context, mailbox, null);
}

function makeBackend(
  factoryOverride?: { restore: (descriptor: SessionDescriptor) => WorkerSession } | null,
): SessionBackend {
  if (factoryOverride !== undefined) {
    return new SessionBackend({
      factory: factoryOverride,
      heartbeatInterval: 0,
    });
  }

  const testFactory = {
    restore(descriptor: SessionDescriptor): WorkerSession {
      const context = SessionContext.fromDict(descriptor.context);
      const mailbox = new TaskMailbox();
      const session = new FastSession(descriptor.sessionId, context, mailbox, null);
      session.restoreFromDescriptor(descriptor);
      return session;
    },
  };

  return new SessionBackend({
    factory: testFactory,
    heartbeatInterval: 0,
  });
}

// -----------------------------------------------------------------------
// SessionBackend 测试
// -----------------------------------------------------------------------

describe("SessionBackend", () => {
  it("should submit a fast session and poll the result", async () => {
    const backend = makeBackend();
    const session = makeSession(FastSession);
    const msg = createTaskMessage({
      type: "spawn",
      taskId: "design-1",
      sessionId: session.sessionId,
    });

    backend.submitSession(session, msg, 5.0);

    // 轮询直到结果就绪
    let results: TaskNotification[] = [];
    for (let i = 0; i < 50; i++) {
      results = backend.poll();
      if (results.some((n) => n.status === "completed")) break;
      await delay(10);
    }

    // 过滤完成的 notification（忽略 started/heartbeat 生命周期事件）
    const completed = results.filter((n) => n.status === "completed");
    expect(completed.length).toBeGreaterThanOrEqual(1);
    const notif = completed[0];
    expect(notif.status).toBe("completed");
    expect(notif.result).not.toBeNull();

    backend.shutdown();
  });

  it("hasInflight should reflect running futures", async () => {
    const backend = makeBackend();
    const session = makeSession(SlowSession);
    const msg = createTaskMessage({
      type: "spawn",
      taskId: "design-1",
      sessionId: session.sessionId,
    });

    expect(backend.hasInflight()).toBe(false);

    backend.submitSession(session, msg, 5.0);
    expect(backend.hasInflight()).toBe(true);

    // 等待完成
    await delay(100);
    backend.poll();
    expect(backend.hasInflight()).toBe(false);

    backend.shutdown();
  });

  it("waitForChange should block until a new notification arrives", async () => {
    const backend = makeBackend();
    const session = makeSession(SlowSession);
    const msg = createTaskMessage({
      type: "spawn",
      taskId: "design-1",
      sessionId: session.sessionId,
    });

    backend.submitSession(session, msg, 5.0);

    const initial = backend.poll();
    expect(initial.some((n) => n.event === "started")).toBe(true);

    const startedAt = Date.now();
    await backend.waitForChange(500);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(35);
    const results = backend.poll();
    expect(results.some((n) => n.status === "completed")).toBe(true);

    backend.shutdown();
  });

  it("cancel should mark session as cancelled", async () => {
    const backend = makeBackend();
    const session = makeSession(SlowSession);
    const msg = createTaskMessage({
      type: "spawn",
      taskId: "design-1",
      sessionId: session.sessionId,
    });

    backend.submitSession(session, msg, 5.0);
    backend.cancel(session.sessionId, "test cancel");

    const snapshot = backend.inspect(session.sessionId);
    expect(snapshot).not.toBeNull();
    expect(snapshot!["cancelRequested"]).toBe(true);

    await delay(100);
    backend.poll();
    backend.shutdown();
  });

  it("inspect should return session snapshot", async () => {
    const backend = makeBackend();
    const session = makeSession(FastSession);

    const snapshotBefore = backend.inspect(session.sessionId);
    expect(snapshotBefore).toBeNull(); // Not submitted yet

    const msg = createTaskMessage({
      type: "spawn",
      taskId: "design-1",
      sessionId: session.sessionId,
    });
    backend.submitSession(session, msg, 5.0);

    const snapshotAfter = backend.inspect(session.sessionId);
    expect(snapshotAfter).not.toBeNull();
    expect(snapshotAfter!["sessionId"]).toBe(session.sessionId);

    await delay(100);
    backend.poll();
    backend.shutdown();
  });

  it("sessions that exceed timeout should be marked as failed", async () => {
    const backend = makeBackend();
    const session = makeSession(SlowSession);
    const msg = createTaskMessage({
      type: "spawn",
      taskId: "design-1",
      sessionId: session.sessionId,
    });

    backend.submitSession(session, msg, 0.01);

    // Wait for timeout
    await delay(30);

    const results = backend.poll();
    expect(results.length).toBeGreaterThanOrEqual(1);
    const failed = results.find(
      (n) => n.status === "failed" && n.summary.toLowerCase().includes("timed out"),
    );
    expect(failed).toBeDefined();

    backend.shutdown();
  });

  it("a timed-out stuck session must be removed from inflight", async () => {
    const backend = makeBackend();
    const session = makeSession(StuckSession);
    const msg = createTaskMessage({
      type: "spawn",
      taskId: "design-1",
      sessionId: session.sessionId,
    });

    backend.submitSession(session, msg, 0.01);
    expect(backend.hasInflight()).toBe(true);

    await delay(30);
    const results = backend.poll();
    expect(results.length).toBeGreaterThanOrEqual(1);
    const failed = results.find(
      (n) => n.status === "failed" && n.summary.toLowerCase().includes("timed out"),
    );
    expect(failed).toBeDefined();
    expect(backend.hasInflight()).toBe(false);

    backend.shutdown();
  });

  it("late result after timeout is discarded", async () => {
    const backend = makeBackend();
    const session = makeSession(EventuallyFinishesSession);
    const msg = createTaskMessage({
      type: "spawn",
      taskId: "design-1",
      sessionId: session.sessionId,
    });

    backend.submitSession(session, msg, 0.02);

    await delay(40);
    const results = backend.poll();
    expect(
      results.some(
        (n) => n.status === "failed" && n.summary.toLowerCase().includes("timed out"),
      ),
    ).toBe(true);
    expect(backend.hasInflight()).toBe(false);

    // Wait for the late thread to actually finish
    await delay(80);
    const lateResults = backend.poll();
    expect(lateResults.length).toBe(0);

    backend.shutdown();
  });

  it("session exceptions should result in failed notification", async () => {
    const backend = makeBackend();
    const session = makeSession(FailingSession);
    const msg = createTaskMessage({
      type: "spawn",
      taskId: "design-1",
      sessionId: session.sessionId,
    });

    backend.submitSession(session, msg, 5.0);

    let results: TaskNotification[] = [];
    for (let i = 0; i < 50; i++) {
      results = backend.poll();
      if (results.some((n) => n.status === "failed")) break;
      await delay(10);
    }

    const failed = results.find(
      (n) => n.status === "failed" && n.error.includes("intentional failure"),
    );
    expect(failed).toBeDefined();

    backend.shutdown();
  });

  it("shutdown should not raise even if called multiple times", () => {
    const backend = makeBackend();
    backend.shutdown();
    backend.shutdown();
    // No assertion needed — just that no error is thrown
  });

  it("submission queue should timeout when all workers are stuck", async () => {
    const backend = new SessionBackend({
      maxConcurrency: 1,
      submissionTimeoutSeconds: 1,
      heartbeatInterval: 0,
    });

    // Fill the pool with a stuck session
    const stuckSession = makeSession(StuckSession, "design-1");
    const msg1 = createTaskMessage({
      type: "spawn",
      taskId: "design-1",
      sessionId: stuckSession.sessionId,
    });
    backend.submitSession(stuckSession, msg1, 300);

    await delay(50);
    expect(backend.hasInflight()).toBe(true);

    // Second submission should timeout on queue wait
    const session2 = makeSession(FastSession, "design-2");
    const msg2 = createTaskMessage({
      type: "spawn",
      taskId: "design-2",
      sessionId: session2.sessionId,
    });

    await expect(
      backend.submitSession(session2, msg2, 300),
    ).rejects.toThrow("提交超时：所有 worker 都在忙碌中");

    backend.shutdown();
  });
});
