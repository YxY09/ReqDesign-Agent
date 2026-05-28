import type { WorkflowState } from "../state.js";

/**
 * Manages task lifecycle status and notification history.
 *
 * Extracted from WorkflowState to reduce the god-class footprint.
 * All state is read/mutated through the owning WorkflowState reference.
 */
export class TaskLifecycleManager {
  constructor(private readonly _state: WorkflowState) {}

  // ------------------------------------------------------------------
  // Notification history
  // ------------------------------------------------------------------

  /** Record a notification for trace/observability. */
  recordNotification(notif: Record<string, unknown>): void {
    this._state.notifications.push(notif);
  }

  /** Record that a repair attempt was completed for a task. */
  recordRepairAttempt(taskId: string): void {
    if (!taskId) return;
    const key = `repair_count:${taskId}`;
    this._state.progress._counters[key] = (this._state.progress._counters[key] ?? 0) + 1;
  }

  /** Record that a task was regenerated from scratch. */
  recordRegenerateAttempt(taskId: string): void {
    if (!taskId) return;
    const key = `regenerate_count:${taskId}`;
    this._state.progress._counters[key] = (this._state.progress._counters[key] ?? 0) + 1;
  }

  /** Record a planner failure for orchestration budget guards. */
  recordPlannerFailure(): void {
    const key = "planner_spawn_fail";
    this._state.progress._counters[key] = (this._state.progress._counters[key] ?? 0) + 1;
  }

  // ------------------------------------------------------------------
  // Task lifecycle
  // ------------------------------------------------------------------

  /** Record the current lifecycle status for a task. */
  markTaskStatus(
    taskId: string,
    status: string,
    sessionId: string = "",
    details?: Record<string, unknown> | null,
  ): void {
    if (!taskId) return;
    this._state.taskStatuses[taskId] = status;

    // Track planner failures for budget guards
    if (taskId === "planner" && status === "failed") {
      this.recordPlannerFailure();
    }
    if (sessionId) {
      this._state.taskSessions[taskId] = sessionId;
    }
    const entry: Record<string, unknown> = {
      taskId,
      status,
      timestamp: Date.now() / 1000,
    };
    if (sessionId) {
      entry["sessionId"] = sessionId;
    }
    if (details) {
      entry["details"] = details;
    }
    this._state.taskHistory.push(entry);
  }

  /** Get the lifecycle status of a task (defaults to `"pending"`). */
  taskStatus(taskId: string): string {
    return this._state.taskStatuses[taskId] ?? "pending";
  }

  /** Whether a task is completed. */
  isTaskCompleted(taskId: string): boolean {
    return this.taskStatus(taskId) === "completed";
  }

  /** Whether a task is running. */
  isTaskRunning(taskId: string): boolean {
    return this.taskStatus(taskId) === "running";
  }

  /** Sorted list of completed task IDs. */
  getCompletedTaskIds(): string[] {
    return Object.entries(this._state.taskStatuses)
      .filter(([, status]) => status === "completed")
      .map(([taskId]) => taskId)
      .sort();
  }

  /** Sorted list of running task IDs. */
  getRunningTaskIds(): string[] {
    return Object.entries(this._state.taskStatuses)
      .filter(([, status]) => status === "running")
      .map(([taskId]) => taskId)
      .sort();
  }

  /** Sorted list of failed task IDs. */
  getFailedTaskIds(): string[] {
    return Object.entries(this._state.taskStatuses)
      .filter(([, status]) => status === "failed")
      .map(([taskId]) => taskId)
      .sort();
  }

  /** All task IDs from the current plan. */
  getPlanTaskIds(): string[] {
    if (!this._state.plan) return [];
    return this._state.plan.tasks.map((t) => t.id);
  }

  /** Task IDs from the plan that are completed. */
  getCompletedPlanTaskIds(): string[] {
    const planTaskIds = new Set(this.getPlanTaskIds());
    return Object.entries(this._state.taskStatuses)
      .filter(([taskId, status]) => planTaskIds.has(taskId) && status === "completed")
      .map(([taskId]) => taskId)
      .sort();
  }

  /**
   * Plan tasks whose dependencies are complete and that are not already
   * running, completed, rejected, cancelled, or failed.
   */
  getReadyTaskIds(): string[] {
    if (!this._state.plan) return [];
    const ready: string[] = [];
    const terminalStatuses = new Set([
      "running",
      "completed",
      "rejected",
      "cancelled",
      "failed",
    ]);
    for (const task of this._state.plan.tasks) {
      const status = this.taskStatus(task.id);
      if (terminalStatuses.has(status)) continue;
      if (task.dependsOn.every((dep) => this.isTaskCompleted(dep))) {
        ready.push(task.id);
      }
    }
    return ready;
  }

  /** Plan tasks that have not started yet (status is `"pending"`). */
  getPendingTaskIds(): string[] {
    if (!this._state.plan) return [];
    return this._state.plan.tasks
      .filter((t) => this.taskStatus(t.id) === "pending")
      .map((t) => t.id);
  }

  /** Plan tasks that are waiting on unfinished dependencies. */
  getBlockedTaskIds(): string[] {
    if (!this._state.plan) return [];
    const readySet = new Set(this.getReadyTaskIds());
    const blocked: string[] = [];
    for (const task of this._state.plan.tasks) {
      if (readySet.has(task.id)) continue;
      if (this.taskStatus(task.id) === "pending" && task.dependsOn.length > 0) {
        blocked.push(task.id);
      }
    }
    return blocked;
  }
}
