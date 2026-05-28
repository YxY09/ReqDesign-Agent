import { mkdirSync } from "node:fs";
import type { Logger } from "../logger.js";
import type { TraceLogger } from "../traceLogger.js";
import type { WorkflowState } from "../state.js";
import type { Artifact } from "../shared/types.js";
import type { TaskMailbox } from "../messaging.js";
import type { OutputManager } from "../outputManager.js";
import type { WorkflowEvent } from "../workflowEvents.js";
import { OutputScorer } from "../../evaluate/scorer.js";
import { formatReviewReport } from "../formatReviewReport.js";
import { isRecord } from "../utils/isRecord.js";

/**
 * Callback signatures used by PersistenceService to emit runtime events
 * and capture state snapshots without importing the runtime itself.
 */
export interface PersistenceServiceDeps {
  outputManagerCtor: typeof OutputManager;
  trace: TraceLogger;
  mailbox: TaskMailbox;
  logger: Logger;
  /** Emit a runtime event through the EventBridge (or equivalent). */
  onEmitRuntimeEvent: (
    kind: string,
    message: string,
    extras: Partial<WorkflowEvent>,
  ) => void;
  /** Take a snapshot of the current WorkflowState for event payloads. */
  onSnapshotState: (state: WorkflowState) => Record<string, unknown>;
}

/**
 * Persistence service extracted from MultiAgentRuntime.
 *
 * Handles incremental artifact saves, final output persistence, review
 * report saving, quality-gate checks, output-consistency validation, and
 * trace / quality-score exports.
 */
export class PersistenceService {
  private readonly deps: PersistenceServiceDeps;

  constructor(deps: PersistenceServiceDeps) {
    this.deps = deps;
  }

  saveArtifactIncrementally(
    state: WorkflowState,
    artifact: Artifact,
  ): void {
    const manager = new this.deps.outputManagerCtor(state.outputDir);
    if (
      artifact.type === "design" &&
      typeof artifact.content === "string"
    ) {
      manager.saveSystemDesign(artifact.content);
    } else if (artifact.type === "diagrams" && isRecord(artifact.content)) {
      manager.saveDiagrams(state.diagrams);
    } else if (
      artifact.type === "tests" &&
      typeof artifact.content === "string"
    ) {
      manager.saveTestCases(artifact.content);
    }
    manager.saveArtifactByTask(
      artifact.taskId,
      artifact.type,
      artifact.content,
    );
    this.deps.onEmitRuntimeEvent(
      "artifact_saved",
      `saved artifact for ${artifact.taskId}`,
      {
        goal: state.goal,
        phase: "persist",
        taskId: artifact.taskId,
        taskType: artifact.type,
        status: "completed",
        data: this.deps.onSnapshotState(state),
      },
    );
  }

  actionSave(state: WorkflowState): boolean {
    mkdirSync(state.outputDir, { recursive: true });
    const manager = new this.deps.outputManagerCtor(state.outputDir);
    const hasOutput = Boolean(
      Object.keys(state.requirementJson).length > 0 ||
      state.designText ||
      Object.keys(state.diagrams).length > 0 ||
      state.testCases,
    );
    if (!hasOutput) return false;

    if (state.goal === "analyze") {
      manager.saveRequirementAnalysis(
        state.requirementJson,
        state.requirementText,
      );
    } else {
      manager.saveAll(
        state.requirementJson,
        state.requirementText,
        state.designText,
        state.diagrams,
        state.testCases,
        state.reviewResult,
      );
    }
    state.persisted = true;
    state.persistStatus = "final_saved";
    return true;
  }

