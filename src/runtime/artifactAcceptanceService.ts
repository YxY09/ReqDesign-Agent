import type { WorkflowState } from "../state.js";
import type { Artifact, RuntimeAction } from "../shared/types.js";
import { isRecord } from "../utils/isRecord.js";
import { ConvergenceTracker } from "../orchestration/snapshot.js";
import { PostGenerationValidator } from "../tools/validator.js";
import { DiagramGenerator } from "../generators/diagrams.js";

export type ArtifactAcceptanceOutcome =
  | {
      action: "accept";
      artifact: Artifact;
    }
  | {
      action: "keep_existing";
      artifact: Artifact;
      error: string;
      details: Record<string, unknown>;
      eventKind: "regenerate_rejected";
    };

export interface ArtifactAcceptanceInput {
  state: WorkflowState;
  taskId: string;
  artifact: Artifact;
  decision?: RuntimeAction;
}

/**
 * Central gate for generated/repaired artifact candidates.
 *
 * It owns deterministic post-generation cleanup and candidate-vs-existing
 * acceptance rules. Persistence, events, and lifecycle mutations stay in the
 * runtime result handler.
 */
export class ArtifactAcceptanceService {
  evaluateCandidate(input: ArtifactAcceptanceInput): ArtifactAcceptanceOutcome {
    const { state, taskId, decision } = input;
    const artifact = input.artifact;
    artifact.taskId = taskId;

    const cleaned = PostGenerationValidator.validate(
      state.requirementJson,
      artifact.type,
      artifact.content,
      state.domainModelJson,
    );
    if (cleaned !== null) {
      artifact.content = cleaned;
    }

    // Deterministic class-diagram fidelity gate (covers BOTH generation and
    // repair candidates). The repair LLM can collapse a domain-model
    // generalization (parent + roles) into a single flattened entity with a
    // `role` attribute, dropping the `<|--` hierarchy lines — and the repair
    // path does not re-run `generateClassDiagram`. This chokepoint is the only
    // place both paths converge, so enforce here that the accepted class
    // diagram faithfully renders every authoritative domain-model
    // generalization as a `Parent <|-- Child` line (injecting any missing
    // class blocks + abstract marker + `<|--` lines). Pure and idempotent, so
    // re-running it on already-faithful generation output is a no-op.
    ArtifactAcceptanceService._enforceClassDiagramFidelity(artifact, state.domainModelJson);

    // Structural guard: an empty/unusable domain model — null content OR a
    // record with 0 concepts — produced under a self-check FAILURE must NOT be
    // accepted/persisted as a success. Such a stub silently poisons every
    // downstream consumer (class diagram has nothing to render, traceability
    // breaks). Reject here so the result handler marks the task FAILED (not
    // completed) and skips persistence, letting repair/replan/recovery kick
    // in. Detection is purely structural (concept count == 0), never by name
    // or domain. A NON-empty but partially-flawed model keeps the current
    // behavior (issues flagged, repair allowed) — only the unusable case
    // hard-fails. Fires for both generation and repair candidates since this
    // is the single chokepoint where both paths converge.
    if (artifact.type === "domain_model" && artifact.selfCheckPassed === false) {
      let conceptCount = 0;
      if (isRecord(artifact.content)) {
        const concepts = (artifact.content).concepts;
        conceptCount = Array.isArray(concepts) ? concepts.length : 0;
      }
      if (conceptCount === 0) {
        const error =
          `${taskId} domain_model rejected: 0 concepts after self-check ` +
          `— unusable empty model not persisted`;
        return {
          action: "keep_existing",
          artifact,
          error,
          eventKind: "regenerate_rejected",
          details: {
            error,
            candidateIssues: artifact.selfCheckIssues.slice(0, 10),
            candidateIssueCount: artifact.selfCheckIssues.length,
            reason: "empty_domain_model",
          },
        };
      }
    }

    const existingArtifact = state.artifacts[taskId];
    const candidateIssues = artifact.selfCheckIssues.length;
    const existingIssues = existingArtifact?.selfCheckIssues.length ?? 0;
    const evaluatorIssueFingerprints =
      decision?.action === "regenerate"
        ? this.evaluatorIssueFingerprintsForTask(state, taskId)
        : [];
    const isEvaluatorTriggeredRegenerate = evaluatorIssueFingerprints.length > 0;
    // Reject a regeneration candidate only if it is STRICTLY WORSE than the existing artifact:
    // - existing passed (0 issues): reject candidate only if it has > 1 issue (1 is ok, semantic
    //   fixes often introduce one minor structural warning)
    // - both fail: reject only if candidate has STRICTLY MORE issues than existing; a tie means
    //   the candidate is no worse and may have fixed a semantic issue the self-check can't see
    // - evaluator-triggered regeneration: accept the candidate into a new revision so the
    //   evaluator can check whether the semantic issue fingerprints actually moved.
    const wouldRejectVsExisting = existingArtifact?.selfCheckPassed
      ? candidateIssues > 1
      : candidateIssues > existingIssues;
    const shouldKeepExistingArtifact =
      decision?.action === "regenerate" &&
      existingArtifact?.content !== undefined &&
      existingArtifact.content !== null &&
      !artifact.selfCheckPassed &&
      wouldRejectVsExisting &&
      !isEvaluatorTriggeredRegenerate;

    if (shouldKeepExistingArtifact) {
      const keptRevision = state.currentArtifactRevision(taskId);
      const error =
        `${taskId} regenerate candidate rejected by self-check; kept existing artifact revision ` +
        `${keptRevision}`;
      return {
        action: "keep_existing",
        artifact,
        error,
        eventKind: "regenerate_rejected",
        details: {
          error,
          candidateIssues: artifact.selfCheckIssues.slice(0, 10),
          candidateIssueCount: artifact.selfCheckIssues.length,
          keptRevision,
          evaluatorIssueFingerprints,
        },
      };
    }

    return { action: "accept", artifact };
  }

