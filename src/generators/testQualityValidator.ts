/**
 * TestQualityValidator — 程序化测试用例质量检查器。
 *
 * 检测模板化测试、缺失输入、模糊预期结果、错误目标、目标/内容不匹配等问题。
 */

import {
  evaluateTargetAlignment,
  collectConstraintSourceTexts,
  TARGET_ALIGNMENT_WARN_ONLY,
} from "../shared/testAlignment.js";

export interface QualityIssue {
  testId: string;
  issue: "template_like" | "missing_input" | "vague_expected" | "too_few_steps" | "wrong_target" | "target_content_alignment";
  severity: "reject" | "warning";
  detail: string;
}

/**
 * 对测试用例列表执行全量质量校验，返回所有问题。
 */
export function validateTestCases(
  cases: Array<Record<string, unknown>>,
  analysis: Record<string, unknown>,
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const knownIds = collectKnownIds(analysis);
  const constraintTexts = collectConstraintSourceTexts(analysis);

  for (const tc of cases) {
    const testId = String(tc.id ?? "unknown").trim();

    // Check 1: template-like
    if (isTemplateLike(tc)) {
      issues.push({
        testId,
        issue: "template_like",
        severity: "reject",
        detail: `测试用例 ${testId} 检测到模板化表述或步骤过少`,
      });
    }

    // Check 2: missing input / too few steps
    if (!Array.isArray(tc.steps) || tc.steps.length === 0) {
      issues.push({
        testId,
        issue: "too_few_steps",
        severity: "reject",
        detail: `测试用例 ${testId} 步骤数组为空或缺失`,
      });
    } else if (hasMissingInput(tc)) {
      issues.push({
        testId,
        issue: "missing_input",
        severity: "warning",
        detail: `测试用例 ${testId} 缺少具体输入数据`,
      });
    }

    // Check 3: vague expected result
    if (hasVagueExpected(tc)) {
      issues.push({
        testId,
        issue: "vague_expected",
        severity: "warning",
        detail: `测试用例 ${testId} 预期结果模糊`,
      });
    }

    // Check 4: wrong target (unknown IDs)
    if (hasWrongTarget(tc, knownIds)) {
      issues.push({
        testId,
        issue: "wrong_target",
        severity: "reject",
        detail: `测试用例 ${testId} 目标引用了未知 ID`,
      });
    }

    // Check 5: target-content alignment (valid ID, fabricated content)
    const alignment = evaluateTargetAlignment({
      target: String(tc.target ?? ""),
      content: [
        tc.title,
        ...(Array.isArray(tc.steps) ? tc.steps.map(String) : []),
        tc.expected_result ?? "",
      ].map((v) => String(v ?? "")).join(" "),
      constraintTexts,
    });
    if (alignment.misaligned && !alignment.allIdsUnknown) {
      issues.push({
        testId,
        issue: "target_content_alignment",
        // Warn-only by default until the overlap threshold is calibrated on
        // a real corpus; flip TARGET_ALIGNMENT_WARN_ONLY to hard-reject.
        severity: TARGET_ALIGNMENT_WARN_ONLY ? "warning" : "reject",
        detail: `测试用例 ${testId} 目标约束 ${alignment.matchedId ?? ""} 的内容与步骤/预期结果无重叠（overlap=${alignment.overlap.toFixed(2)}），疑似编造不相关规则`,
      });
    }
  }

  // Sort: reject first, then warning
  issues.sort((a, _b) => (a.severity === "reject" ? -1 : 1));
  return issues;
}

/**
 * 检测模板化测试用例。
 */
export function isTemplateLike(tc: Record<string, unknown>): boolean {
  const text = [
    tc.title,
    ...(Array.isArray(tc.steps) ? tc.steps.map(String) : []),
    tc.expected_result ?? "",
  ]
    .map((v) => String(v ?? ""))
    .join(" ");

  return (
    /违反\s*(C|CON_|约束)/i.test(text) ||
    /检查.*是否满足/.test(text) ||
    /尝试.*约束/.test(text) ||
    (Array.isArray(tc.steps) ? tc.steps.length : 0) < 2
  );
}

/**
 * 检测缺失具体输入。
 */
export function hasMissingInput(tc: Record<string, unknown>): boolean {
  const steps = Array.isArray(tc.steps) ? tc.steps.map(String) : [];
  if (steps.length === 0) return true;

  // If no step contains specific data patterns (numbers, quoted values, etc.)
  const text = steps.join(" ");
  const hasSpecificData =
    /\d+/.test(text) ||           // contains numbers
    /["'][^"']+["']/.test(text) || // contains quoted values
    /输入|填写|设置|选择/.test(text); // contains action verbs with data

  return !hasSpecificData;
}

/**
 * 检测模糊预期结果。
 */
export function hasVagueExpected(tc: Record<string, unknown>): boolean {
  const expected = String(tc.expected_result ?? "").trim();
  if (!expected) return true;

  const vaguePatterns = [
    /正常/,
    /成功$/,
    /符合预期/,
    /无误/,
    /正确$/,
    /通过$/,
    /^.{1,4}$/,  // too short (≤4 chars)
  ];

  return vaguePatterns.some((p) => p.test(expected));
}

/**
 * 检测错误目标引用。
 */
export function hasWrongTarget(
  tc: Record<string, unknown>,
  knownIds: Set<string>,
): boolean {
  const target = String(tc.target ?? "").trim();
  if (!target) return false; // empty target handled elsewhere

  // Extract all IDs from the target
  const idPattern = /\b(?:F\d{3,4}|C\d{3,4}|[EX]\d{3,4}|FUN_[A-Za-z0-9_]+|CON_[A-Za-z0-9_]+|EXC_[A-Za-z0-9_]+)\b/g;
  const matches = target.match(idPattern);
  if (!matches || matches.length === 0) return false;

  // If ALL referenced IDs are unknown, it's wrong
  return matches.every((id) => !knownIds.has(id));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectKnownIds(analysis: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const kind of ["functions", "constraints", "exceptions"]) {
    const items = analysis[kind];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const displayId = String(rec.displayId ?? "").trim();
      const id = String(rec.id ?? "").trim();
      if (displayId) ids.add(displayId);
      if (id) ids.add(id);
    }
  }
  return ids;
}
