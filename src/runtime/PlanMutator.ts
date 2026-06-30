import type { WorkflowState } from "../state.js";
import {
  type ExecutionPlan,
  type PlanMutation,
  type Task,
  type TaskType,
  createExecutionPlan,
  createTask,
} from "../shared/types.js";

/**
 * Manages plan lifecycle: setPlan, requirement JSON, quality status,
 * and plan mutation with DAG validation.
 *
 * Extracted from WorkflowState to reduce the god-class footprint.
 */
export class PlanMutator {
  constructor(private readonly _state: WorkflowState) {}

  /**
   * Set (or replace) the execution plan.
   *
   * Initialises lifecycle task statuses for every task in the new plan
   * whose status is not already tracked, defaulting to "pending".
   */
  setPlan(plan: ExecutionPlan): void {
    this._state.plan = plan;
    for (const task of plan.tasks) {
      if (!this._state.taskStatuses[task.id]) {
        this._state.taskStatuses[task.id] = "pending";
      }
    }
  }

  /** Set the merged requirement JSON. */
  setRequirementJson(json: Record<string, unknown>): void {
    this._state.requirementJson = json;
    this._state.requirementDraftJson = {};
    this._state.requirementJsonContentKind =
      Object.keys(json).length > 0 ? "canonical" : "empty";
  }

  /** Set the final quality status. */
  setQualityStatus(status: "unknown" | "passed" | "rejected"): void {
    this._state.qualityStatus = status;
  }

  /**
   * Look up a task from the plan by its id.
   * Returns a plain-object snapshot or `null`.
   */
  getTaskById(taskId: string): {
    id: string;
    type: TaskType;
    description: string;
    dependsOn: string[];
    contextHints: Record<string, unknown>;
  } | null {
    if (!this._state.plan) return null;
    for (const t of this._state.plan.tasks) {
      if (t.id === taskId) {
        return {
          id: t.id,
          type: t.type,
          description: t.description,
          dependsOn: t.dependsOn,
          contextHints: t.contextHints,
        };
      }
    }
    return null;
  }

  /**
   * Apply a {@link PlanMutation} to the current plan.
   *
   * Validates:
   * - Task type validity
   * - Completed tasks are not dropped or illegally modified
   * - New task IDs are unique
   * - Dependency graph is a DAG (acyclic)
   * - No dangling dependencies
   *
   * @returns Array of validation error strings (empty = success).
   */
  mutatePlan(mutation: PlanMutation): string[] {
    if (this._state.plan === null) {
      return ["cannot mutate: no plan exists"];
    }

    const errors: string[] = [];

    // --- Validate: new task types must be valid ---
    // NOTE: keep in sync with the canonical `TaskType` union
    // (src/shared/types.ts). domain_model was missing, which rejected
    // domain-model recovery tasks during replan (regression: smart_campus /
    // ecommerce dead-ended after a failed domain_model self-check).
    const validTypes = new Set<string>([
      "analyze",
      "domain_model",
      "design",
      "diagrams",
      "tests",
    ]);
    for (const task of mutation.addTasks) {
      if (!validTypes.has(task.type)) {
        errors.push(`invalid task type '${task.type}' for '${task.id}'`);
      }
    }
    for (const task of mutation.updateTasks) {
      if (!validTypes.has(task.type)) {
        errors.push(`invalid task type '${task.type}' for '${task.id}'`);
      }
    }
    // --- Validate: new task IDs must be unique ---
    const existingIds = new Set(this._state.plan.tasks.map((t) => t.id));
    const requestedDropSet = new Set(mutation.dropTaskIds);
    const protectedDropSet = this._protectedDropIds(requestedDropSet);
    const effectiveDropIds = mutation.dropTaskIds.filter((id) => !protectedDropSet.has(id));
    const dropSet = new Set(effectiveDropIds);

    if (
      mutation.dropTaskIds.length > 0 &&
      effectiveDropIds.length === 0 &&
      mutation.addTasks.length === 0 &&
      mutation.updateTasks.length === 0 &&
      Object.keys(mutation.reorderEdges).length === 0
    ) {
      for (const taskId of mutation.dropTaskIds) {
        if (protectedDropSet.has(taskId)) {
          if (this._state.isTaskCompleted(taskId)) {
            errors.push(`cannot drop completed task '${taskId}'`);
          } else {
            errors.push(`cannot drop protected task '${taskId}'`);
          }
        }
      }
    }

    for (const task of mutation.addTasks) {
      if (existingIds.has(task.id) && !dropSet.has(task.id)) {
        errors.push(`new task id '${task.id}' conflicts with existing task`);
      }
    }
    // Check duplicates within addTasks itself
    const newIdSet = new Set(mutation.addTasks.map((t) => t.id));
    if (newIdSet.size !== mutation.addTasks.length) {
      errors.push("duplicate task ids in addTasks");
    }

    // --- Build the new task list ---
    if (errors.length > 0) {
      return errors;
    }

    // Start with existing tasks, applying mutations
    interface TaskInfo {
      id: string;
      type: TaskType;
      description: string;
      dependsOn: string[];
      contextHints: Record<string, unknown>;
    }

    const taskMap = new Map<string, TaskInfo>();
    for (const t of this._state.plan.tasks) {
      taskMap.set(t.id, {
        id: t.id,
        type: t.type,
        description: t.description,
        dependsOn: [...t.dependsOn],
        contextHints:
          t.contextHints && Object.keys(t.contextHints).length > 0
            ? { ...t.contextHints }
            : {},
      });
    }

    // Drop tasks
    for (const taskId of effectiveDropIds) {
      taskMap.delete(taskId);
      delete this._state.taskStatuses[taskId];
    }

    // Update tasks
    for (const task of mutation.updateTasks) {
      const info = taskMap.get(task.id);
      if (info) {
        info.description = task.description;
        info.contextHints =
          task.contextHints && Object.keys(task.contextHints).length > 0
            ? { ...task.contextHints }
            : {};
        if (!this._state.isTaskCompleted(task.id)) {
          info.dependsOn = [...task.dependsOn];
        }
      }
    }

    // Add new tasks
    for (const task of mutation.addTasks) {
      taskMap.set(task.id, {
        id: task.id,
        type: task.type,
        description: task.description,
        dependsOn: [...task.dependsOn],
        contextHints:
          task.contextHints && Object.keys(task.contextHints).length > 0
            ? { ...task.contextHints }
            : {},
      });
      // Initialize status for new tasks
      this._state.taskStatuses[task.id] = "pending";
    }

    // Reorder edges
    for (const [taskId, newDeps] of Object.entries(mutation.reorderEdges)) {
      const info = taskMap.get(taskId);
      if (info && !this._state.isTaskCompleted(taskId)) {
        info.dependsOn = [...newDeps];
      }
    }

    // Reconstruct tasks list, preserving original order for existing tasks
    const preservedOrder = this._state.plan.tasks
      .map((t) => t.id)
      .filter((id) => taskMap.has(id));
    const newTaskIds = mutation.addTasks.map((t) => t.id);
    const orderedIds = [
      ...preservedOrder,
      ...newTaskIds.filter((tid) => !preservedOrder.includes(tid)),
    ];

    const newTasks: Task[] = [];
    for (const tid of orderedIds) {
      const info = taskMap.get(tid)!;
      newTasks.push(
        createTask({
          id: info.id,
          type: info.type,
          description: info.description,
          dependsOn: info.dependsOn,
          contextHints: info.contextHints,
        }),
      );
    }

    // --- Validate: dependency acyclicity ---
    const depGraph = new Map<string, Set<string>>();
    for (const t of newTasks) {
      depGraph.set(t.id, new Set(t.dependsOn));
    }
    const cycleErrors = PlanMutator.checkDag(depGraph);
    if (cycleErrors.length > 0) {
      return cycleErrors;
    }

    // --- Validate: no dangling dependencies ---
    const allIds = new Set(newTasks.map((t) => t.id));
    for (const t of newTasks) {
      for (const dep of t.dependsOn) {
        if (!allIds.has(dep)) {
          errors.push(
            `task '${t.id}' depends on non-existent task '${dep}'`,
          );
        }
      }
    }

    if (errors.length > 0) {
      return errors;
    }

    // Apply
    this._state.plan = createExecutionPlan({
      tasks: newTasks,
      goal: this._state.plan.goal,
      reasoning: this._state.plan.reasoning
        ? `${this._state.plan.reasoning} | replan: ${mutation.reasoning}`
        : mutation.reasoning,
    });
    this._state.progress.recordPlanMutation();
    this._state.convergence.reset();
    return [];
  }

