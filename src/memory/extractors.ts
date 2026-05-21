/**
 * 事件驱动的记忆提取函数。
 *
 * 将结构化运行时输出（Verdict / RuntimeAction / Artifact）
 * 转换为 MemoryWrite 记录，供 MemoryStore 持久化。
 *
 * 源自 reqdesign/memory/extractors.py。
 */

import type {
  Verdict,
  RuntimeAction,
  Artifact,
  Issue,
} from "../shared/types.js";
import { getMemory } from "./store.js";

// ---------------------------------------------------------------------------
// MemoryWrite
// ---------------------------------------------------------------------------

/** 准备持久化的记忆记录。 */
export interface MemoryWrite {
  agentType: string;
  content: string;
  memType: string;
  dedupKey: string;
  topic: string;
}

/**
 * 使用全局记忆存储持久化提取的记忆写入。
 *
 * 仅尽力而为：写入失败会被吞没，运行时流程不受影响。
 */
export function persistMemoryWrites(writes: MemoryWrite[]): void {
  if (writes.length === 0) return;
  try {
    const memory = getMemory();
    if (!memory) return;
    for (const write of writes) {
      memory.save(
        write.agentType,
        write.content,
        write.memType,
        write.topic,
        write.dedupKey,
      );
    }
  } catch {
    // 记忆持久化为非关键操作。
  }
}

// ---------------------------------------------------------------------------
// Evaluator → 结构化经验
// ---------------------------------------------------------------------------

/**
 * 从 Evaluator 裁决中提取结构化经验。
 *
 * 策略：
 * - passed=true → 仅记录干净的最终通过（final review，无问题）。
 * - passed=false → 仅记录 blocker/upstream/systemic 问题。
 * - 按范围对问题分组。
 */
