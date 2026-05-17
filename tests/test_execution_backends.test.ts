/**
 * Tests for the execution backend abstraction.
 *
 * Ported from tests/test_execution_backends.py.
 *
 * Validates that ThreadBackend behaves consistently and correctly.
 */
import { describe, it, expect } from "vitest";
import { ThreadBackend } from "../src/execution/backend.js";
import { TaskMailbox, createTaskMessage, type TaskNotification } from "../src/messaging.js";
import {
  SessionContext,
  SessionDescriptor,
  WorkerSession,
} from "../src/session.js";
import { createArtifact, type Artifact } from "../src/agents/types.js";

// ---------------------------------------------------------------------------
// Helpers — stub sessions
// ---------------------------------------------------------------------------

/** A session that resolves immediately. */
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

/** A session that takes ~50ms to resolve. */
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

/** A session that always throws. */
class FailingSession extends WorkerSession {
  get workerType(): string {
    return "generator";
  }

  async run(_message: TaskNotification): Promise<TaskNotification> {
    throw new Error("intentional failure for test");
  }
}

/** A session that blocks for a very long time (used for stuck-session tests). */
class StuckSession extends WorkerSession {
  get workerType(): string {
    return "generator";
  }

  async run(_message: TaskNotification): Promise<TaskNotification> {
    // Block for much longer than any test timeout
    await delay(300_000);
    return this._makeNotification("completed", { summary: "stuck" });
  }
}

/** A session that finishes after a delay longer than the timeout. */
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

// ---------------------------------------------------------------------------
// Helpers — factories
// ---------------------------------------------------------------------------

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
): ThreadBackend {
  if (factoryOverride !== undefined) {
    return new ThreadBackend({
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

  return new ThreadBackend({
    factory: testFactory,
    heartbeatInterval: 0,
  });
}

// ---------------------------------------------------------------------------
// ThreadBackend tests
// ---------------------------------------------------------------------------

describe("ThreadBackend", () => {
  it("should submit a fast session and poll the result", async () => {
    const backend = makeBackend();
    const session = makeSession(FastSession);
    const msg = createTaskMessage({
      type: "spawn",
      taskId: "design-1",
      sessionId: session.sessionId,
    });

    backend.submitSession(session, msg, 5.0);

    // Poll until result is ready
    let results: TaskNotification[] = [];
    for (let i = 0; i < 50; i++) {
      results = backend.poll();
      if (results.some((n) => n.status === "completed")) break;
      await delay(10);
    }

    // Filter for completed notifications (ignore started/heartbeat lifecycle events)
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

    // Wait for completion
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
});
