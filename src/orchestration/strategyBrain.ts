/**
 * 基于 LLM 的策略顾问 — 用于非显而易见的编排状态。
 *
 * 源自 reqdesign/orchestration/strategy_brain.py。
 */

import type { LLMClient } from "../llmClient.js";
import type { OrchestratorSnapshot } from "./snapshot.js";
import {
  type StrategyDecision,
  type StrategyName,
  createStrategyDecision,
} from "./strategy.js";
import { makeStreamPrinter } from "../streaming.js";
import { getMemory } from "../memory/store.js";

// ---------------------------------------------------------------------------
// StrategyBrain
// ---------------------------------------------------------------------------

/** LLM 可选择的有效策略名称集合。 */
const VALID_STRATEGIES: ReadonlySet<string> = new Set<StrategyName>([
  "start_planning",
  "route_direct_diagrams",
  "advance_ready_work",
  "wait_for_running",
  "run_opportunistic_review",
  "run_final_review",
  "repair_local_artifact",
  "repair_upstream_artifact",
  "regenerate_downstream",
  "escalate_to_replan",
  "save_outputs",
  "finish",
  "pause_for_user",
]);

// ---------------------------------------------------------------------------
// StrategyBrain
// ---------------------------------------------------------------------------

export class StrategyBrain {
  private readonly llm: LLMClient;

  constructor(llm: LLMClient) {
    this.llm = llm;
  }

  /** 向 LLM 请求策略，而非底层运行时操作。 */
  async decide(snapshot: OrchestratorSnapshot): Promise<StrategyDecision> {
    const prompt = await this._buildPrompt(snapshot);
    const system =
      "You are an engineering orchestration strategist. " +
      "Choose a high-level strategy only. Do not choose low-level spawn/save actions.";

    const { onChunk, done } = makeStreamPrinter("[Orchestrator]");
    try {
      const response = await this.llm.generateJson(prompt, system, onChunk);
      return StrategyBrain._parseResponse(response, snapshot);
    } catch (exc) {
      console.warn(
        "[StrategyBrain] LLM strategy failed:",
        exc instanceof Error ? exc.message : String(exc),
      );
      throw exc;
    } finally {
      done();
    }
  }

  // -------------------------------------------------------------------
  // Prompt 构建
  // -------------------------------------------------------------------

  private async _buildPrompt(snapshot: OrchestratorSnapshot): Promise<string> {
    const data: Record<string, unknown> = {
      goal: snapshot.goal,
      requirement_preview: snapshot.requirementPreview,
      plan_ready: snapshot.planReady,
      plan_all_completed: snapshot.planAllCompleted,
      ready_tasks: snapshot.readyTasks,
      running_tasks: snapshot.runningTasks,
      artifact_task_ids: snapshot.artifactTaskIds,
      unaccepted_artifacts: snapshot.unacceptedArtifacts,
      unevaluated_artifacts: snapshot.unevaluatedArtifacts,
      rejected_artifacts: snapshot.rejectedArtifacts,
      latest_issues: snapshot.latestIssues,
      final_review_done: snapshot.finalReviewDone,
      final_review_passed: snapshot.finalReviewPassed,
      final_review_current: snapshot.finalReviewCurrent,
      recent_errors: snapshot.recentErrors,
      repair_counts_by_task: snapshot.repairCountsByTask,
    };

    const knownTaskIds = StrategyBrain._knownTaskIds(snapshot);
    const basePrompt = (
      "Read this workflow snapshot and choose one strategy.\n" +
      "Allowed strategies: start_planning, route_direct_diagrams, advance_ready_work, wait_for_running, " +
      "run_opportunistic_review, run_final_review, repair_local_artifact, " +
      "repair_upstream_artifact, regenerate_downstream, escalate_to_replan, " +
      "save_outputs, finish, pause_for_user.\n" +
      "Initial routing: choose route_direct_diagrams only for simple diagram-focused requests; " +
      "choose start_planning for multi-module requirements, ambiguous requirements, or anything needing analysis/design/tests.\n" +
      (knownTaskIds.length > 0
        ? `Valid task ids (target_task_id / affected_task_ids MUST come from this list, or be empty): ${knownTaskIds.join(", ")}\n`
        : "No tasks exist yet: leave target_task_id and affected_task_ids empty.\n") +
      "Return JSON with strategy, target_task_id, affected_task_ids, reason, confidence.\n" +
      "```json\n" +
      JSON.stringify(data, null, 2) +
      "\n```"
    );

    try {
      const memory = getMemory();
      const queryContext = [
        snapshot.goal,
        snapshot.readyTasks.join(" "),
        snapshot.rejectedArtifacts.join(" "),
        snapshot.majorPendingTaskIds.join(" "),
        snapshot.latestIssues
          .map((issue) => String(issue["description"] ?? ""))
          .join(" "),
      ]
        .filter(Boolean)
        .join("\n");
      return await memory.appendToPrompt("coordinator", basePrompt, queryContext);
    } catch {
      return basePrompt;
    }
  }

  // -------------------------------------------------------------------
  // 响应解析
  // -------------------------------------------------------------------

  /** snapshot 中已知的全部 task id（计划任务 ∪ 产物任务）。 */
  private static _knownTaskIds(snapshot: OrchestratorSnapshot): string[] {
    const ids = new Set<string>([
      ...Object.keys(snapshot.planTaskTypesById),
      ...snapshot.artifactTaskIds,
    ]);
    return [...ids].sort();
  }

  private static _parseResponse(
    response: Record<string, unknown>,
    snapshot: OrchestratorSnapshot,
  ): StrategyDecision {
    if (typeof response !== "object" || response === null) {
      throw new Error(
        `strategy response must be an object, got ${typeof response}`,
      );
    }

    const strategy = String(response["strategy"] ?? "").trim();
    if (!VALID_STRATEGIES.has(strategy)) {
      throw new Error(`invalid strategy: ${strategy}`);
    }

    let affected: unknown[] = [];
    const rawAffected = response["affected_task_ids"];
    if (Array.isArray(rawAffected)) {
      affected = rawAffected;
    }

    let confidence = 0.5;
    const rawConf = response["confidence"];
    if (rawConf !== undefined && rawConf !== null) {
      const num = Number(rawConf);
      if (!isNaN(num)) {
        confidence = num;
      }
    }

    // 校验 LLM 返回的 task id：幻觉 id 会让 guard/compiler 派发不存在的任务。
    // 非法 id 直接清空，由 PolicyGuard 的兜底逻辑挑选安全目标。
    const known = new Set(StrategyBrain._knownTaskIds(snapshot));
    let targetTaskId = String(response["target_task_id"] ?? "").trim();
    if (targetTaskId && known.size > 0 && !known.has(targetTaskId)) {
      targetTaskId = "";
    }
    const affectedTaskIds = affected
      .map((t) => String(t).trim())
      .filter((t) => t.length > 0 && (known.size === 0 || known.has(t)));

    return createStrategyDecision({
      strategy: strategy as StrategyName,
      targetTaskId,
      affectedTaskIds,
      reason: String(response["reason"] ?? "").trim(),
      confidence,
    });
  }
}
