import { mkdirSync } from "node:fs";
import type { Logger } from "../logger.js";
import type { TraceLogger } from "../traceLogger.js";
import type { WorkflowState } from "../state.js";
import type { Artifact } from "../shared/types.js";
import type { TaskMailbox } from "../messaging.js";
import type { OutputManager } from "../outputManager.js";
import type { WorkflowEvent } from "../workflowEvents.js";
import type { TraceFlags } from "../config.js";
import { formatReviewReport } from "../formatReviewReport.js";
import { isRecord } from "../utils/isRecord.js";
import { validateReview } from "../shared/reviewValidator.js";
import { buildMatrix } from "../shared/traceabilityMatrix.js";
import { RequirementIndex } from "../shared/requirementIndex.js";
import { OutputSnapshotBuilder } from "./outputSnapshotBuilder.js";
import { isDesignModel } from "../shared/types.js";
import { SystemDesigner } from "../generators/design.js";

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
  /** Resolved trace output flags (drives which trace files get written). */
  traceFlags: TraceFlags;
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
    try {
      if (artifact.type === "design") {
        if (isDesignModel(artifact.content)) {
          const rendered = SystemDesigner.renderDesignMarkdown(artifact.content);
          manager.saveSystemDesign(rendered);
        } else if (typeof artifact.content === "string" && artifact.content) {
          manager.saveSystemDesign(artifact.content);
        }
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn(
        `Incremental artifact save failed for ${artifact.taskId}: ${message}`,
      );
      state.stores.execution.addError(`incremental artifact save failed (${artifact.taskId}): ${message}`);
      if (state.persistStatus !== "final_saved") {
        state.stores.execution.setPersistStatus("partial_saved");
      }
      this.deps.onEmitRuntimeEvent(
        "artifact_save_failed",
        `failed to save artifact for ${artifact.taskId}`,
        {
          goal: state.goal,
          phase: "persist",
          taskId: artifact.taskId,
          taskType: artifact.type,
          status: "failed",
          data: this.deps.onSnapshotState(state),
        },
      );
      return;
    }
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
    const snapshot = OutputSnapshotBuilder.fromState(state);
    if (!snapshot.hasOutput) return false;

    manager.saveSnapshot(snapshot);
    state.persisted = true;
    state.stores.execution.setPersistStatus("final_saved");
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
      try {
        const manager = new (this.deps.outputManagerCtor)(state.outputDir);
        manager.saveReviewReport(formatReviewReport(state.reviewResult), state.reviewResult);
      } catch (err) {
        this.deps.logger.warn(
          `Failed to save review before final gate: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const consistencyIssues = this.findOutputConsistencyIssues(state);
    if (consistencyIssues.length > 0) {
      for (const issue of consistencyIssues) {
        state.stores.execution.addError(`output consistency failed: ${issue}`);
      }
      state.stores.execution.setQualityStatus("rejected");
      state.finalReviewPassed = false;
      return false;
    }

    const deterministicIssues = this.findDeterministicQualityGateIssues(state);
    if (deterministicIssues.length > 0) {
      for (const issue of deterministicIssues) {
        state.stores.execution.addError(`deterministic quality gate failed: ${issue}`);
      }
      this.deps.logger.warn(
        `skip final persist after ${reason}: deterministic quality gate failed: ${deterministicIssues.join("; ")}`,
      );
      state.stores.execution.setQualityStatus("rejected");
      state.finalReviewPassed = false;
      state.stores.execution.setPersistStatus("partial_saved");
      return false;
    }

    const latestVerdict = state.latestVerdict;
    const terminalIssues = latestVerdict?.issues.filter(
      (issue) => issue.severity === "blocker" || issue.severity === "major",
    ) ?? [];
    if (latestVerdict && (!latestVerdict.passed || terminalIssues.length > 0)) {
      this.deps.logger.warn(
        `skip final persist after ${reason}: final review still has ${terminalIssues.length} blocker/major issue(s)`,
      );
      state.stores.execution.setQualityStatus("rejected");
      state.finalReviewPassed = false;
      state.stores.execution.setPersistStatus("partial_saved");
      return false;
    }
    return this.actionSave(state);
  }

  findDeterministicQualityGateIssues(state: WorkflowState): string[] {
    if (!this.shouldRunDeterministicFinalGate(state)) return [];

    const reviewValidation = validateReview(
      state.requirementJson as Record<string, unknown>,
      state.designText ?? "",
      state.testCases ?? "",
    );

    return [
      ...reviewValidation.checks
        .filter((check) => !check.passed)
        .map((check) => `review.${check.name}: ${check.detail}`),
    ];
  }

  private shouldRunDeterministicFinalGate(state: WorkflowState): boolean {
    if (state.goal === "analyze") return false;
    if (Object.keys(state.requirementJson).length === 0) return false;
    return true;
  }

  findOutputConsistencyIssues(state: WorkflowState): string[] {
    const requirementIndex = RequirementIndex.fromRequirementJson(state.requirementJson);
    if (requirementIndex.functions.length === 0) return [];

    const refTexts = [
      state.designText,
      state.testCases,
      ...Object.values(state.diagrams).filter(
        (item): item is string => typeof item === "string",
      ),
    ];
    const referenced = new Set<string>();
    for (const text of refTexts) {
      for (const id of requirementIndex.extractIds(text)) {
        if (id.startsWith("F") || id.startsWith("FUN_")) referenced.add(id);
      }
    }
    const definedFunctions = new Set(requirementIndex.idsFor("function", "both"));
    const unknown = [...referenced].filter((item) => !definedFunctions.has(item)).sort();
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
      const flags = this.deps.traceFlags;

      // run_summary.json is small and canonical; gated by `output.trace.run_summary`
      // (on by default; the boolean kill-switch `trace: false` still keeps it on).
      if (flags.runSummary) {
        manager.saveTraceJson("run_summary.json", state.runSummary);
      }

      // multi_agent_trace.json: lightweight multi-agent collaboration info.
      // The full mailbox notification dump is gated behind multiAgentTraceFullDump
      // (off by default — it was the 6.5MB bloat source). The `summary` field is
      // intentionally NOT duplicated here (it equals run_summary.json).
      if (flags.multiAgentTrace) {
        const tracePayload: Record<string, unknown> = {
          goal: state.goal,
          finished: state.finished,
          persisted: state.persisted,
          run_status: state.runStatus,
          quality_status: state.qualityStatus,
          persist_status: state.persistStatus,
          duration: state.duration(),
        };
        if (flags.multiAgentTraceFullDump) {
          tracePayload.notifications = this.deps.mailbox.peekAllNotifications();
        }
        manager.saveTraceJson("multi_agent_trace.json", tracePayload);
      }

      if (flags.llmTrace && this.deps.trace.entries.length > 0) {
        manager.saveTrace("llm_trace.json", this.deps.trace.exportJson());
      }

      this.deps.onEmitRuntimeEvent("trace_exported", "trace files exported", {
        goal: state.goal,
        phase: "persist",
        status: "completed",
        data: this.deps.onSnapshotState(state),
      });

      // Traceability matrix
      if (flags.traceabilityMatrix) {
        try {
          const matrix = buildMatrix(
            state.requirementJson as Record<string, unknown>,
            state.designText ?? "",
            state.testCases ?? "",
            state.spanMap,
          );
          manager.saveTraceJson("traceability_matrix.json", matrix as unknown as Record<string, unknown>);
          this.deps.logger.info(
            `Traceability: ${matrix.uncoveredConstraints.length} uncovered constraints, ${matrix.uncoveredFunctions.length} uncovered functions, ${matrix.uncoveredExceptions.length} uncovered exceptions`,
          );
        } catch (matrixError: unknown) {
          this.deps.logger.warn(
            "traceability matrix build failed: " + (matrixError instanceof Error ? matrixError.message : String(matrixError)),
          );
        }
      }
    } catch (error: unknown) {
      this.deps.logger.warn(
        `trace export failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
