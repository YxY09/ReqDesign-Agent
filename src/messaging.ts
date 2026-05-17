/**
 * Messaging layer for inter-agent communication.
 *
 * Ported from reqdesign/messaging.py (Phase 5).
 *
 * Provides typed messages, notifications, and a thread-safe(ish) mailbox.
 * No locks are needed because Node.js is single-threaded.
 */

import * as crypto from "node:crypto";
import type {
  Artifact,
  Verdict,
  ExecutionPlan,
  PlanMutation,
} from "./agent/types.js";

// ---------------------------------------------------------------------------
// Literal union types
// ---------------------------------------------------------------------------

/** Kinds of messages that can be sent between agents. */
export type MessageType = "spawn" | "repair" | "stop" | "inspect" | "replan";

/** Lifecycle status of a task. */
export type TaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "rejected"
  | "cancelled";

/** Notification event kinds emitted by agents. */
export type NotificationEvent =
  | "started"
  | "heartbeat"
  | "resumed"
  | "inspect"
  | "cancel_requested"
  | "timeout"
  | "result";

// ---------------------------------------------------------------------------
// Terminal events (module-level constant)
// ---------------------------------------------------------------------------

/**
 * Set of events that mark a notification as terminal — i.e. the task will
 * not produce any further updates after one of these.
 */
export const TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  "result",
  "timeout",
  "cancel_requested",
]);

// ---------------------------------------------------------------------------
// Union for typed result payloads
// ---------------------------------------------------------------------------

/** Tagged union result carried by a {@link TaskNotification}. */
export type NotificationResult =
  | Artifact
  | Verdict
  | ExecutionPlan
  | PlanMutation
  | string
  | number
  | boolean
  | null;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** A message sent *to* an agent (or the coordinator) to request work. */
export interface TaskMessage {
  /** Discriminator for the message kind. */
  type: MessageType;
  /** The task this message refers to. */
  taskId: string;
  /** Logical session / execution run this message belongs to. */
  sessionId: string;
  /** Arbitrary data payload. */
  payload: Record<string, unknown>;
  /** Optional metadata for tracing / debugging. */
  metadata: Record<string, unknown>;
  /** Higher values are delivered first. */
  priority: number;
  /** Free-text reason this message was created. */
  cause: string;
  /** Session that spawned this message (for hierarchical tracking). */
  parentSessionId: string;
  /** Extra context supplied when type is `"replan"`. */
  replanContext: Record<string, unknown>;
  /** Scope description when type is `"repair"`. */
  repairScope: string;
}