  private _protectedDropIds(requestedDropSet: Set<string>): Set<string> {
    const protectedIds = new Set<string>();
    if (!this._state.plan) return protectedIds;

    for (const taskId of requestedDropSet) {
      if (this._state.artifacts[taskId] || this._state.isTaskCompleted(taskId)) {
        protectedIds.add(taskId);
      }
    }

    for (const task of this._state.plan.tasks) {
      if (requestedDropSet.has(task.id)) continue;
      for (const dep of task.dependsOn) {
        if (requestedDropSet.has(dep)) {
          protectedIds.add(dep);
        }
      }
    }

    return protectedIds;
  }

  // ------------------------------------------------------------------
  // DAG validation (static)
  // ------------------------------------------------------------------

  /**
   * Check that the dependency graph is a DAG (no cycles).
   *
   * Uses DFS with three-color marking (WHITE / GRAY / BLACK).
   *
   * @param depGraph - Map of node → set of its dependencies.
   * @returns Array of cycle description strings (empty = valid DAG).
   */
  static checkDag(depGraph: Map<string, Set<string>>): string[] {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;

    const color = new Map<string, number>();
    for (const node of depGraph.keys()) {
      color.set(node, WHITE);
    }

    const cycles: string[] = [];

    function dfs(node: string, path: string[]): void {
      color.set(node, GRAY);
      path.push(node);

      const deps = depGraph.get(node) ?? new Set<string>();
      for (const dep of deps) {
        if (!color.has(dep)) {
          // Dependency on a node not in the graph — skip
          continue;
        }
        const depColor = color.get(dep)!;
        if (depColor === GRAY) {
          const cycleStart = path.indexOf(dep);
          const cycle = path.slice(cycleStart).concat(dep);
          cycles.push(cycle.join(" → "));
        } else if (depColor === WHITE) {
          dfs(dep, path);
        }
      }

      path.pop();
      color.set(node, BLACK);
    }

    for (const node of depGraph.keys()) {
      if (color.get(node) === WHITE) {
        dfs(node, []);
      }
    }

    return cycles.map((c) => `dependency cycle detected: ${c}`);
  }
}