  /**
   * Deterministic class-diagram fidelity for an accepted candidate.
   *
   * Delegates to `DiagramGenerator._enforceConceptFidelity` (the single source
   * of truth for the class-diagram superset guarantee) so that the class
   * diagram faithfully renders every authoritative domain-model concept and
   * — critically — every generalization as a `Parent <|-- Child` line,
   * even when a repair-path LLM flattened the hierarchy into one entity + a
   * `role` attribute. Mutates `artifact.content` only when the class diagram
   * actually changes; leaves non-diagram / non-class artifacts untouched.
   */
  private static _enforceClassDiagramFidelity(
    artifact: Artifact,
    domainModelJson: Record<string, unknown> | null | undefined,
  ): void {
    if (artifact.type !== "diagrams") return;
    if (!domainModelJson || typeof domainModelJson !== "object") return;
    const content = artifact.content;
    if (typeof content !== "object" || content === null || Array.isArray(content)) return;
    const obj = content as Record<string, unknown>;
    const classDiagram = obj.class_diagram;
    if (typeof classDiagram !== "string" || !classDiagram) return;
    const enforced = DiagramGenerator._enforceConceptFidelity(classDiagram, domainModelJson);
    if (enforced !== classDiagram) {
      obj.class_diagram = enforced;
    }
  }

  private evaluatorIssueFingerprintsForTask(
    state: WorkflowState,
    taskId: string,
  ): string[] {
    const latestVerdict = state.latestVerdict;
    if (!latestVerdict) return [];
    const currentRevision = state.currentArtifactRevision(taskId);
    if (currentRevision === 0) return [];
    if (latestVerdict.evaluatedRevisions[taskId] !== currentRevision) return [];

    return latestVerdict.issues
      .filter((issue) => issue.targetTaskId === taskId)
      .map((issue) => ConvergenceTracker.fingerprint(issue));
  }
}
