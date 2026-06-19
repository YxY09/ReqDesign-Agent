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
          // Defense: refuse to overwrite the saved system_design.md when the
          // new content contains stub placeholders like "（原有...保持不变）"
          // or "（此处省略）". These appear when the repair LLM only rewrites
          // a subset of sections and "省略" the rest — clobbering a previously
          // complete design with a fragmentary one.
          if (PersistenceService.containsStubPlaceholders(artifact.content)) {
            this.deps.logger.warn(
              `incremental design save rejected for ${artifact.taskId}: content contains stub placeholders (e.g. "原有...保持不变" / "此处省略") — keeping previous complete design on disk`,
            );
            state.stores.execution.addError(
              `incremental design save rejected (${artifact.taskId}): stub placeholders detected`,
            );
            // Still persist the by_task snapshot so audit retains the stub,
            // but DO NOT overwrite the canonical design/system_design.md.
            manager.saveArtifactByTask(artifact.taskId, artifact.type, artifact.content);
            return;
          }
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

    // Defense: if state.designText was mutated by a stub-bearing repair attempt,
    // saveSnapshot would clobber the canonical design/system_design.md on disk
    // with the stub. Drop the design from this final snapshot so the previously-
    // written complete design (preserved by saveArtifactIncrementally's stub
    // guard) remains the persisted version.
    if (
      typeof snapshot.designText === "string" &&
      snapshot.designText &&
      PersistenceService.containsStubPlaceholders(snapshot.designText)
    ) {
      this.deps.logger.warn(
        "final snapshot contains stub placeholders in designText — keeping the previously-persisted complete design instead of overwriting with the fragmentary version",
      );
      snapshot.designText = "";
    }

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
    const deterministicIssues = consistencyIssues.length === 0
      ? this.findDeterministicQualityGateIssues(state)
      : [];

    if (consistencyIssues.length > 0) {
      for (const issue of consistencyIssues) {
        state.stores.execution.addError(`output consistency failed: ${issue}`);
      }
      state.stores.execution.setQualityStatus("rejected");
      state.finalReviewPassed = false;
    } else if (deterministicIssues.length > 0) {
      for (const issue of deterministicIssues) {
        state.stores.execution.addError(`deterministic quality gate failed: ${issue}`);
      }
      this.deps.logger.warn(
        `quality gate failed after ${reason}: deterministic quality gate failed: ${deterministicIssues.join("; ")}`,
      );
      state.stores.execution.setQualityStatus("rejected");
      state.finalReviewPassed = false;
    }

    const latestVerdict = state.latestVerdict;
    const terminalIssues = latestVerdict?.issues.filter(
      (issue) => issue.severity === "blocker" || issue.severity === "major",
    ) ?? [];
    const reviewFailed =
      latestVerdict !== null &&
      latestVerdict !== undefined &&
      (!latestVerdict.passed || terminalIssues.length > 0);
    if (reviewFailed) {
      this.deps.logger.warn(
        `quality gate failed after ${reason}: final review still has ${terminalIssues.length} blocker/major issue(s)`,
      );
      state.stores.execution.setQualityStatus("rejected");
      state.finalReviewPassed = false;
    }

    // Always run actionSave: even when the quality gate failed, persisting the
    // best-effort snapshot is preferable to leaving partial incremental writes
    // unmerged (and summary_report.md / analysis.md unwritten). The persist
    // status is corrected back to "partial_saved" below when the gate failed.
    const saved = this.actionSave(state);
    const gateFailed = consistencyIssues.length > 0 || deterministicIssues.length > 0 || reviewFailed;
    if (gateFailed) {
      // actionSave sets persist_status="final_saved" — downgrade to
      // "partial_saved" so the run_summary still tells the truth: the
      // artifacts on disk are best-effort, not gate-passed.
      state.stores.execution.setPersistStatus("partial_saved");
      return false;
    }
    return saved;
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
            state.designModel ?? undefined,
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

  /**
   * Detect "stub placeholder" patterns that signal the LLM has only rewritten
   * part of the design and elided the rest with phrases like
   * "（原有 XX 保持不变）" / "（此处省略）" / "... unchanged ...".
   *
   * Any match is fatal — a design document with even one such placeholder is
   * fragmentary and would clobber an earlier complete version on disk. The
   * judge would then read the stub and score it as incomplete, which is
   * exactly the failure mode hospital_mgmt hit in realcmp_20260617.
   */
  static containsStubPlaceholders(content: string): boolean {
    const patterns: RegExp[] = [
      /[（(](?:原有|以下|上述|前述)[^）)\n]{0,40}(?:保持不变|未变|不变|沿用|参见上文|详见上文|见上文|同上)[^）)\n]{0,20}[)）]/,
      /[（(](?:此处|该处|本节)?\s*省略[^)）\n]{0,40}[)）]/,
      /[（(]\s*(?:保留|沿用)\s*(?:原|原有)[^)）\n]{0,40}[)）]/,
      /\(\s*(?:omitted|unchanged|same as above|see above|kept as is)\s*\)/i,
      /\.{3,}\s*(?:unchanged|omitted)\s*\.{3,}/i,
    ];
    return patterns.some((re) => re.test(content));
  }
}