export function extractEvaluatorInsight(
  verdict: Verdict,
  goal = "",
): MemoryWrite[] {
  const results: MemoryWrite[] = [];

  if (verdict.issues.length === 0 && !verdict.summary) {
    return results;
  }

  // 通过：仅持久化干净的最终胜利
  if (verdict.passed) {
    if (
      verdict.isFinalReview &&
      verdict.summary &&
      verdict.issues.length === 0
    ) {
      const strategyTag = inferStrategy(verdict) || "general";
      results.push({
        agentType: "evaluator",
        content: formatPositivePattern(verdict.summary, strategyTag, goal),
        memType: "project",
        dedupKey: `eval_pass:${strategyTag}:${short(verdict.summary)}`,
        topic: `pass_pattern_${strategyTag}`,
      });
    }
    if (verdict.isFinalReview && verdict.issues.length > 0) {
      const majorIssues = verdict.issues.filter(
        (issue) => issue.severity === "major",
      );
      if (majorIssues.length > 0) {
        const strategyTag = inferStrategy(verdict, majorIssues) || "report";
        results.push({
          agentType: "evaluator",
          content: formatFinalMajorPattern(majorIssues, strategyTag, goal),
          memType: "feedback",
          dedupKey: `eval_final_major:${strategyTag}:${short(majorIssues.map((i) => i.description).join(";"))}`,
          topic: "final_major_open_issues",
        });
      }
    }
    return results;
  }

  // 拒绝：提取常见失败模式
  const actionableIssues = verdict.issues.filter(
    (issue) =>
      issue.severity === "blocker" ||
      issue.scope === "upstream" ||
      issue.scope === "systemic",
  );

  if (actionableIssues.length === 0) return results;

  // 按范围分组
  const byScope = new Map<string, Issue[]>();
  for (const issue of actionableIssues) {
    const scope = issue.scope || "unclassified";
    if (!byScope.has(scope)) {
      byScope.set(scope, []);
    }
    byScope.get(scope)!.push(issue);
  }

  for (const [scope, issues] of byScope) {
    const representative = issues.reduce((a, b) =>
      severityRank(a.severity) >= severityRank(b.severity) ? a : b,
    );
    const patternName = `${scope}_${representative.targetTaskType || "unknown"}_issue`;
    const strategy = inferStrategy(verdict, issues);

    results.push({
      agentType: "evaluator",
      content: formatNegativePattern(
        patternName,
        issues,
        scope,
        strategy,
        goal,
      ),
      memType: "feedback",
      dedupKey: `eval_fail:${scope}:${short(representative.description)}`,
      topic: `fail_pattern_${scope}`,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Coordinator → 路由规则
// ---------------------------------------------------------------------------

/**
 * 从 Coordinator 决策中提取路由规则。
 *
 * 仅持久化持久的编排经验（replan、save、finish、regenerate）。
 * 常规的 spawn/inspect/repair 决策过于频繁，不予持久化。
 */
export function extractCoordinatorDecision(
  action: RuntimeAction,
  stateSummary: Partial<{
    planReady: boolean;
    artifactCount: number;
    verdictStatus: string;
    pendingTasks: number;
  }> = {},
): MemoryWrite[] {
  if (!action.action) return [];

  // 仅持久化战略性决策
  const persistableActions = new Set([
    "replan",
    "save",
    "finish",
    "regenerate",
  ]);
  if (!persistableActions.has(action.action)) {
    // 允许 direct_diagrams spawn
    if (
      !(action.action === "spawn" && action.taskId === "direct_diagrams")
    ) {
      return [];
    }
  }

  const state = stateSummary;
  const planReady = state.planReady ?? "?";
  const artifactCount = state.artifactCount ?? "?";
  const verdictStatus = state.verdictStatus ?? "?";
  const pendingTasks = state.pendingTasks ?? "?";

  const condition = `plan_ready=${planReady}/artifacts=${artifactCount}/verdict=${verdictStatus}/pending=${pendingTasks}`;
  const ruleLine = `condition=${condition} → action=${action.action}`;

  const parts: string[] = [
    `## 路由规则: ${action.action}`,
    `**条件**: ${condition}`,
    `**动作**: ${action.action}`,
  ];
  if (action.taskId) {
    parts.push(`**目标任务**: ${action.taskId}`);
  }
  if (action.reason) {
    parts.push(`**原因**: ${action.reason}`);
  }
  parts.push(`**规则摘要**: \`${ruleLine}\``);

  return [
    {
      agentType: "coordinator",
      content: parts.join("\n"),
      memType: "project",
      dedupKey: `coord_route:${action.action}:${condition}`,
      topic: `routing_${action.action}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Generator → 经验教训
// ---------------------------------------------------------------------------

/**
 * 从 Generator 产物中提取经验教训。
 *
 * 策略：
 * - selfCheckPassed=false → 记录失败模式（feedback 类型）。
 * - selfCheckPassed=true 经过修正后 → 记录有效的修复策略（project 类型）。
 * - selfCheckPassed=true 无需修正 → 太琐碎，跳过。
 */
export function extractGeneratorLesson(
  artifact: Artifact,
  taskType = "",
): MemoryWrite[] {
  const results: MemoryWrite[] = [];
  const effectiveType = taskType || artifact.type || "unknown";

  // 自检失败：记录失败模式
  if (!artifact.selfCheckPassed) {
    const issuesText =
      artifact.selfCheckIssues.length > 0
        ? artifact.selfCheckIssues.join("; ")
        : "未通过自检（无详细原因）";

    results.push({
      agentType: "generator",
      content: formatFailureLesson(
        effectiveType,
        artifact.taskId,
        artifact.selfCheckIssues,
        artifact.selfCorrectRounds,
      ),
      memType: "feedback",
      dedupKey: `gen_fail:${effectiveType}:${short(issuesText)}`,
      topic: `gen_fail_${effectiveType}`,
    });
    return results;
  }

  // 自检经多轮修正后通过：记录修复策略
  if (artifact.selfCorrectRounds > 1) {
    results.push({
      agentType: "generator",
      content: formatCorrectionLesson(
        effectiveType,
        artifact.taskId,
        artifact.selfCorrectRounds,
        artifact.selfCheckIssues,
      ),
      memType: "project",
      dedupKey: `gen_fix:${effectiveType}:rounds=${artifact.selfCorrectRounds}`,
      topic: `gen_correction_${effectiveType}`,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// 内部格式化函数
// ---------------------------------------------------------------------------

function formatPositivePattern(
  summary: string,
  strategy: string,
  goal: string,
): string {
  const lines: string[] = [
    `## 模式: 通过验证`,
    `**策略判断**: ${strategy || "N/A"}`,
    `**经验**: ${summary}`,
  ];
  if (goal) {
    lines.push(`**目标**: ${goal}`);
  }
  return lines.join("\n");
}

function formatNegativePattern(
  patternName: string,
  issues: Issue[],
  scope: string,
  strategy: string,
  goal: string,
): string {
  const triggerParts: string[] = [];
  for (const issue of issues.slice(0, 5)) {
    triggerParts.push(
      `  - [${issue.severity}] ${issue.targetField}: ${issue.description}`,
    );
  }
  const triggerText =
    triggerParts.length > 0
      ? triggerParts.join("\n")
      : "(无详细触发条件)";

  const fixSuggestions: string[] = [];
  for (const issue of issues.slice(0, 5)) {
    if (issue.suggestion) {
      fixSuggestions.push(`  - ${issue.suggestion}`);
    }
  }
  const fixText =
    fixSuggestions.length > 0
      ? fixSuggestions.join("\n")
      : strategy || "无";

  const lines: string[] = [
    `## 模式: ${patternName}`,
    `**触发条件**:`,
    triggerText,
    `**建议动作**: ${fixText}`,
    `**经验**: scope=${scope}, inferred_strategy=${strategy || "N/A"}, 共 ${issues.length} 个问题`,
  ];
  if (goal) {
    lines.push(`**目标**: ${goal}`);
  }
  return lines.join("\n");
}

function formatFinalMajorPattern(
  issues: Issue[],
  strategy: string,
  goal: string,
): string {
  const targetTypes = [...new Set(
    issues.map((issue) => issue.targetTaskType || "unknown"),
  )].sort();
  const scopes = [...new Set(
    issues.map((issue) => issue.scope || "unknown"),
  )].sort();
  const examples = issues.slice(0, 5).map(
    (issue) => `  - [${issue.targetTaskId || "unknown"}] ${issue.targetField}: ${issue.description}`,
  );

  const lines: string[] = [
    "## 模式: final_review_major_open_issues",
    `**触发条件**: final review passed but still reported ${issues.length} major issue(s)`,
    `**涉及类型**: ${targetTypes.join(", ")}`,
    `**问题范围**: ${scopes.join(", ")}`,
    "**样例问题**:",
    ...examples,
    `**建议动作**: ${strategy === "patch" ? "only repair one local downstream artifact once; otherwise report/replan" : strategy}`,
    "**经验**: 带 major 的 passed final review 不应按全局 issue 数反复 repair；优先保守处理，避免上游和下游产物同时漂移。",
  ];
  if (goal) lines.push(`**目标**: ${goal}`);
  return lines.join("\n");
}

function formatFailureLesson(
  taskType: string,
  taskId: string,
  issues: string[],
  rounds: number,
): string {
  const lines: string[] = [
    `## 生成失败模式: ${taskType}`,
    `**任务类型**: ${taskType}`,
    `**任务 ID**: ${taskId}`,
    `**自检轮次**: ${rounds}`,
    `**失败原因**:`,
  ];
  if (issues.length > 0) {
    for (const issue of issues.slice(0, 5)) {
      lines.push(`  - ${issue}`);
    }
  } else {
    lines.push("  - (无详细原因)");
  }
  lines.push(
    `**教训**: ${taskType} 类型制品在自检中失败，需要关注上述问题模式。`,
  );
  return lines.join("\n");
}

function formatCorrectionLesson(
  taskType: string,
  taskId: string,
  rounds: number,
  issuesBefore: string[],
): string {
  const lines: string[] = [
    `## 修正策略有效: ${taskType}`,
    `**任务类型**: ${taskType}`,
    `**任务 ID**: ${taskId}`,
    `**修正轮次**: ${rounds}`,
    `**修正前的问题**:`,
  ];
  if (issuesBefore.length > 0) {
    for (const issue of issuesBefore.slice(0, 5)) {
      lines.push(`  - ${issue}`);
    }
  } else {
    lines.push("  - (无记录)");
  }
  lines.push(
    `**教训**: ${taskType} 类型制品经过 ${rounds} 轮自修正后通过自检。迭代修正策略对该类型问题有效。`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 策略推断
// ---------------------------------------------------------------------------

function inferStrategy(verdict: Verdict, issues?: Issue[]): string {
  const relevant = issues ?? verdict.issues;
  if (relevant.length === 0) return "";

  let systemicCount = 0;
  let upstreamCount = 0;
  const blockerTypes = new Set<string>();
  const blockerByTask = new Map<string, number>();

  for (const issue of relevant) {
    if (issue.scope === "systemic") systemicCount++;
    else if (issue.scope === "upstream") upstreamCount++;

    if (issue.severity === "blocker") {
      blockerTypes.add(issue.targetTaskType || "unknown");
      const tid = issue.targetTaskId || "unknown";
      blockerByTask.set(tid, (blockerByTask.get(tid) ?? 0) + 1);
    }
  }

  if (systemicCount > 0) return "replan";
  if (upstreamCount >= 2) return "replan";
  if (blockerTypes.size >= 3) return "replan";
  if ([...blockerByTask.values()].some((c) => c >= 3)) return "regenerate";
  return "patch";
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

function severityRank(severity: string): number {
  const ranks: Record<string, number> = { blocker: 3, major: 2, minor: 1 };
  return ranks[severity] ?? 0;
}

function short(text: string, maxLen = 40): string {
  return text
    .trim()
    .replace(/\n/g, " ")
    .replace(/ /g, "_")
    .slice(0, maxLen) || "_";
}
