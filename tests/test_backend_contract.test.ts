/**
 * 后端契约测试：每个 ExecutionBackend 都必须通过这些测试。
 *
 * 测试是参数化的，因此添加新的后端只需要添加一个新的 describe 块。
 *
 * 移植自 tests/test_backend_contract.py。
 */
import { describe, it, expect } from "vitest";
import { SessionBackend } from "../src/execution/backend.js";
import { TaskMailbox, createTaskMessage, type TaskNotification } from "../src/messaging.js";
import {
  SessionContext,
  SessionDescriptor,
  WorkerSession,
} from "../src/session.js";
import { createArtifact } from "../src/shared/types.js";

// -----------------------------------------------------------------------
// 辅助函数 — 延迟
// -----------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -----------------------------------------------------------------------
// 存根会话
// -----------------------------------------------------------------------

/** 立即完成。 */
class FastSession extends WorkerSession {
  get workerType(): string {
    return "generator";
  }

  async run(_message: TaskNotification): Promise<TaskNotification> {
    this.state.messageCount += 1;
    this.state.finished = true;
    return this._makeNotification("completed", {
      summary: "fast done",
      result: createArtifact({
        taskId: this.context.taskId,
        type: this.context.taskType as "design",
        content: "generated",
      }),
    });
  }
}

/** 大约 50ms 后完成。 */
class SlowSession extends WorkerSession {
  get workerType(): string {
    return "generator";
  }

  async run(_message: TaskNotification): Promise<TaskNotification> {
    this.state.messageCount += 1;
    await delay(50);
    return this._makeNotification("completed", {
      summary: "slow done",
      result: createArtifact({
        taskId: this.context.taskId,
        type: this.context.taskType as "design",
        content: "generated",
      }),
    });
  }
}

/** 总是抛出异常。 */
class FailingSession extends WorkerSession {
  get workerType(): string {
    return "generator";
  }

  async run(_message: TaskNotification): Promise<TaskNotification> {
    throw new Error("intentional test failure");
  }
}

// -----------------------------------------------------------------------
// 工厂辅助函数
// -----------------------------------------------------------------------

function makeContext(taskId = "design-1", taskType = "design"): SessionContext {
  return new SessionContext({ taskId, taskType });
}

function makeDesc(
  taskId = "design-1",
  taskType = "design",
): SessionDescriptor {
  return new SessionDescriptor({
    sessionId: TaskMailbox.generateSessionId(taskId),
    workerType: "generator",
    context: makeContext(taskId, taskType).toDict(),
  });
}

function makeFactory(
  SessionClass: new (
    sid: string,
    ctx: SessionContext,
    mb: { sendNotification: (n: TaskNotification) => void } | null,
    llm: unknown,
  ) => WorkerSession,
): { restore: (descriptor: SessionDescriptor) => WorkerSession } {
  return {
    restore(descriptor: SessionDescriptor): WorkerSession {
      const context = SessionContext.fromDict(descriptor.context);
      const mailbox = new TaskMailbox();
      const session = new SessionClass(descriptor.sessionId, context, mailbox, null);
      session.restoreFromDescriptor(descriptor);
      return session;
    },
  };
}

function makeBackend(
  factory?: { restore: (d: SessionDescriptor) => WorkerSession },
): SessionBackend {
  const be = new SessionBackend({ heartbeatInterval: 0 });
  (be as Record<string, unknown>)._factory = factory ?? makeFactory(FastSession);
  return be;
}

function submitAndWait(
  be: SessionBackend,
  desc: SessionDescriptor,
  msg: ReturnType<typeof makeMsg>,
  timeoutSec = 5.0,
): void {
  const factory = (be as Record<string, unknown>)._factory as { restore: (d: SessionDescriptor) => WorkerSession };
  const session = factory.restore(desc);
  be.submitSession(session, msg, timeoutSec);
}

function makeMsg(desc: SessionDescriptor) {
  return createTaskMessage({
    type: "spawn",
    taskId: (desc.context as Record<string, unknown>).taskId as string ?? "design-1",
    sessionId: desc.sessionId,
  });
}

// -----------------------------------------------------------------------
// 契约：SessionBackend
// -----------------------------------------------------------------------

describe("SessionBackend contract", () => {
  it("submit and poll returns completed notification", async () => {
    const be = makeBackend();
    const desc = makeDesc();
    const msg = makeMsg(desc);
    submitAndWait(be, desc, msg, 5.0);

    let results: TaskNotification[] = [];
    for (let i = 0; i < 20; i++) {
      results = be.poll();
      if (results.some((n) => n.status === "completed")) break;
      await delay(10);
    }

    const completed = results.filter((n) => n.status === "completed");
    expect(completed.length).toBeGreaterThanOrEqual(1);
    expect(completed[0].result).not.toBeNull();
    be.shutdown();
  });

  it("cancel prevents normal result", async () => {
    const be = makeBackend(makeFactory(SlowSession));
    const desc = makeDesc();
    const msg = makeMsg(desc);
    submitAndWait(be, desc, msg, 5.0);
    be.cancel(desc.sessionId, "test cancel");

    await delay(100);
    const results = be.poll();
    expect(results.some((n) => n.status === "cancelled")).toBe(true);
    be.shutdown();
  });

  it("timeout terminates and removes from inflight", async () => {
    const be = makeBackend(makeFactory(SlowSession));
    const desc = makeDesc();
    const msg = makeMsg(desc);
    submitAndWait(be, desc, msg, 0.01);

    await delay(30);
    const results = be.poll();
    expect(results.some((n) => n.status === "failed")).toBe(true);
    expect(be.hasInflight()).toBe(false);
    be.shutdown();
  });

  it("inspect returns snapshot", async () => {
    const be = makeBackend();
    const desc = makeDesc();

    expect(be.inspect(desc.sessionId)).toBeNull();

    const msg = makeMsg(desc);
    submitAndWait(be, desc, msg, 5.0);
    const snap = be.inspect(desc.sessionId);
    expect(snap).not.toBeNull();
    expect(snap!["sessionId"]).toBe(desc.sessionId);
    be.shutdown();
  });

  it("hasInflight is correct throughout lifecycle", async () => {
    const be = makeBackend(makeFactory(SlowSession));
    const desc = makeDesc();
    const msg = makeMsg(desc);

    expect(be.hasInflight()).toBe(false);
    submitAndWait(be, desc, msg, 5.0);
    expect(be.hasInflight()).toBe(true);

    await delay(100);
    be.poll();
    expect(be.hasInflight()).toBe(false);
    be.shutdown();
  });

  it("exception produces failed notification", async () => {
    const be = makeBackend(makeFactory(FailingSession));
    const desc = makeDesc();
    const msg = makeMsg(desc);
    submitAndWait(be, desc, msg, 5.0);

    let results: TaskNotification[] = [];
    for (let i = 0; i < 20; i++) {
      results = be.poll();
      if (results.some((n) => n.status === "failed")) break;
      await delay(10);
    }

    expect(results.some((n) => n.status === "failed")).toBe(true);
    be.shutdown();
  });

  it("late result after timeout is discarded", async () => {
    const be = makeBackend(makeFactory(SlowSession));
    const desc = makeDesc();
    const msg = makeMsg(desc);
    submitAndWait(be, desc, msg, 0.01);

    await delay(30);
    const results = be.poll();
    expect(results.some((n) => n.status === "failed")).toBe(true);
    expect(be.hasInflight()).toBe(false);

    // 等待慢速会话实际完成
    await delay(50);
    const late = be.poll();
    expect(late.length).toBe(0);
    be.shutdown();
  });
});
