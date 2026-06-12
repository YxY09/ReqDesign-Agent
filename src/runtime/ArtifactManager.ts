import type { WorkflowState } from "../state.js";
import type { Artifact } from "../shared/types.js";
import { RequirementNormalizer } from "../shared/normalizer.js";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Task-type → aggregate-field mapping
// ---------------------------------------------------------------------------

const TASK_TYPE_TO_ARTIFACT_KEY: Record<string, string> = {
  analyze: "requirement_json",
  design: "design_text",
  diagrams: "diagrams",
  tests: "test_cases",
};

/**
 * Manages artifact CRUD, aggregate field synchronization, and artifact
 * snapshots for persistence.
 *
 * Extracted from WorkflowState to reduce the god-class footprint.
 */
export class ArtifactManager {
  constructor(
    private readonly _state: WorkflowState,
    private readonly _clearMajorPending: () => void,
  ) {}

  // ------------------------------------------------------------------
  // Artifact management
  // ------------------------------------------------------------------

  /** Add an artifact, sync aggregate fields, and track progress. */
  addArtifact(artifact: Artifact): void {
    const revision = (this._state.artifactRevisionsByTask[artifact.taskId] ?? 0) + 1;
    artifact.revision = revision;
    this._state.artifactRevisionsByTask[artifact.taskId] = revision;
    this._state.artifacts[artifact.taskId] = artifact;
    this._state.latestArtifactTaskByType[artifact.type] = artifact.taskId;
    this._syncAggregate(artifact);
    // Clear all major pending — artifacts changed, need fresh evaluation
    this._clearMajorPending();
    // Note: do NOT reset finalReviewDone here — repair adds artifacts which
    // is part of the review-repair cycle. Only clearReviewContext resets it.
    this._state.qualityStatus = "unknown";
    // Track progress: compare with previous content
    this._state.progress.recordArtifact(artifact.taskId, artifact.content);
    this._state._lastArtifactContents[artifact.taskId] = artifact.content;
  }

  /**
   * Sync aggregate fields from an artifact.
   *
   * For analyze type: rebuilds the aggregate from all current analyze artifacts.
   * This preserves multi-analyze intermediate state and avoids stale data when
   * an analyze task is regenerated.
   *
   * For other types: keeps the latest task output as the aggregate field.
   */
  private _syncAggregate(artifact: Artifact): void {
    const key = TASK_TYPE_TO_ARTIFACT_KEY[artifact.type] ?? "";
    const content = artifact.content;

    if (!key || content === null || content === undefined) return;

    if (key === "requirement_json" && typeof content === "object" && !Array.isArray(content)) {
      const raw = this._rebuildRequirementAggregate();
      const normalized = RequirementNormalizer.normalize(raw);
      this._state.requirementDraftJson = normalized;
      if (this._shouldPublishAnalyzeAggregate()) {
        this._state.requirementJson = normalized;
        this._state.requirementJsonContentKind =
          Object.keys(normalized).length > 0 ? "canonical" : "empty";
      } else if (Object.keys(this._state.requirementJson).length === 0) {
        this._state.requirementJsonContentKind = "empty";
      } else {
        this._state.requirementJsonContentKind = "stale";
      }
    } else if (key === "design_text" && typeof content === "string") {
      if (content) {
        this._state.designText = content;
      }
    } else if (key === "diagrams" && typeof content === "object" && !Array.isArray(content)) {
      const diagrams = ArtifactManager._diagramContent(content);
      const existing: Record<string, unknown> = this._state.diagrams ?? {};
      for (const [diagramKey, diagramValue] of Object.entries(diagrams)) {
        existing[diagramKey] = diagramValue;
        this._state.diagramSourcesByKey[diagramKey] = artifact.taskId;
      }
      this._state.diagrams = existing;
    } else if (key === "test_cases" && typeof content === "string") {
      if (content) {
        this._state.testCases = content;
      }
    }
  }

  private _shouldPublishAnalyzeAggregate(): boolean {
    const analyzeTasks = this._state.plan?.tasks.filter((task) => task.type === "analyze") ?? [];
    if (analyzeTasks.length <= 1) return true;
    return analyzeTasks.every((task) => this._state.taskStatuses[task.id] === "completed");
  }

  private _rebuildRequirementAggregate(): Record<string, unknown> {
    const aggregate: Record<string, unknown> = {};

    for (const artifact of Object.values(this._state.artifacts)) {
      if (artifact.type !== "analyze") continue;
      if (!artifact.content || typeof artifact.content !== "object" || Array.isArray(artifact.content)) {
        continue;
      }
      this._mergeRequirementValue(aggregate, artifact.content as Record<string, unknown>);
    }

    return aggregate;
  }

