import type { WorkflowState } from "../state.js";
import type { Artifact, RuntimeAction } from "../shared/types.js";
import { PostGenerationValidator } from "../tools/validator.js";

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
    );
    if (cleaned !== null) {
      artifact.content = cleaned;
    }

    const existingArtifact = state.artifactsState.artifacts[taskId];
    const candidateIssues = artifact.selfCheckIssues.length;
    const existingIssues = existingArtifact?.selfCheckIssues.length ?? 0;
    // Reject a regeneration candidate only if it is STRICTLY WORSE than the existing artifact:
    // - existing passed (0 issues): reject candidate only if it has > 1 issue (1 is ok, semantic
    //   fixes often introduce one minor structural warning)
    // - both fail: reject only if candidate has STRICTLY MORE issues than existing; a tie means
    //   the candidate is no worse and may have fixed a semantic issue the self-check can't see
    const wouldRejectVsExisting = existingArtifact?.selfCheckPassed
      ? candidateIssues > 1
      : candidateIssues > existingIssues;
    const shouldKeepExistingArtifact =
      decision?.action === "regenerate" &&
      existingArtifact?.content !== undefined &&
      existingArtifact.content !== null &&
      !artifact.selfCheckPassed &&
      wouldRejectVsExisting;

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
        },
      };
    }

    return { action: "accept", artifact };
  }
}
