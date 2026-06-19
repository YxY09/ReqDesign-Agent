/**
 * Agent 间通信的消息层。
 *
 * 源自 reqdesign/messaging.py (Phase 5)。
 *
 * 提供类型化消息、通知和线程安全的邮箱。
 * 无需锁，因为 Node.js 是单线程的。
 */

import * as crypto from "node:crypto";
import type {
  Artifact,
  Verdict,
  ExecutionPlan,
  PlanMutation,
} from "./shared/types.js";

// ---------------------------------------------------------------------------
// Literal union types
// ---------------------------------------------------------------------------

/** 可在 Agent 之间发送的消息类型。 */
type MessageType = "spawn" | "repair" | "stop" | "inspect" | "replan";

/** 任务的生命周期状态。 */
export type TaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "rejected"
  | "cancelled";

/** Agent 发出的通知事件类型。 */
type NotificationEvent =
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
 * 标记通知为终结事件的事件集合——即任务在这些事件之一发生后
 * 将不会再产生任何更新。
 */
export const TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  "result",
  "timeout",
  "cancel_requested",
]);

// ---------------------------------------------------------------------------
// Union for typed result payloads
// ---------------------------------------------------------------------------

/** {@link TaskNotification} 携带的标记联合结果。 */
type NotificationResult =
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

/** 发给 Agent（或协调器）以请求工作的消息。 */
export interface TaskMessage {
  /** 消息类型的判别器。 */
  type: MessageType;
  /** 此消息所指的任务。 */
  taskId: string;
  /** 此消息所属的逻辑会话/执行运行。 */
  sessionId: string;
  /** 任意数据负载。 */
  payload: Record<string, unknown>;
  /** 用于追踪/调试的可选元数据。 */
  metadata: Record<string, unknown>;
  /** 值越高越优先送达。 */
  priority: number;
  /** 创建此消息的自由文本原因。 */
  cause: string;
  /** 生成此消息的会话（用于层级追踪）。 */
  parentSessionId: string;
  /** 类型为 `"replan"` 时提供的额外上下文。 */
  replanContext: Record<string, unknown>;
  /** 类型为 `"repair"` 时的范围描述。 */
  repairScope: string;
}

/** Agent 发出的关于其进度或结果的通知。 */
export interface TaskNotification {
  /** 此通知相关的任务。 */
  taskId: string;
  /** 此通知所属的逻辑会话。 */
  sessionId: string;
  /** 任务的当前生命周期状态。 */
  status: TaskStatus;
  /** 此通知代表的事件类型。 */
  event: NotificationEvent;
  /** 人类可读的摘要。 */
  summary: string;
  /** 结构化结果负载（Artifact、Verdict 等）或原始值。 */
  result: NotificationResult;
  /** Token/使用统计。 */
  usage: Record<string, unknown>;
  /** 如果任务失败则包含错误消息。 */
  error: string;
  /** 后续行动建议。 */
  suggestions: ReadonlyArray<Record<string, unknown>>;
  /** 用于排序的递增序列号。 */
  sequence: number;
  /** 此通知创建时的 Unix 时间戳（秒）。 */
  timestamp: number;
  /** 增量进度信息。 */
  progressDelta: Record<string, unknown>;
  /** 协调器的推荐下一步行动。 */
  recommendedAction: string;
  /** 可能指导重规划的提示字符串。 */
  replanHint: string;
  /** 此通知是否是该任务的最后一个。 */
  terminal: boolean;
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * 创建带有合理默认值的 {@link TaskMessage}。
 *
 * @param overrides - 要覆盖的字段。`taskId` 和 `type` 是必需的。
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
 * 创建带有合理默认值的 {@link TaskNotification}。
 *
 * @param overrides - 要覆盖的字段。`taskId`、`sessionId` 和 `status`
 *   是必需的。
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
 * 当通知代表终结事件时返回 `true`。
 *
 * 如果通知的 {@link TaskNotification.terminal} 标志被设置**或**
 * 其事件在 {@link TERMINAL_EVENTS} 中，则该通知为终结通知。
 */
export function isTerminal(notif: TaskNotification): boolean {
  return notif.terminal || TERMINAL_EVENTS.has(notif.event);
}

// ---------------------------------------------------------------------------
// TaskMailbox
// ---------------------------------------------------------------------------

/**
 * 进程内 Agent 间通信的消息总线。
 *
 * Agent 将消息和通知推入邮箱；协调器
 *（或其他 Agent）从中轮询。因为 Node.js 是单线程的，
 * 无需加锁。
 */
export class TaskMailbox {
  private readonly _messages: TaskMessage[] = [];
  private readonly _notifications: TaskNotification[] = [];
  private _messageCursor = 0;
  private _notificationCursor = 0;

  // ----- messages ----------------------------------------------------------

  /**
   * 将消息加入队列以便投递。
   *
   * 消息按 {@link TaskMessage.priority} 降序排序，
   * 以便高优先级项优先被消费。
   */
  sendMessage(msg: TaskMessage): void {
    this._messages.push(msg);
    this._messages.sort((a, b) => b.priority - a.priority);
  }

  /**
   * 返回并消费所有未消费的消息，可按会话过滤。
   *
   * @param sessionId - 如果提供，仅返回 `sessionId` 匹配的消息。
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
   * 如果存在匹配可选会话过滤器的未消费消息，返回 `true`。
   */
  hasMessages(sessionId?: string): boolean {
    return this.unreadMessageCount(sessionId) > 0;
  }

  /**
   * 未消费消息的数量，可按会话过滤。
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
   * 将通知加入队列。
   */
  sendNotification(notif: TaskNotification): void {
    this._notifications.push(notif);
  }

  /**
   * 返回并消费所有未消费的通知，可按任务 ID 和/或状态过滤。
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
   * 查找给定会话的**最新**通知，或返回 `null`。
   *
   * **不会**消费该通知。
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
   * 不消费地窥视最近的通知。
   */
  peekLatestNotification(): TaskNotification | null {
    return this._notifications.length > 0
      ? this._notifications[this._notifications.length - 1]
      : null;
  }

  /**
   * 不消费也不前进光标地窥视**所有**通知（包括已消费的）。
   */
  peekAllNotifications(): TaskNotification[] {
    return [...this._notifications];
  }

  /**
   * 不消费也不前进光标地窥视**所有**消息（包括已消费的）。
   */
  peekAllMessages(): TaskMessage[] {
    return [...this._messages];
  }

  // ----- cursor / reset ----------------------------------------------------

  /**
   * 重置消费光标，以便在下次轮询时再次产生之前已消费的消息和通知。
   */
  resetCursors(): void {
    this._messageCursor = 0;
    this._notificationCursor = 0;
  }

  /**
   * 删除所有消息和通知并重置光标。
   */
  clear(): void {
    this._messages.length = 0;
    this._notifications.length = 0;
    this._messageCursor = 0;
    this._notificationCursor = 0;
  }

  // ----- static helpers ----------------------------------------------------

  /**
   * 从任务 ID 生成确定性会话 ID。
   *
   * 格式：`{taskId}-{randomSuffix}`。
   */
  static generateSessionId(taskId: string): string {
    return `${taskId}-${crypto.randomUUID()}`;
  }
}
