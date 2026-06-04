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
    const shouldKeepExistingArtifact =
      decision?.action === "regenerate" &&
      existingArtifact?.content !== undefined &&
      existingArtifact.content !== null &&
      !artifact.selfCheckPassed &&
      (existingArtifact.selfCheckPassed ||
        artifact.selfCheckIssues.length >= existingArtifact.selfCheckIssues.length);

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
