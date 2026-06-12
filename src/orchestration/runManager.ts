/**
 * 编排控制平面的运行状态转换。
 *
 */

import type { WorkflowState } from "../state.js";

// ---------------------------------------------------------------------------
// RunManager
// ---------------------------------------------------------------------------

export class RunManager {
  static markCompleted(state: WorkflowState): void {
    state.runStatus = "completed";
    state.persistStatus = "final_saved";
  }

  static markPartial(state: WorkflowState, reason = ""): void {
    if (state.runStatus === "running") state.runStatus = "partial";
    if (state.persistStatus === "not_saved" && Object.keys(state.artifacts).length > 0) state.persistStatus = "partial_saved";
    if (reason) state.errors.push(reason);
  }

  static markPaused(state: WorkflowState, reason = ""): void {
    state.runStatus = "paused";
    if (state.persistStatus === "not_saved" && Object.keys(state.artifacts).length > 0) {
      state.persistStatus = "partial_saved";
    }
    if (reason) state.errors.push(reason);
  }

  static markFailed(state: WorkflowState, reason = ""): void {
    state.runStatus = "failed";
    if (reason) state.errors.push(reason);
  }
}

// ---------------------------------------------------------------------------
// RunSummaryBuilder —— 结构化运行摘要
// ---------------------------------------------------------------------------

export class RunSummaryBuilder {
  static build(state: WorkflowState): Record<string, unknown> {
    const severityCounts: Record<string, number> = {};
    const scopeCounts: Record<string, number> = {};
    const targetTypeCounts: Record<string, number> = {};

    for (const verdict of state.verdicts) {
      for (const issue of verdict.issues) {
        const sev = issue.severity || "unknown";
        severityCounts[sev] = (severityCounts[sev] ?? 0) + 1;
        const scp = issue.scope || "unknown";
        scopeCounts[scp] = (scopeCounts[scp] ?? 0) + 1;
        const ttype = issue.targetTaskType || "unknown";
        targetTypeCounts[ttype] = (targetTypeCounts[ttype] ?? 0) + 1;
      }
    }

    const artifactCounts: Record<string, number> = {};
    for (const artifact of Object.values(state.artifacts)) {
      const atype = artifact.type || "unknown";
      artifactCounts[atype] = (artifactCounts[atype] ?? 0) + 1;
    }

    const allIncidents = RunSummaryBuilder._incidentCategories(state);
    const failureCategories = RunSummaryBuilder._failureCategories(state, allIncidents);

    const counters: Record<string, number> = state.progress._counters ?? {};
    const budgetCounters: Record<string, number> = {};
    const budgetPrefixes = ["repair_count:", "regenerate_count:", "planner_", "replan_", "evaluator_"];
    for (const [key, val] of Object.entries(counters).sort(([a], [b]) => a.localeCompare(b))) {
      if (budgetPrefixes.some((pre) => key.startsWith(pre))) budgetCounters[key] = val;
    }
    const qualityStatus = RunSummaryBuilder._effectiveQualityStatus(state);

    return {
      goal: state.goal, run_status: state.runStatus, quality_status: qualityStatus,
      persist_status: state.persistStatus, finished: state.finished, persisted: state.persisted,
      duration: Math.round(state.duration() * 100) / 100,
      artifact_count: Object.keys(state.artifacts).length,
      artifact_counts: Object.fromEntries(Object.entries(artifactCounts).sort(([a], [b]) => a.localeCompare(b))),
      decision_count: state.actionHistory.length,
      review_rounds: state.verdicts.length,
      final_review_done: state.finalReviewDone, final_review_passed: state.finalReviewPassed,
      plan_task_count: state.plan ? state.plan.tasks.length : 0,
      plan_revision_count: state.progress.planRevisionCount,
      issue_counts: {
        severity: Object.fromEntries(Object.entries(severityCounts).sort(([a], [b]) => a.localeCompare(b))),
        scope: Object.fromEntries(Object.entries(scopeCounts).sort(([a], [b]) => a.localeCompare(b))),
        target_type: Object.fromEntries(Object.entries(targetTypeCounts).sort(([a], [b]) => a.localeCompare(b))),
      },
      budget_counters: budgetCounters,
      failure_categories: failureCategories,
      recovered_incidents: Array.from(new Set(allIncidents.filter((inc) => !failureCategories.includes(inc)))).sort(),
      errors: state.errors.slice(-10),
    };
  }

  private static _incidentCategories(state: WorkflowState): string[] {
    const categories = new Set<string>();
    const errorText = state.errors.join("\n").toLowerCase();
    if (errorText.includes("runtime budget exhausted")) categories.add("runtime_budget_exhausted");
    if (errorText.includes("decision guard exhausted")) categories.add("decision_budget_exhausted");
    if (errorText.includes("planner") && (errorText.includes("failed") || errorText.includes("timeout") || errorText.includes("timed out"))) categories.add("planner_failure");
    if (errorText.includes("replan") && (errorText.includes("failed") || errorText.includes("no plan"))) categories.add("replan_failure");
    if (errorText.includes("save failed")) categories.add("save_failure");
    if (state.verdicts.some((v) => !v.passed)) categories.add("review_rejected");
    const counters: Record<string, number> = state.progress._counters ?? {};
    if (Object.entries(counters).some(([key, val]) => key.startsWith("repair_count:") && val >= 3)) categories.add("repair_budget_exhausted");
    if (state.runStatus === "partial") categories.add("partial_run");
    if (RunSummaryBuilder._effectiveQualityStatus(state) === "rejected") categories.add("quality_rejected");
    if (state.persistStatus === "partial_saved") categories.add("partial_saved");
    return Array.from(categories).sort();
  }

  private static _failureCategories(state: WorkflowState, incidents: string[]): string[] {
    const qualityStatus = RunSummaryBuilder._effectiveQualityStatus(state);
    if (state.runStatus === "completed" && qualityStatus === "passed" && state.persistStatus === "final_saved") return [];
    return [...incidents].sort();
  }

  private static _effectiveQualityStatus(state: WorkflowState): string {
    if (state.finalReviewDone) {
      return state.finalReviewPassed ? "passed" : "rejected";
    }
    return state.qualityStatus;
  }
}
