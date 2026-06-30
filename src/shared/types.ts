/**
 * Public types for the multi-agent workflow.
 *
 * Ported from reqdesign/agents/types.py (Phase 1).
 */

import type { ConstraintCandidate } from "./constraintCanonicalizer.js";

// ---------------------------------------------------------------------------
// Literal union types
// ---------------------------------------------------------------------------

/** Kinds of worker agents in the multi-agent system. */
export type WorkerKind = "planner" | "generator" | "evaluator" | "repair";

/** Kinds of tasks the planner can emit. */
export type TaskType = "analyze" | "domain_model" | "design" | "diagrams" | "tests";

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
type Severity = "blocker" | "major" | "minor";

/**
 * Whether an issue is a verifiable defect (the artifact is WRONG — hallucinated
 * IDs, broken syntax, contradictions) or an advisory (completeness/quality
 * opinion). Only defects drive control flow (repair / accept / escalate);
 * advisories are recorded into known-limitations and never gate or trigger
 * repair. This is derived deterministically, NOT taken from the LLM's severity
 * label, so the pipeline is robust to weak evaluator models.
 */
export type IssueKind = "defect" | "advisory";

/** Scope classification for issues. */
export type Scope = "local" | "upstream" | "systemic" | "";

// ---------------------------------------------------------------------------
// Registry types
// ---------------------------------------------------------------------------

/** A core entity in the global entity registry. */
interface RegistryEntity {
  id: string;            // "E_CASE"
  canonicalName: string; // "Case"
  displayName: string;   // "案件"
  aliases: string[];     // ["Case", "案件", "Police Case", "Case Record"]
}

/** An actor in the global entity registry. */
interface RegistryActor {
  id: string;            // "A_ADMIN"
  canonicalName: string; // "Admin"
  displayName: string;   // "管理员"
  aliases: string[];     // ["Admin", "AdminUser", "Administrator", "管理员", "SuperUser"]
}

/** A function in the global entity registry. */
interface RegistryFunction {
  id: string;         // "FUN_REGISTER_CASE"
  name: string;       // "RegisterCase"
  aliases: string[];  // ["注册案件", "initiate case"]
}

/** Global entity registry — maps all known entities, actors, and functions. */
export interface EntityRegistry {
  entities: RegistryEntity[];
  actors?: RegistryActor[];
  functions?: RegistryFunction[];
}

// ---------------------------------------------------------------------------
// Runtime-internal types
// ---------------------------------------------------------------------------

/** Tracks an in-flight worker session for event streaming context resolution. */
export interface InflightWorker {
  sessionId: string;
  workerType: WorkerKind;
  taskId: string;
  messageType: "spawn" | "repair" | "replan";
  evaluateScope: string[];
  decision?: RuntimeAction;
}

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

  /** If true, this task should only generate/patch specific sections, not full artifact. */
  targeted?: boolean;
  /** Evaluator issues that triggered this task (for context in targeted generation). */
  targetIssues?: Issue[];
  /** When targeted, describes where to patch the result. */
  patchContext?: {
    targetArtifactId: string;
    targetSections?: string[];
  };

  /** Analysis mode for analyze tasks. */
  analysisMode?: "domain";
}

/** PlanningTool output. */
export interface ExecutionPlan {
  tasks: Task[];
  goal: string;
  reasoning: string;
  /** Global entity registry extracted during planning. */
  registry?: EntityRegistry;
  /**
   * Authoritative pre-extracted constraint registry (planner order; index i →
   * ref C{i+1}). Threaded to the analyze merge so dropped constraints can be
   * detected (and, later, re-added). See constraintReconcile.ts.
   */
  constraintRegistry?: ConstraintCandidate[];
}

