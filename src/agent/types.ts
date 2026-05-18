/**
 * Public types for the multi-agent workflow.
 *
 * Ported from reqdesign/agents/types.py (Phase 1).
 */

// ---------------------------------------------------------------------------
// Literal union types
// ---------------------------------------------------------------------------

/** Kinds of tasks the planner can emit. */
export type TaskType = "analyze" | "design" | "diagrams" | "tests";

/** Actions the coordinator agent can choose. */
export type ActionType =
  | "spawn"
  | "spawn_all_ready"
  | "repair"
  | "regenerate"
  | "stop"
  | "inspect"
  | "save"
  | "pause"
  | "finish"
  | "replan";

/** Issue severity levels used by the evaluator. */
export type Severity = "blocker" | "major" | "minor";

/** Scope classification for issues. */
export type Scope = "local" | "upstream" | "systemic" | "";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** A unit of work produced by PlanningTool. */
export interface Task {
  id: string;
  type: TaskType;
  description: string;
  dependsOn: string[];
  contextHints: Record<string, unknown>;
}

/** PlanningTool output. */
export interface ExecutionPlan {
  tasks: Task[];
  goal: string;
  reasoning: string;
}

/** A generated artifact. */
export interface Artifact {
  taskId: string;
  type: TaskType;
  revision: number;
  content: unknown;
  selfCheckPassed: boolean;
  selfCheckIssues: string[];
  selfCorrectRounds: number;
  generationDuration: number;
}

/** A structured issue found by EvaluationTool. */
export interface Issue {
  severity: Severity;
  targetTaskId: string;
  targetTaskType: string;
  targetField: string;
  description: string;
  suggestion: string;
  scope: Scope;
}

/** EvaluationTool output — issues and fixes, no scores. */
export interface Verdict {
  passed: boolean;
  issues: Issue[];
  fixes: Task[];
  summary: string;
  evaluatedTaskIds: string[];
  evaluatedRevisions: Record<string, number>;
  isFinalReview: boolean;
}

/**
 * Describes how to modify the current ExecutionPlan.
 *
 * Used by PlanningTool.replan() to incrementally adjust the task graph
 * rather than replacing it entirely.
 */
export interface PlanMutation {
  addTasks: Task[];
  updateTasks: Task[];
  dropTaskIds: string[];
  reorderEdges: Record<string, string[]>;
  reasoning: string;
}

/** Next action chosen by the coordinator agent. */
export interface RuntimeAction {
  action: ActionType;
  taskId: string;
  reason: string;
  replanContext: Record<string, unknown>;
  evaluateScope: string[];
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/** Create a {@link Task} with sensible defaults. */
export function createTask(overrides: Partial<Task> & Pick<Task, "id" | "type">): Task {
  return {
    description: "",
    dependsOn: [],
    contextHints: {},
    ...overrides,
  };
}

/** Create an {@link ExecutionPlan} with sensible defaults. */
export function createExecutionPlan(
  overrides: Partial<ExecutionPlan> & Pick<ExecutionPlan, "tasks">,
): ExecutionPlan {
  return {
    goal: "design",
    reasoning: "",
    ...overrides,
  };
}

/** Create an {@link Artifact} with sensible defaults. */
export function createArtifact(
  overrides: Partial<Artifact> & Pick<Artifact, "taskId" | "type">,
): Artifact {
  return {
    revision: 0,
    content: null,
    selfCheckPassed: true,
    selfCheckIssues: [],
    selfCorrectRounds: 0,
    generationDuration: 0.0,
    ...overrides,
  };
}

/** Create an {@link Issue} with sensible defaults. */
export function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    severity: "major",
    targetTaskId: "",
    targetTaskType: "",
    targetField: "",
    description: "",
    suggestion: "",
    scope: "",
    ...overrides,
  };
}

/** Create a {@link Verdict} with sensible defaults. */
export function createVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    passed: false,
    issues: [],
    fixes: [],
    summary: "",
    evaluatedTaskIds: [],
    evaluatedRevisions: {},
    isFinalReview: false,
    ...overrides,
  };
}

/** Create a {@link PlanMutation} with sensible defaults. */
export function createPlanMutation(overrides: Partial<PlanMutation> = {}): PlanMutation {
  return {
    addTasks: [],
    updateTasks: [],
    dropTaskIds: [],
    reorderEdges: {},
    reasoning: "",
    ...overrides,
  };
}

/** Create a {@link RuntimeAction} with sensible defaults. */
export function createRuntimeAction(
  overrides: Partial<RuntimeAction> & Pick<RuntimeAction, "action">,
): RuntimeAction {
  return {
    taskId: "",
    reason: "",
    replanContext: {},
    evaluateScope: [],
    ...overrides,
  };
}