  /** 如果 reviewResult 有内容则立即保存，用于 pause/finish 等提前退出的路径。 */
  saveReviewIfPresent(state: WorkflowState): void {
    if (Object.keys(state.reviewResult).length > 0) {
      try {
        const manager = new (this.deps.outputManagerCtor)(state.outputDir);
        manager.saveReviewReport(formatReviewReport(state.reviewResult), state.reviewResult);
      } catch (err) {
        this.deps.logger.warn(
          `Failed to save review before pause/finish: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  actionSaveIfQualityGatePassed(
    state: WorkflowState,
    reason: string,
  ): boolean {
    // 无论质量门通过与否，先保存 review result
    if (Object.keys(state.reviewResult).length > 0) {
      const manager = new (this.deps.outputManagerCtor)(state.outputDir);
      manager.saveReviewReport(formatReviewReport(state.reviewResult), state.reviewResult);
    }

    const consistencyIssues = this.findOutputConsistencyIssues(state);
    if (consistencyIssues.length > 0) {
      for (const issue of consistencyIssues) {
        state.errors.push(`output consistency failed: ${issue}`);
      }
      state.setQualityStatus("rejected");
      state.finalReviewPassed = false;
      return false;
    }
    const latestVerdict = state.latestVerdict;
    if (latestVerdict && !latestVerdict.passed) {
      this.deps.logger.warn(
        `skip final persist after ${reason}: final quality gate is not satisfied`,
      );
      state.persistStatus = "partial_saved";
      return false;
    }
    return this.actionSave(state);
  }

  findOutputConsistencyIssues(state: WorkflowState): string[] {
    const functions = Array.isArray(state.requirementJson.functions)
      ? state.requirementJson.functions
      : [];
    const defined = new Set(
      functions
        .filter(
          (item): item is Record<string, unknown> =>
            isRecord(item) && Boolean(item.id),
        )
        .map((item) => String(item.id)),
    );
    if (defined.size === 0) return [];

    const refTexts = [
      state.designText,
      state.testCases,
      ...Object.values(state.diagrams).filter(
        (item): item is string => typeof item === "string",
      ),
    ];
    const referenced = new Set<string>();
    for (const text of refTexts) {
      for (const match of text.match(/\bF\d{3}\b/g) ?? []) {
        referenced.add(match);
      }
    }
    const unknown = [...referenced].filter((item) => !defined.has(item)).sort();
    return unknown.length > 0
      ? [
          `design/tests/diagrams reference undefined function IDs: ${unknown.join(", ")}`,
        ]
      : [];
  }

  exportTrace(state: WorkflowState): void {
    try {
      mkdirSync(state.outputDir, { recursive: true });
      const manager = new this.deps.outputManagerCtor(state.outputDir);
      manager.saveTraceJson("run_summary.json", state.runSummary);
      manager.saveTraceJson("multi_agent_trace.json", {
        summary: state.runSummary,
        goal: state.goal,
        finished: state.finished,
        persisted: state.persisted,
        run_status: state.runStatus,
        quality_status: state.qualityStatus,
        persist_status: state.persistStatus,
        duration: state.duration(),
        notifications: this.deps.mailbox.peekAllNotifications(),
      });
      if (this.deps.trace.entries.length > 0) {
        manager.saveTrace("llm_trace.json", this.deps.trace.exportJson());
      }
      this.deps.onEmitRuntimeEvent("trace_exported", "trace files exported", {
        goal: state.goal,
        phase: "persist",
        status: "completed",
        data: this.deps.onSnapshotState(state),
      });

      // 对输出质量进行评分
      try {
        const score = OutputScorer.score(
          state.requirementJson as Record<string, unknown>,
          state.designText ?? "",
          state.diagrams as Record<string, unknown>,
          state.testCases ?? "",
          state.requirementJson as Record<string, unknown>,
          state.requirementText,
        );
        this.deps.logger.info("\n" + OutputScorer.format(score));
        manager.saveTraceJson("quality_score.json", score as unknown as Record<string, unknown>);
      } catch (scoringError: unknown) {
        this.deps.logger.warn(
          "quality scoring failed: " + (scoringError instanceof Error ? scoringError.message : String(scoringError)),
        );
      }
    } catch (error: unknown) {
      this.deps.logger.warn(
        `trace export failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