/** A generated artifact. */
export interface Artifact {
  taskId: string;
  type: TaskType;
  revision: number;
  content: unknown;
  selfCheckPassed: boolean;
  selfCheckIssues: string[];
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
  /**
   * Defect vs advisory. Drives control flow: only `defect` issues trigger
   * repair / block acceptance / count as "no progress". Defaults to `defect`
   * so an unclassified issue stays conservatively in the loop; the evaluator
   * downgrades completeness/coverage opinions to `advisory`.
   */
  kind: IssueKind;
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
    targeted: false,
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
    kind: "defect",
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

// ---------------------------------------------------------------------------
// DesignModel — structured design artifact (Phase A)
// ---------------------------------------------------------------------------

interface DesignModuleEntry {
  id: string;
  name: string;
  responsibility: string;
  functionIds: string[];
}

interface DesignClassEntry {
  name: string;
  kind: "domain" | "helper";
  responsibility: string;
  attributes?: Array<{ name: string; type: string; description?: string }>;
  methods?: string[];
  entityRef?: string;
}

interface DesignDataFlow {
  name: string;
  steps: string[];
  relatedFunctionIds: string[];
}

export interface DesignCoverageEntry {
  refId: string;
  refKind: "function" | "constraint" | "exception";
  originalDescription: string;
  designDecision: string;
  affectedModuleIds: string[];
  affectedClassNames: string[];
  testImplication: string;
}

interface DesignSupplementaryClass {
  name: string;
  justification: string;
}

/**
 * First-class implementation block for ONE constraint. The verbatim source
 * span plus the explicit `parametersPreserved` list make this the deterministic
 * anchor that downstream stages (tests, judge) read from. Skip the contract-
 * style "designDecision" one-liner: that compression is what made the design
 * lose "256-bit key" / "10 seconds" in earlier runs.
 */
export interface DesignConstraintImplementation {
  /** Constraint displayId (e.g. C001), used to cross-ref with analysis. */
  constraintId: string;
  /**
   * The constraint's source_text copied verbatim. Optional now — the design
   * no longer emits it to save output tokens (the judge reads source_text
   * from analysis.json, and the self-check falls back to analysisSourceText).
   */
  sourceTextVerbatim?: string;
  /** How the constraint is realized (algorithm/mechanism/data path). */
  implementationMechanism: string;
  /**
   * Every numeric/unit/algorithm parameter from sourceTextVerbatim that MUST
   * appear in implementationMechanism+handling. The design checker enforces
   * presence verbatim and flags gaps when one is missing.
   */
  parametersPreserved: string[];
  /** When/under what condition the rule fires (empty string if N/A). */
  trigger: string;
  /** Concrete observable behavior when the rule fires. */
  handling: string;
  /** Modules/classes that realize this constraint (cross-ref only). */
  affectedModuleIds: string[];
  affectedClassNames: string[];
}

/**
 * First-class implementation block for ONE exception. Same shape as the
 * constraint block but explicitly carries trigger+handling (which is what an
 * exception fundamentally is). `parametersPreserved` is still required even
 * when usually empty, so the schema check is uniform.
 */
export interface DesignExceptionImplementation {
  /** Exception displayId (e.g. X001). */
  exceptionId: string;
  /**
   * Source text describing the failure scenario, verbatim. Optional now —
   * omitted from the design output to save tokens.
   */
  sourceTextVerbatim?: string;
  /** What triggers this exception in the implementation. */
  trigger: string;
  /** Concrete handling/recovery behavior. */
  handling: string;
  /** Numeric / verbatim anchors that must be preserved (often empty). */
  parametersPreserved: string[];
  affectedModuleIds: string[];
  affectedClassNames: string[];
}

export interface DesignModel {
  modules: DesignModuleEntry[];
  classes: DesignClassEntry[];
  dataFlows: DesignDataFlow[];
  /**
   * First-class implementation blocks per constraint. The design judge reads
   * these for verbatim parameter retention; coverageMatrix is a secondary
   * cross-reference index that may compress for brevity.
   */
  constraintImplementations: DesignConstraintImplementation[];
  /** First-class implementation blocks per exception (same role as above). */
  exceptionImplementations: DesignExceptionImplementation[];
  coverageMatrix: DesignCoverageEntry[];
  supplementaryClasses?: DesignSupplementaryClass[];
}

/** Type guard: returns true if value has all required DesignModel array fields. */
export function isDesignModel(content: unknown): content is DesignModel {
  if (!content || typeof content !== "object" || Array.isArray(content)) return false;
  const c = content as Record<string, unknown>;
  return Array.isArray(c.modules) && Array.isArray(c.classes) &&
    Array.isArray(c.dataFlows) && Array.isArray(c.coverageMatrix) &&
    // The two new first-class arrays are required; older models that lack them
    // are normalized to [] in SystemDesigner.parseDesignModel before this gate
    // is reached, so failing here means a truly malformed input.
    Array.isArray(c.constraintImplementations) && Array.isArray(c.exceptionImplementations);
}