  private _mergeRequirementValue(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
  ): void {
    for (const [field, value] of Object.entries(source)) {
      const existing = target[field];
      if (Array.isArray(existing) && Array.isArray(value)) {
        target[field] = this._mergeRequirementArrays(existing, value);
      } else if (this._isPlainObject(existing) && this._isPlainObject(value)) {
        const nestedTarget = { ...(existing as Record<string, unknown>) };
        this._mergeRequirementValue(nestedTarget, value as Record<string, unknown>);
        target[field] = nestedTarget;
      } else if (Array.isArray(value)) {
        target[field] = this._mergeRequirementArrays([], value);
      } else if (this._isPlainObject(value)) {
        const nestedTarget: Record<string, unknown> = {};
        this._mergeRequirementValue(nestedTarget, value as Record<string, unknown>);
        target[field] = nestedTarget;
      } else {
        target[field] = value;
      }
    }
  }

  private _mergeRequirementArrays(left: unknown[], right: unknown[]): unknown[] {
    const seen = new Set<string>();
    const merged: unknown[] = [];

    for (const item of [...left, ...right]) {
      const key = this._stableRequirementKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }

    return merged;
  }

  private _stableRequirementKey(value: unknown): string {
    if (Array.isArray(value)) {
      return JSON.stringify(value.map((item) => this._stableRequirementKey(item)));
    }
    if (this._isPlainObject(value)) {
      const entries = Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, this._stableRequirementKey(item)]);
      return JSON.stringify(entries);
    }
    return JSON.stringify(value);
  }

  private _isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private static _diagramContent(content: unknown): Record<string, unknown> {
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      return {};
    }
    const record = content as Record<string, unknown>;
    const nested = record.diagrams;
    const source = nested && typeof nested === "object" && !Array.isArray(nested)
      ? nested as Record<string, unknown>
      : record;
    const diagrams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      if (["class_diagram", "activity_diagram", "state_diagram"].includes(key)) {
        diagrams[key] = value;
      }
    }
    if (Object.keys(diagrams).length > 0) return diagrams;
    return source === record ? record : {};
  }

  // ------------------------------------------------------------------
  // Derived properties
  // ------------------------------------------------------------------

  /** Total number of artifacts stored. */
  get totalArtifacts(): number {
    return Object.keys(this._state.artifacts).length;
  }

  /** Summary dict of all artifacts (type, revision, self-check, size). */
  artifactSummary(): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const [taskId, a] of Object.entries(this._state.artifacts)) {
      result[taskId] = {
        type: a.type,
        revision: a.revision,
        selfCheckPassed: a.selfCheckPassed,
        selfCorrectRounds: a.selfCorrectRounds,
        size: a.content !== null && a.content !== undefined ? String(a.content).length : 0,
      };
    }
    return result;
  }

  /**
   * Snapshot dict of artifacts for the given task IDs (or all if omitted).
   * Only includes tasks that have an artifact.
   */
  artifactSnapshots(
    taskIds?: string[],
  ): Record<string, Record<string, unknown>> {
    const ids = taskIds ?? Object.keys(this._state.artifacts);
    const snapshots: Record<string, Record<string, unknown>> = {};
    for (const taskId of ids) {
      const artifact = this._state.artifacts[taskId];
      if (artifact === undefined) continue;
      snapshots[taskId] = {
        taskId: artifact.taskId,
        type: artifact.type,
        revision: artifact.revision,
        content: artifact.content,
        selfCheckPassed: artifact.selfCheckPassed,
        selfCheckIssues: [...artifact.selfCheckIssues],
        contentKind: "raw",
        sourceTaskIds: [artifact.taskId],
        sourceRevisions: { [artifact.taskId]: artifact.revision },
      };
    }
    return snapshots;
  }

  /** Snapshot of the effective final outputs, not every historical task artifact. */
  finalArtifactSnapshots(): Record<string, Record<string, unknown>> {
    const snapshots: Record<string, Record<string, unknown>> = {};

    if (this._state.requirementJson && Object.keys(this._state.requirementJson).length > 0) {
      snapshots["analyze-final"] = {
        taskId: "analyze-final",
        type: "analyze",
        revision: this._contentRevision(this._state.requirementJson),
        content: this._state.requirementJson,
        selfCheckPassed: true,
        selfCheckIssues: [],
        contentKind: "canonical",
        sourceTaskIds: Object.keys(this._sourceRevisionsForType("analyze")).sort(),
        sourceRevisions: this._sourceRevisionsForType("analyze"),
      };
    }

    const latestDesign = this._latestArtifactOfType("design");
    if (latestDesign) {
      snapshots[latestDesign.taskId] = {
        taskId: latestDesign.taskId,
        type: latestDesign.type,
        revision: latestDesign.revision,
        content: latestDesign.content,
        selfCheckPassed: latestDesign.selfCheckPassed,
        selfCheckIssues: [...latestDesign.selfCheckIssues],
        contentKind: "effective",
        sourceTaskIds: [latestDesign.taskId],
        sourceRevisions: { [latestDesign.taskId]: latestDesign.revision },
      };
    }

    if (this._state.diagrams && Object.keys(this._state.diagrams).length > 0) {
      snapshots["diagrams-final"] = {
        taskId: "diagrams-final",
        type: "diagrams",
        revision: this._contentRevision(this._state.diagrams),
        content: this._state.diagrams,
        selfCheckPassed: true,
        selfCheckIssues: [],
        contentKind: "canonical",
        sourceTaskIds: [...new Set(Object.values(this._state.diagramSourcesByKey))].sort(),
        sourceRevisions: this._sourceRevisionsForTaskIds(
          [...new Set(Object.values(this._state.diagramSourcesByKey))],
        ),
      };
    }

    const latestTests = this._latestArtifactOfType("tests");
    if (latestTests) {
      snapshots[latestTests.taskId] = {
        taskId: latestTests.taskId,
        type: latestTests.type,
        revision: latestTests.revision,
        content: latestTests.content,
        selfCheckPassed: latestTests.selfCheckPassed,
        selfCheckIssues: [...latestTests.selfCheckIssues],
        contentKind: "effective",
        sourceTaskIds: [latestTests.taskId],
        sourceRevisions: { [latestTests.taskId]: latestTests.revision },
      };
    }

    return snapshots;
  }

  private _latestArtifactOfType(type: string): Artifact | null {
    const latestTaskByType = this._state.latestArtifactTaskByType;
    const latestTaskId = latestTaskByType[type];
    if (latestTaskId && this._state.artifacts[latestTaskId]) {
      return this._state.artifacts[latestTaskId];
    }
    let latest: Artifact | null = null;
    for (const artifact of Object.values(this._state.artifacts)) {
      if (artifact.type !== type) continue;
      latest = artifact;
    }
    return latest;
  }

  latestArtifactTaskIdOfType(type: string): string {
    const latestTaskByType = this._state.latestArtifactTaskByType;
    const latestTaskId = latestTaskByType[type];
    if (latestTaskId && this._state.artifacts[latestTaskId]) return latestTaskId;
    const latest = this._latestArtifactOfType(type);
    return latest?.taskId ?? "";
  }

  diagramSourceTaskId(diagramKey: string): string {
    const diagramSourcesByKey = this._state.diagramSourcesByKey;
    const normalized = diagramKey.trim();
    if (normalized && diagramSourcesByKey[normalized]) {
      return diagramSourcesByKey[normalized];
    }
    for (const [key, taskId] of Object.entries(diagramSourcesByKey)) {
      if (normalized && key.includes(normalized)) return taskId;
    }
    return this.latestArtifactTaskIdOfType("diagrams");
  }

  private _contentRevision(content: unknown): number {
    const text = JSON.stringify(content, (_key, value) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        );
      }
      return value;
    });
    const hex = createHash("sha256").update(text ?? "", "utf8").digest("hex").slice(0, 12);
    return parseInt(hex, 16) || 1;
  }

  private _sourceRevisionsForType(type: string): Record<string, number> {
    const revisions: Record<string, number> = {};
    for (const artifact of Object.values(this._state.artifacts)) {
      if (artifact.type !== type) continue;
      revisions[artifact.taskId] = this.currentArtifactRevision(artifact.taskId);
    }
    return revisions;
  }

  private _sourceRevisionsForTaskIds(taskIds: string[]): Record<string, number> {
    const revisions: Record<string, number> = {};
    for (const taskId of taskIds) {
      const revision = this.currentArtifactRevision(taskId);
      if (revision > 0) revisions[taskId] = revision;
    }
    return revisions;
  }

  /** Current revision number for a task's artifact (0 if none). */
  currentArtifactRevision(taskId: string): number {
    return this._state.artifactRevisionsByTask[taskId] ?? 0;
  }

  /** Whether any artifact exists with the given task type. */
  hasArtifactOfType(taskType: string): boolean {
    return Object.values(this._state.artifacts).some((a) => a.type === taskType);
  }

  /** All artifacts matching the given task type. */
  getArtifactsByType(taskType: string): Artifact[] {
    return Object.values(this._state.artifacts).filter((a) => a.type === taskType);
  }
}