/** A notification emitted *by* an agent about its progress or result. */
export interface TaskNotification {
  /** The task this notification is about. */
  taskId: string;
  /** Logical session this notification belongs to. */
  sessionId: string;
  /** Current lifecycle status of the task. */
  status: TaskStatus;
  /** What kind of event this notification represents. */
  event: NotificationEvent;
  /** Human-readable summary. */
  summary: string;
  /** Structured result payload (Artifact, Verdict, etc.) or a primitive. */
  result: NotificationResult;
  /** Token / usage statistics. */
  usage: Record<string, unknown>;
  /** Error message, if the task failed. */
  error: string;
  /** Suggestions for follow-up actions. */
  suggestions: ReadonlyArray<Record<string, unknown>>;
  /** Monotonically increasing sequence number for ordering. */
  sequence: number;
  /** Epoch seconds when this notification was created. */
  timestamp: number;
  /** Incremental progress information. */
  progressDelta: Record<string, unknown>;
  /** Recommended next action for the coordinator. */
  recommendedAction: string;
  /** Hint string that may guide replanning. */
  replanHint: string;
  /** Whether this notification is the last one for this task. */
  terminal: boolean;
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Create a {@link TaskMessage} with sensible defaults.
 *
 * @param overrides - Fields to override. `taskId` and `type` are required.
 */
export function createTaskMessage(
  overrides: Partial<TaskMessage> & Pick<TaskMessage, "taskId" | "type">,
): TaskMessage {
  return {
    sessionId: "",
    payload: {},
    metadata: {},
    priority: 0,
    cause: "",
    parentSessionId: "",
    replanContext: {},
    repairScope: "",
    ...overrides,
  };
}

/**
 * Create a {@link TaskNotification} with sensible defaults.
 *
 * @param overrides - Fields to override. `taskId`, `sessionId`, and `status`
 *   are required.
 */
export function createTaskNotification(
  overrides: Partial<TaskNotification> &
    Pick<TaskNotification, "taskId" | "sessionId" | "status">,
): TaskNotification {
  return {
    event: "result",
    summary: "",
    result: null,
    usage: {},
    error: "",
    suggestions: [],
    sequence: 0,
    timestamp: Date.now() / 1000,
    progressDelta: {},
    recommendedAction: "",
    replanHint: "",
    terminal: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Notification helpers
// ---------------------------------------------------------------------------

/**
 * Return `true` when the notification represents a terminal event.
 *
 * A notification is terminal if its {@link TaskNotification.terminal} flag is
 * set **or** its event is in {@link TERMINAL_EVENTS}.
 */
export function isTerminal(notif: TaskNotification): boolean {
  return notif.terminal || TERMINAL_EVENTS.has(notif.event);
}

// ---------------------------------------------------------------------------
// Serialization helpers — tagged type pattern
// ---------------------------------------------------------------------------

/**
 * Shape used when serializing a {@link TaskNotification.result} value so that
 * downstream consumers can reconstruct the original domain type.
 */
export interface SerializedResult {
  /** Discriminator tag identifying the domain type. */
  __type__: "artifact" | "verdict" | "execution_plan" | "plan_mutation" | "primitive";
  /** The actual data. */
  __data__: unknown;
}

/**
 * Tag a notification result for JSON-safe serialization.
 *
 * Primitive values and `null` are wrapped as `"primitive"`. Domain objects
 * are tagged according to their structural role.
 */
function serializeResult(result: NotificationResult): SerializedResult {
  if (result === null || typeof result === "string" || typeof result === "number" || typeof result === "boolean") {
    return { __type__: "primitive", __data__: result };
  }

  // Discriminate domain types by duck-typing. Order matters: more specific
  // checks should come before broader ones.
  const obj = result as unknown as Record<string, unknown>;

  if (obj.dropTaskIds !== undefined) {
    return { __type__: "plan_mutation", __data__: result };
  }
  if (obj.tasks !== undefined && obj.goal !== undefined) {
    return { __type__: "execution_plan", __data__: result };
  }
  if (obj.passed !== undefined && obj.issues !== undefined) {
    return { __type__: "verdict", __data__: result };
  }
  if (obj.taskId !== undefined && obj.revision !== undefined && obj.selfCheckPassed !== undefined) {
    return { __type__: "artifact", __data__: result };
  }

  // Fallback — treat as a generic primitive container
  return { __type__: "primitive", __data__: result };
}

/**
 * Reconstruct a notification result from its serialized tagged form.
 *
 * Returns the value as-is for `"primitive"` tags; otherwise returns the
 * `__data__` payload (consumers can cast to the appropriate domain type).
 */
function deserializeResult(tagged: SerializedResult): NotificationResult {
  if (tagged.__type__ === "primitive") {
    return tagged.__data__ as NotificationResult;
  }
  return tagged.__data__ as NotificationResult;
}

/**
 * Serialize a {@link TaskNotification} to a JSON-safe plain object.
 */
export function serializeNotification(notif: TaskNotification): Record<string, unknown> {
  return {
    ...notif,
    result: serializeResult(notif.result),
  };
}

/**
 * Deserialize a plain object back into a {@link TaskNotification}.
 */
export function deserializeNotification(
  data: Record<string, unknown>,
): TaskNotification {
  const { result: rawResult, ...rest } = data;
  const result: NotificationResult =
    rawResult !== undefined && rawResult !== null && typeof rawResult === "object" && "__type__" in (rawResult as SerializedResult)
      ? deserializeResult(rawResult as SerializedResult)
      : null;

  return {
    taskId: rest.taskId as string,
    sessionId: rest.sessionId as string,
    status: rest.status as TaskStatus,
    event: (rest.event as NotificationEvent) ?? "result",
    summary: (rest.summary as string) ?? "",
    result,
    usage: (rest.usage as Record<string, unknown>) ?? {},
    error: (rest.error as string) ?? "",
    suggestions: (rest.suggestions as ReadonlyArray<Record<string, unknown>>) ?? [],
    sequence: (rest.sequence as number) ?? 0,
    timestamp: (rest.timestamp as number) ?? Date.now() / 1000,
    progressDelta: (rest.progressDelta as Record<string, unknown>) ?? {},
    recommendedAction: (rest.recommendedAction as string) ?? "",
    replanHint: (rest.replanHint as string) ?? "",
    terminal: (rest.terminal as boolean) ?? false,
  };
}

/**
 * Serialize a {@link TaskMessage} to a JSON-safe plain object.
 */
export function serializeMessage(msg: TaskMessage): Record<string, unknown> {
  return { ...msg };
}

/**
 * Deserialize a plain object back into a {@link TaskMessage}.
 */
export function deserializeMessage(data: Record<string, unknown>): TaskMessage {
  return {
    type: data.type as MessageType,
    taskId: data.taskId as string,
    sessionId: (data.sessionId as string) ?? "",
    payload: (data.payload as Record<string, unknown>) ?? {},
    metadata: (data.metadata as Record<string, unknown>) ?? {},
    priority: (data.priority as number) ?? 0,
    cause: (data.cause as string) ?? "",
    parentSessionId: (data.parentSessionId as string) ?? "",
    replanContext: (data.replanContext as Record<string, unknown>) ?? {},
    repairScope: (data.repairScope as string) ?? "",
  };
}

// ---------------------------------------------------------------------------
// TaskMailbox
// ---------------------------------------------------------------------------

/**
 * In-process message bus for inter-agent communication.
 *
 * Agents push messages and notifications into the mailbox; the coordinator
 * (or other agents) poll for them. Because Node.js is single-threaded no
 * locking is required.
 */
export class TaskMailbox {
  private readonly _messages: TaskMessage[] = [];
  private readonly _notifications: TaskNotification[] = [];
  private _messageCursor = 0;
  private _notificationCursor = 0;

  // ----- messages ----------------------------------------------------------

  /**
   * Enqueue a message for delivery.
   *
   * Messages are sorted by descending {@link TaskMessage.priority} so that
   * higher-priority items are consumed first.
   */
  sendMessage(msg: TaskMessage): void {
    this._messages.push(msg);
    this._messages.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Return and consume all unconsumed messages, optionally filtered by
   * session.
   *
   * @param sessionId - If provided, only messages whose `sessionId` matches
   *   are returned.
   */
  pollMessages(sessionId?: string): TaskMessage[] {
    const pending = this._messages.slice(this._messageCursor);
    this._messageCursor = this._messages.length;

    if (sessionId !== undefined) {
      return pending.filter((m) => m.sessionId === sessionId);
    }
    return pending;
  }

  /**
   * Return `true` if there are unconsumed messages matching the optional
   * session filter.
   */
  hasMessages(sessionId?: string): boolean {
    return this.unreadMessageCount(sessionId) > 0;
  }

  /**
   * Count of unconsumed messages, optionally filtered by session.
   */
  unreadMessageCount(sessionId?: string): number {
    const pending = this._messages.slice(this._messageCursor);
    if (sessionId !== undefined) {
      return pending.filter((m) => m.sessionId === sessionId).length;
    }
    return pending.length;
  }

  // ----- notifications -----------------------------------------------------

  /**
   * Enqueue a notification.
   */
  sendNotification(notif: TaskNotification): void {
    this._notifications.push(notif);
  }

  /**
   * Return and consume all unconsumed notifications, optionally filtered by
   * task id and/or status.
   */
  pollNotifications(
    taskId?: string,
    status?: TaskStatus,
  ): TaskNotification[] {
    const pending = this._notifications.slice(this._notificationCursor);
    this._notificationCursor = this._notifications.length;

    return pending.filter((n) => {
      if (taskId !== undefined && n.taskId !== taskId) return false;
      if (status !== undefined && n.status !== status) return false;
      return true;
    });
  }

  /**
   * Return `true` if there are unconsumed notifications matching the
   * optional filters.
   */
  hasNotifications(taskId?: string, status?: TaskStatus): boolean {
    const pending = this._notifications.slice(this._notificationCursor);
    return pending.some((n) => {
      if (taskId !== undefined && n.taskId !== taskId) return false;
      if (status !== undefined && n.status !== status) return false;
      return true;
    });
  }

  /**
   * Find the **latest** notification for a given session, or `null`.
   *
   * Does **not** consume the notification.
   */
  getNotificationBySession(sessionId: string): TaskNotification | null {
    for (let i = this._notifications.length - 1; i >= 0; i--) {
      if (this._notifications[i].sessionId === sessionId) {
        return this._notifications[i];
      }
    }
    return null;
  }

  /**
   * Peek at the most recent notification without consuming it.
   */
  peekLatestNotification(): TaskNotification | null {
    return this._notifications.length > 0
      ? this._notifications[this._notifications.length - 1]
      : null;
  }

  /**
   * Peek at **all** notifications (including already consumed ones) without
   * advancing any cursor.
   */
  peekAllNotifications(): TaskNotification[] {
    return [...this._notifications];
  }

  /**
   * Peek at **all** messages (including already consumed ones) without
   * advancing any cursor.
   */
  peekAllMessages(): TaskMessage[] {
    return [...this._messages];
  }

  // ----- cursor / reset ----------------------------------------------------

  /**
   * Reset consumption cursors so that previously-consumed messages and
   * notifications will be yielded again on the next poll.
   */
  resetCursors(): void {
    this._messageCursor = 0;
    this._notificationCursor = 0;
  }

  /**
   * Remove all messages and notifications and reset cursors.
   */
  clear(): void {
    this._messages.length = 0;
    this._notifications.length = 0;
    this._messageCursor = 0;
    this._notificationCursor = 0;
  }

  // ----- static helpers ----------------------------------------------------

  /**
   * Generate a deterministic session id from a task id.
   *
   * Format: `{taskId}-{randomSuffix}`.
   */
  static generateSessionId(taskId: string): string {
    return `${taskId}-${crypto.randomUUID()}`;
  }
}
